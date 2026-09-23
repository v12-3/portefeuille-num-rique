/**
 * Client Firebase partagé par le dashboard (/) et l'app mobile (/m/).
 *
 * Architecture 100 % gratuite (Firebase forfait Spark, sans carte) :
 *  - Auth Firebase : e-mail/mot de passe + Google.
 *  - Firestore : stocke le portefeuille brut (users/{uid}/portfolio/main),
 *    les réglages (users/{uid}/portfolio/settings) et l'historique
 *    (users/{uid}/history/*). Les règles Firestore limitent chacun à son uid.
 *  - Valorisation : calculée DANS le navigateur (window.PatrimoineCore, voir
 *    app-core.js) au lieu d'une Cloud Function — c'est ce qui permet de rester
 *    sur le forfait gratuit.
 *  - Cotations : récupérées via un Cloudflare Worker (window.QUOTES_WORKER_URL),
 *    car un navigateur ne peut pas appeler Yahoo directement (CORS). Sans URL
 *    de Worker, l'app fonctionne avec les derniers cours connus.
 *
 * Robustesse :
 *  - l'état d'auth n'est annoncé qu'une fois connu (pas d'écran de connexion
 *    qui clignote au démarrage d'une session déjà ouverte) ;
 *  - Google passe par une fenêtre, avec repli automatique sur une redirection
 *    quand la fenêtre est bloquée (app installée, bloqueur de pop-up) ;
 *  - toutes les écritures passent par une file unique : deux actions rapides
 *    ne s'écrasent plus, et un échec restaure l'état précédent ;
 *  - une écriture hors ligne ne bloque pas l'interface : elle est gardée en
 *    local et synchronisée au retour du réseau ;
 *  - les erreurs Firebase sont traduites en messages compréhensibles.
 *
 * Expose window.PatrimoineAuth / window.PatrimoineData, puis émet
 * `patrimoine:ready` (ou `patrimoine:failed` si le démarrage échoue).
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signInWithPopup, signInWithRedirect, getRedirectResult, GoogleAuthProvider,
  signOut as fbSignOut, sendPasswordResetEmail, setPersistence, browserLocalPersistence
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager, memoryLocalCache,
  doc, setDoc, getDoc, collection, query, orderBy, onSnapshot, terminate, clearIndexedDbPersistence
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

const fail = message => {
  console.error('[patrimoine]', message);
  window.PatrimoineBootError = message;
  window.dispatchEvent(new CustomEvent('patrimoine:failed', { detail: message }));
};

const cfg = window.FIREBASE_CONFIG;
const Core = window.PatrimoineCore;
const WORKER_URL = String(window.QUOTES_WORKER_URL || '').replace(/\/+$/, '');

if (!cfg || !cfg.apiKey || cfg.apiKey === 'REMPLACE-MOI') {
  fail("Configuration Firebase absente : renseigne public/firebase-config.js (voir README-FIREBASE.md).");
} else if (!Core) {
  fail('Le moteur de calcul (app-core.js) ne s\'est pas chargé. Recharge la page.');
} else {
  try { start(); }
  catch (e) { fail('Démarrage impossible : ' + (e?.message || e)); }
}

function start() {
  const app = initializeApp(cfg);
  const auth = getAuth(app);
  auth.languageCode = 'fr';                         // e-mails et fenêtre Google en français

  // Cache Firestore persistant partagé entre onglets ; repli mémoire si le
  // navigateur le refuse (navigation privée, stockage bloqué).
  let db;
  try {
    db = initializeFirestore(app, {
      ignoreUndefinedProperties: true,              // un champ `undefined` faisait échouer toute l'écriture
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
    });
  } catch (e) {
    console.warn('[firestore] cache persistant indisponible, repli mémoire :', e.message);
    db = initializeFirestore(app, { ignoreUndefinedProperties: true, localCache: memoryLocalCache() });
  }

  setPersistence(auth, browserLocalPersistence).catch(e => console.warn('[auth] persistance indisponible :', e.message));

  if (!WORKER_URL) console.warn('[quotes] QUOTES_WORKER_URL non renseigné — derniers cours connus utilisés.');

  /* ============================================================
     Erreurs → messages lisibles
     ============================================================ */
  const AUTH_ERRORS = {
    'auth/invalid-email': 'Adresse e-mail invalide.',
    'auth/missing-email': 'Renseigne ton adresse e-mail.',
    'auth/missing-password': 'Renseigne ton mot de passe.',
    'auth/user-disabled': 'Ce compte a été désactivé.',
    'auth/user-not-found': 'Adresse e-mail ou mot de passe incorrect.',
    'auth/wrong-password': 'Adresse e-mail ou mot de passe incorrect.',
    'auth/invalid-credential': 'Adresse e-mail ou mot de passe incorrect.',
    'auth/invalid-login-credentials': 'Adresse e-mail ou mot de passe incorrect.',
    'auth/email-already-in-use': 'Un compte existe déjà avec cette adresse. Connecte-toi, ou utilise « Mot de passe oublié ».',
    'auth/weak-password': 'Mot de passe trop faible : 6 caractères minimum.',
    'auth/password-does-not-meet-requirements': 'Mot de passe trop faible : ajoute des chiffres, majuscules ou symboles.',
    'auth/too-many-requests': 'Trop de tentatives. Patiente quelques minutes, ou réinitialise ton mot de passe.',
    'auth/network-request-failed': 'Pas de connexion au serveur. Vérifie ta connexion internet puis réessaie.',
    'auth/popup-blocked': 'La fenêtre Google a été bloquée par le navigateur.',
    'auth/unauthorized-domain': "Ce site n'est pas autorisé pour la connexion (Console Firebase → Authentication → Paramètres → Domaines autorisés).",
    'auth/operation-not-allowed': 'Cette méthode de connexion n\'est pas activée (Console Firebase → Authentication → Sign-in method).',
    'auth/configuration-not-found': 'Cette méthode de connexion n\'est pas activée (Console Firebase → Authentication → Sign-in method).',
    'auth/invalid-api-key': 'Configuration Firebase invalide (public/firebase-config.js).',
    'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'Configuration Firebase invalide (public/firebase-config.js).',
    'auth/account-exists-with-different-credential': 'Un compte existe déjà avec cette adresse : connecte-toi avec ton mot de passe.',
    'auth/web-storage-unsupported': 'Ton navigateur bloque le stockage local (navigation privée ?). Autorise les cookies pour ce site.',
    'auth/internal-error': 'Erreur temporaire du service de connexion. Réessaie dans un instant.',
    'auth/timeout': 'Le serveur met trop de temps à répondre. Réessaie.',
    'auth/user-token-expired': 'Session expirée : reconnecte-toi.',
    'auth/requires-recent-login': 'Par sécurité, reconnecte-toi avant cette action.',
    'auth/quota-exceeded': 'Limite de connexions atteinte pour aujourd\'hui. Réessaie plus tard.'
  };
  const authError = e => {
    const msg = AUTH_ERRORS[e?.code];
    const err = new Error(msg || `Connexion impossible${e?.code ? ` (${e.code.replace('auth/', '')})` : ''}. Réessaie.`);
    err.code = e?.code;
    return err;
  };

  const DATA_ERRORS = {
    'permission-denied': 'Accès refusé à tes données. Déconnecte-toi puis reconnecte-toi.',
    'unauthenticated': 'Session expirée : reconnecte-toi.',
    'unavailable': 'Serveur injoignable. Vérifie ta connexion internet.',
    'deadline-exceeded': 'Le serveur met trop de temps à répondre. Réessaie.',
    'resource-exhausted': 'Quota gratuit Firebase atteint pour aujourd\'hui. Réessaie demain.',
    'failed-precondition': 'Données momentanément indisponibles. Recharge la page.'
  };
  const dataError = e => {
    if (e?.userMessage) return e;
    const raw = String(e?.message || '');
    let msg = DATA_ERRORS[e?.code];
    if (!msg && /exceeds the maximum allowed size|maximum.*size|too large/i.test(raw)) {
      msg = 'Données trop volumineuses (limite gratuite de 1 Mo par portefeuille). Supprime d\'anciennes opérations ou importe un fichier plus court.';
    }
    const err = new Error(msg || raw || 'Erreur inattendue.');
    err.code = e?.code; err.userMessage = true;
    return err;
  };

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  function checkCredentials(email, password, { signup } = {}) {
    if (!email) throw new Error('Renseigne ton adresse e-mail.');
    if (!EMAIL_RE.test(email)) throw new Error('Adresse e-mail invalide.');
    if (!password) throw new Error('Renseigne ton mot de passe.');
    if (signup && password.length < 6) throw new Error('Mot de passe trop court : 6 caractères minimum.');
  }
  const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

  /* ============================================================
     Authentification
     ============================================================ */
  const authListeners = new Set();
  let currentUser = null;
  let authKnown = false;                            // l'état d'auth initial est-il connu ?
  let redirectError = null;                         // erreur d'un retour de redirection Google

  onAuthStateChanged(auth, user => {
    currentUser = user;
    authKnown = true;
    authListeners.forEach(cb => { try { cb(user); } catch (e) { console.error(e); } });
  }, e => console.error('[auth]', e));

  // retour d'une connexion Google par redirection : récupère l'erreur éventuelle
  getRedirectResult(auth).catch(e => {
    if (e?.code && e.code !== 'auth/no-auth-event') redirectError = authError(e).message;
  });

  async function googleSignIn() {
    if (offline()) throw new Error('Pas de connexion internet.');
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    try {
      await signInWithPopup(auth, provider);
      return { ok: true };
    } catch (e) {
      // fenêtre fermée par l'utilisateur : pas une erreur à afficher
      if (e?.code === 'auth/popup-closed-by-user' || e?.code === 'auth/cancelled-popup-request' || e?.code === 'auth/user-cancelled') {
        return { cancelled: true };
      }
      // fenêtre impossible (bloqueur, app installée…) : on bascule en redirection
      if (e?.code === 'auth/popup-blocked' || e?.code === 'auth/operation-not-supported-in-this-environment') {
        await signInWithRedirect(auth, provider);
        return { redirecting: true };
      }
      throw authError(e);
    }
  }

  window.PatrimoineAuth = {
    /** Appelle cb(user|null) dès que l'état est connu, puis à chaque changement. */
    onUser(cb) {
      authListeners.add(cb);
      if (authKnown) cb(currentUser);
      return () => authListeners.delete(cb);
    },
    get user() { return currentUser; },
    get known() { return authKnown; },
    async signIn(email, password) {
      email = String(email || '').trim();
      checkCredentials(email, password);
      if (offline()) throw new Error('Pas de connexion internet.');
      try { await signInWithEmailAndPassword(auth, email, password); } catch (e) { throw authError(e); }
    },
    async signUp(email, password) {
      email = String(email || '').trim();
      checkCredentials(email, password, { signup: true });
      if (offline()) throw new Error('Pas de connexion internet.');
      try { await createUserWithEmailAndPassword(auth, email, password); } catch (e) { throw authError(e); }
    },
    signInGoogle: googleSignIn,
    async resetPassword(email) {
      email = String(email || '').trim();
      if (!email) throw new Error('Renseigne d\'abord ton adresse e-mail dans le champ ci-dessus.');
      if (!EMAIL_RE.test(email)) throw new Error('Adresse e-mail invalide.');
      if (offline()) throw new Error('Pas de connexion internet.');
      try { await sendPasswordResetEmail(auth, email); }
      catch (e) {
        // ne révèle pas si l'adresse a un compte (protection contre l'énumération)
        if (e?.code !== 'auth/user-not-found') throw authError(e);
      }
    },
    /** Erreur survenue lors d'un retour de redirection Google (lue une seule fois). */
    takeRedirectError() { const e = redirectError; redirectError = null; return e; },
    /**
     * Déconnexion complète : coupe les écoutes, efface le cache local des
     * données (appareil partagé en famille) et recharge une page propre.
     */
    async signOut() {
      stopListening();
      try { await fbSignOut(auth); } catch (e) { console.warn('[auth] signOut :', e.message); }
      try { await terminate(db); await clearIndexedDbPersistence(db); } catch { /* autre onglet ouvert : cache conservé */ }
      location.reload();
    }
  };

  /* ============================================================
     Données — Firestore (brut) + valorisation client + Worker (cotations)
     ============================================================ */
  let uid = null;
  let unsubPortfolio = null, unsubHistory = null, unsubSettings = null;
  let rawPortfolio = null, history = [], lastSnapshot = null;
  let refreshing = false, lastError = null;
  const dataListeners = new Set();
  const errorListeners = new Set();

  /** Aucune valeur par défaut inventée : tant que rien n'est saisi, l'UI le dit. */
  let settings = { monthlyExpenses: null, goal: null };

  const mainRef = () => doc(db, 'users', uid, 'portfolio', 'main');
  const settingsRef = () => doc(db, 'users', uid, 'portfolio', 'settings');
  const historyCol = () => collection(db, 'users', uid, 'history');

  function emit() {
    const payload = lastSnapshot ? { ...lastSnapshot, history, settings } : null;
    dataListeners.forEach(cb => { try { cb(payload); } catch (e) { console.error('[render]', e); } });
  }
  function emitError(e) {
    lastError = dataError(e).message;
    errorListeners.forEach(cb => { try { cb(lastError); } catch (err) { console.error(err); } });
  }

  function stopListening() {
    unsubPortfolio?.(); unsubHistory?.(); unsubSettings?.();
    unsubPortfolio = unsubHistory = unsubSettings = null;
    rawPortfolio = null; history = []; lastSnapshot = null; uid = null; lastError = null;
    settings = { monthlyExpenses: null, goal: null };
    quoteCache.clear();
  }

  function startListening(user) {
    stopListening();
    uid = user.uid;
    const mine = uid;                               // ignore les réponses d'une session précédente

    unsubSettings = onSnapshot(settingsRef(), s => {
      if (uid !== mine) return;
      const d = s.exists() ? s.data() : {};
      settings = { monthlyExpenses: d.monthlyExpenses ?? null, goal: d.goal ?? null };
      if (lastSnapshot) emit();
    }, err => console.warn('[firestore] réglages :', err.message));

    unsubHistory = onSnapshot(query(historyCol(), orderBy('date')), qs => {
      if (uid !== mine) return;
      history = qs.docs.map(d => d.data());
      if (lastSnapshot) emit();
    }, err => console.warn('[firestore] historique :', err.message));

    unsubPortfolio = onSnapshot(mainRef(), snap => {
      if (uid !== mine) return;
      // une écriture en cours de sauvegarde est déjà dans rawPortfolio
      if (writing && snap.metadata.hasPendingWrites) return;
      rawPortfolio = normalize(snap.exists() ? snap.data() : null);
      lastError = null;
      revalue();
      recompute(true).catch(e => console.warn('[quotes]', e.message));
    }, err => {
      if (uid !== mine) return;
      console.error('[firestore] portefeuille :', err.code, err.message);
      emitError(err);
    });
  }

  function normalize(data) {
    const d = data || {};
    const arr = v => Array.isArray(v) ? v : [];
    const obj = v => (v && typeof v === 'object' && !Array.isArray(v)) ? v : {};
    return {
      meta: { imports: arr(d.meta?.imports), ...(d.meta?.updatedAt ? { updatedAt: d.meta.updatedAt } : {}) },
      balances: obj(d.balances),
      cash: obj(d.cash),
      positions: arr(d.positions),
      operations: arr(d.operations).filter(o => o && o.date)
    };
  }

  /** Valorisation immédiate au dernier cours connu (+ cotations en cache). */
  function revalue() {
    if (!rawPortfolio) return null;
    lastSnapshot = Core.value(rawPortfolio, quoteCache.map());
    emit();
    return lastSnapshot;
  }

  /* ---------- cotations ---------- */
  const QUOTE_TTL = 60_000;
  const quoteCache = {
    store: new Map(),                               // key → { q, at }
    map() { return new Map([...this.store].map(([k, v]) => [k, v.q])); },
    fresh(key) { const e = this.store.get(key); return e && Date.now() - e.at < QUOTE_TTL; },
    put(map) { const now = Date.now(); for (const [k, q] of map) this.store.set(k, { q, at: now }); },
    clear() { this.store.clear(); }
  };

  /** Cotations depuis le Worker. Délai borné : jamais de blocage de l'interface. */
  async function fetchQuotes(positions, force) {
    if (!WORKER_URL || offline()) return new Map();
    const req = Core.quoteRequest(positions).filter(r => force || !quoteCache.fresh(r.key));
    if (!req.length) return new Map();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    try {
      const res = await fetch(WORKER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req.slice(0, 200)),
        signal: ctrl.signal
      });
      if (!res.ok) throw new Error(`service de cotations indisponible (HTTP ${res.status})`);
      const json = await res.json();
      return new Map(Object.entries(json && typeof json === 'object' ? json : {}));
    } catch (e) {
      throw new Error(e?.name === 'AbortError' ? 'service de cotations trop lent' : (e?.message || 'cotations indisponibles'));
    } finally {
      clearTimeout(timer);
    }
  }

  let recomputing = null;
  /** Revalorise ; live=true interroge le Worker (seulement les cours périmés sauf force). */
  async function recompute(live, force = false) {
    if (!rawPortfolio) return null;
    if (!live || !WORKER_URL) return revalue();
    if (recomputing && !force) return recomputing;  // un seul appel réseau à la fois
    const mine = uid;
    recomputing = (async () => {
      refreshing = true;
      try {
        const toQuote = [...rawPortfolio.positions, ...Core.deriveFromOperations(rawPortfolio).positions];
        const fresh = await fetchQuotes(toQuote, force);
        if (uid !== mine) return null;
        quoteCache.put(fresh);
        revalue();
        if (fresh.size) {
          await persistResolvedSymbols(fresh);
          await writeHistoryPoint(lastSnapshot);
        }
        return lastSnapshot;
      } finally {
        refreshing = false;
        recomputing = null;
      }
    })();
    return recomputing;
  }

  /** Un symbole résolu par le Worker est mémorisé pour ne plus le redeviner. */
  async function persistResolvedSymbols(quoteMap) {
    const updates = [];
    for (const p of rawPortfolio.positions) {
      if (p.symbol) continue;
      const q = quoteMap.get(Core.keyOf(p));
      if (q?.symbol && (q.confidence === 'libellé' || q.confidence === 'cours')) updates.push([p, q.symbol]);
    }
    if (!updates.length) return;
    await mutate(() => { updates.forEach(([p, s]) => { p.symbol = s; }); }, { quiet: true }).catch(e => console.warn('[firestore] symboles :', e.message));
  }

  let lastHistoryKey = '';
  async function writeHistoryPoint(snapshot) {
    if (!snapshot || !uid) return;
    const today = snapshot.asOf.slice(0, 10);
    const key = `${today}|${snapshot.totals.patrimoine}|${snapshot.totals.capital}`;
    if (key === lastHistoryKey) return;             // rien de neuf : pas d'écriture inutile
    lastHistoryKey = key;
    const comptes = {};
    for (const [name, c] of Object.entries(snapshot.comptes)) comptes[name] = { value: c.value, mise: c.mise };
    try {
      await withTimeout(setDoc(doc(historyCol(), today), { date: today, val: snapshot.totals.patrimoine, cap: snapshot.totals.capital, comptes }), 10000);
    } catch (e) { console.warn('[firestore] historique :', e.message); }
  }

  /* ---------- écritures : file unique, restauration en cas d'échec ---------- */
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  /** Hors ligne, setDoc ne se résout qu'au retour du réseau : on n'attend pas indéfiniment. */
  async function withTimeout(promise, ms) {
    const r = await Promise.race([promise.then(() => 'ok'), sleep(ms).then(() => 'pending')]);
    if (r === 'pending') promise.catch(e => { console.error('[firestore] synchronisation :', e); emitError(e); });
    return r;
  }

  function requireUser() {
    if (!uid) throw dataError({ code: 'unauthenticated' });
  }

  async function ensureLoaded() {
    requireUser();
    if (rawPortfolio) return;
    const snap = await getDoc(mainRef());
    rawPortfolio = normalize(snap.exists() ? snap.data() : null);
  }

  let queue = Promise.resolve();
  let writing = false;
  /**
   * Applique une modification au portefeuille puis l'enregistre.
   * Les modifications sont exécutées l'une après l'autre ; si l'enregistrement
   * échoue, le portefeuille revient exactement à son état précédent.
   * @returns {Promise<{result, pending:boolean, snapshot}>}
   */
  function mutate(fn, { quiet = false } = {}) {
    const run = queue.then(async () => {
      try { await ensureLoaded(); } catch (e) { throw dataError(e); }
      const backup = structuredClone(rawPortfolio);
      let result;
      try {
        result = await fn(rawPortfolio);
        rawPortfolio.meta.updatedAt = new Date().toISOString().slice(0, 10);
        writing = true;
        const state = await withTimeout(setDoc(mainRef(), rawPortfolio), 10000);
        if (!quiet) revalue();
        return { result, pending: state === 'pending', snapshot: lastSnapshot };
      } catch (e) {
        rawPortfolio = backup;
        revalue();
        throw e.userMessage || !e.code ? e : dataError(e);
      } finally {
        writing = false;
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  const MAX_FILE = 10 * 1024 * 1024;

  async function importFile(file) {
    if (!file) throw new Error('Aucun fichier sélectionné.');
    if (file.size > MAX_FILE) throw new Error(`Fichier trop lourd (${(file.size / 1048576).toFixed(1)} Mo) : 10 Mo maximum.`);
    if (!file.size) throw new Error('Le fichier est vide.');
    const u8 = new Uint8Array(await file.arrayBuffer());
    const parsed = await Core.parseFile(u8, file.name, {});   // erreurs de format : messages déjà lisibles

    const out = await mutate(p => {
      const report = { file: file.name, kind: parsed.kind, sourceRows: parsed.sourceRows, skipped: parsed.skipped };
      if (parsed.kind === 'operations') Object.assign(report, Core.mergeOperations(p, parsed.operations));
      else Object.assign(report, Core.mergePositions(p, parsed.positions));
      p.meta.imports.push({ file: String(file.name).slice(0, 120), at: new Date().toISOString(), kind: parsed.kind, rows: parsed.operations.length + parsed.positions.length, ok: true });
      p.meta.imports = p.meta.imports.slice(-50);
      return report;
    });
    recompute(true).catch(() => {});                // cotations en arrière-plan, sans bloquer
    return { ok: true, report: out.result, pending: out.pending, snapshot: out.snapshot };
  }

  async function updateBalance(compte, value, taux) {
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0) throw new Error('Montant invalide.');
    const t = taux == null || taux === '' ? null : Number(taux);
    if (t != null && (!Number.isFinite(t) || t < 0 || t > 20)) throw new Error('Taux invalide (entre 0 et 20 %).');
    const out = await mutate(p => {
      p.balances[compte] = { value: Core.round2(v), taux: t ?? p.balances[compte]?.taux ?? null, updatedAt: new Date().toISOString().slice(0, 10) };
    });
    return out.snapshot;
  }

  /** Supprime le solde d'une enveloppe (livret fermé, saisie erronée). */
  async function removeBalance(compte) {
    return (await mutate(p => {
      if (!(compte in p.balances)) throw new Error(`Aucun solde enregistré pour ${compte}.`);
      delete p.balances[compte];
    })).snapshot;
  }

  /* ---------- saisie manuelle des lignes ---------- */
  const posId = p => (p.isin || p.ticker || p.name || '').toUpperCase() + '|' + (p.compte || '');
  const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/i;

  /**
   * Ajoute ou remplace une ligne saisie à la main. Un seul champ « nom ou
   * ISIN » : un code ISIN est reconnu comme tel, un ticker court en majuscules
   * (SU, AI…) sert d'identifiant de cotation, sinon c'est un libellé.
   */
  async function savePosition(pos) {
    const raw = String(pos.nameOrIsin ?? pos.name ?? '').trim().slice(0, 120);
    const compact = raw.replace(/\s/g, '');
    const isIsin = ISIN_RE.test(compact);
    const looksTicker = !isIsin && /^[A-Z0-9.\-]{1,8}$/.test(raw) && raw === raw.toUpperCase();

    const clean = {
      compte: String(pos.compte || '').trim().slice(0, 40) || 'PEA',
      name: String(pos.name || (isIsin && pos.replaces ? pos.replaces : raw)).trim().slice(0, 120),
      ticker: String(pos.ticker || (looksTicker ? raw : '')).trim().toUpperCase(),
      isin: String(pos.isin || (isIsin ? compact : '')).trim().toUpperCase(),
      qty: Number(pos.qty),
      pru: Number(pos.pru),
      cat: String(pos.cat || '').trim().slice(0, 60)
    };
    if (!clean.name) throw new Error('Indique le nom ou le code ISIN de la ligne.');
    if (!Number.isFinite(clean.qty) || clean.qty <= 0) throw new Error('Quantité invalide : indique un nombre supérieur à 0.');
    if (!Number.isFinite(clean.pru) || clean.pru < 0) throw new Error('Prix d\'achat invalide.');
    const price = Number(pos.price);
    clean.price = Number.isFinite(price) && price > 0 ? price : clean.pru;
    if (pos.symbol) clean.symbol = String(pos.symbol).trim().toUpperCase();
    if (pos.manual) clean.manual = true;

    const buyDate = pos.date ? Core.date(pos.date) : null;
    if (pos.date && !buyDate) throw new Error('Date d\'achat invalide.');
    if (buyDate && buyDate > new Date().toISOString().slice(0, 10)) throw new Error('La date d\'achat ne peut pas être dans le futur.');

    const out = await mutate(p => {
      // Modification d'une ligne qui a déjà un historique d'achats : on ne crée
      // pas un second achat (il retirerait deux fois l'argent des liquidités),
      // l'historique existant reste la référence des mouvements d'argent.
      const hasHistory = !!pos.replaces && p.operations.some(positionOps(p, pos.replaces, clean.compte));
      // remplacement : l'ancienne clé peut différer (libellé corrigé lors d'une modification)
      const prevKey = pos.replaces ? String(pos.replaces).toUpperCase() + '|' + clean.compte : null;
      const idx = p.positions.findIndex(x => posId(x) === posId(clean) || (prevKey && posId(x) === prevKey));
      const created = idx < 0;
      if (created) p.positions.push({ ...clean, source: 'saisie', addedAt: new Date().toISOString().slice(0, 10) });
      else p.positions[idx] = { ...p.positions[idx], ...clean };

      // la date d'achat alimente le journal (historique, ancienneté fiscale)
      if (buyDate && !hasHistory) {
        Core.mergeOperations(p, [{
          date: buyDate, compte: clean.compte, type: 'Achat',
          libelle: clean.name, ticker: clean.ticker, isin: clean.isin,
          montant: -Math.abs(Core.round2(clean.qty * clean.pru)),
          qty: clean.qty, price: clean.pru
        }]);
      }
      return { created, name: clean.name };
    });
    recompute(true).catch(() => {});
    return { ok: true, ...out.result, pending: out.pending, snapshot: out.snapshot };
  }

  /** Opérations d'achat/vente rattachées à une ligne (pour la suppression). */
  function positionOps(p, name, compte) {
    const target = p.positions.find(x => x.name === name && (!compte || x.compte === compte));
    const ids = new Set([target?.isin, target?.ticker, name].filter(Boolean).map(s => String(s).toUpperCase()));
    const upName = String(name).toUpperCase();
    return o => (!compte || o.compte === compte) && (o.type === 'Achat' || o.type === 'Vente') &&
      (ids.has(String(o.ticker || o.isin || o.libelle || '').toUpperCase()) || String(o.libelle || '').toUpperCase() === upName ||
       (o.isin && ids.has(String(o.isin).toUpperCase())) || (o.ticker && ids.has(String(o.ticker).toUpperCase())));
  }

  /**
   * Supprime une ligne, qu'elle soit saisie/importée ou reconstruite depuis les
   * opérations (dans ce cas ses achats/ventes sont retirés, sinon elle
   * réapparaîtrait au prochain calcul ; versements et dividendes sont gardés).
   */
  async function removePosition(name, compte) {
    const out = await mutate(p => {
      const isOp = positionOps(p, name, compte);
      const before = p.positions.length, opsBefore = p.operations.length;
      p.positions = p.positions.filter(x => !(x.name === name && (!compte || x.compte === compte)));
      p.operations = p.operations.filter(o => !isOp(o));
      const removedExplicit = before - p.positions.length, removedOps = opsBefore - p.operations.length;
      if (!removedExplicit && !removedOps) throw new Error(`Ligne « ${name} » introuvable (déjà supprimée ?).`);
      return { removedExplicit, removedOps };
    });
    return { ok: true, ...out.result, snapshot: out.snapshot };
  }

  function countPositionOperations(name, compte) {
    if (!rawPortfolio) return 0;
    return rawPortfolio.operations.filter(positionOps(rawPortfolio, name, compte)).length;
  }

  /**
   * Fixe les liquidités d'une enveloppe. Une valeur explicite prend le dessus
   * sur celle déduite des opérations (corriger une trésorerie qu'on ne
   * reconnaît pas).
   */
  async function setCash(compte, value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) throw new Error('Montant de liquidités invalide.');
    return (await mutate(p => { p.cash[compte] = Core.round2(n); })).snapshot;
  }

  /** Retire le montant fixé à la main : les liquidités redeviennent calculées. */
  async function clearCash(compte) {
    return (await mutate(p => { delete p.cash[compte]; })).snapshot;
  }

  /** Supprime UNE opération du journal (la première identique trouvée). */
  async function removeOperation(op) {
    const key = Core.opKey(op);
    return (await mutate(p => {
      const i = p.operations.findIndex(o => Core.opKey(o) === key);
      if (i < 0) throw new Error('Opération introuvable (déjà supprimée ?).');
      p.operations.splice(i, 1);
    })).snapshot;
  }

  const OP_TYPES = ['Versement', 'Retrait', 'Achat', 'Vente', 'Dividende', 'Ouverture'];
  /** Ajoute une opération saisie à la main (versement, dividende, achat…). */
  async function addOperation(op) {
    const clean = {
      date: Core.date(op.date) || new Date().toISOString().slice(0, 10),
      compte: String(op.compte || '').trim().slice(0, 40) || 'PEA',
      type: OP_TYPES.includes(op.type) ? op.type : 'Versement',
      libelle: String(op.libelle || '').trim().slice(0, 120),
      ticker: String(op.ticker || '').trim().toUpperCase().slice(0, 12),
      isin: '',
      montant: Number(op.montant),
      qty: null, price: null
    };
    if (!Number.isFinite(clean.montant) || clean.montant === 0) throw new Error('Montant invalide.');
    // sens porté par le type : un montant saisi en positif reste juste
    clean.montant = Core.round2((clean.type === 'Achat' || clean.type === 'Retrait') ? -Math.abs(clean.montant) : Math.abs(clean.montant));
    if (!clean.libelle) clean.libelle = clean.type;
    return (await mutate(p => {
      const merged = Core.mergeOperations(p, [clean]);
      if (!merged.added) throw new Error('Cette opération existe déjà (même date, enveloppe, type, libellé et montant).');
    })).snapshot;
  }

  async function pinSymbol(match, symbol, manual) {
    const needle = String(match).toUpperCase();
    const out = await mutate(p => {
      const hits = p.positions.filter(x =>
        (x.isin || '').toUpperCase() === needle || (x.ticker || '').toUpperCase() === needle || (x.name || '').toUpperCase() === needle);
      if (!hits.length) throw new Error(`Aucune ligne ne correspond à « ${match} ».`);
      for (const h of hits) { if (manual) { h.manual = true; delete h.symbol; } else { h.symbol = symbol; delete h.manual; } }
      return hits.map(h => h.name);
    });
    const snapshot = await recompute(true, true).catch(() => lastSnapshot);
    return { ok: true, updated: out.result, snapshot };
  }

  async function saveSettings(patch) {
    requireUser();
    const clean = {};
    for (const k of ['monthlyExpenses', 'goal']) {
      if (patch[k] === null) clean[k] = null;
      else if (patch[k] !== undefined) {
        const n = Number(patch[k]);
        if (!Number.isFinite(n) || n < 0 || n > 1e10) throw new Error('Valeur invalide.');
        clean[k] = n;
      }
    }
    const prev = settings;
    settings = { ...settings, ...clean };
    emit();
    try { await withTimeout(setDoc(settingsRef(), settings, { merge: true }), 10000); }
    catch (e) { settings = prev; emit(); throw dataError(e); }
    return settings;
  }

  window.PatrimoineAuth.onUser(user => { if (user) startListening(user); else stopListening(); });

  window.PatrimoineData = {
    /** cb(instantané) à chaque changement ; onError(message) si la lecture échoue. */
    onSnapshot(cb, onError) {
      dataListeners.add(cb);
      if (onError) errorListeners.add(onError);
      if (lastSnapshot) cb({ ...lastSnapshot, history, settings });
      else if (lastError && onError) onError(lastError);
      return () => { dataListeners.delete(cb); if (onError) errorListeners.delete(onError); };
    },
    /** Relance l'écoute (bouton « Réessayer »). */
    retry() { if (currentUser) startListening(currentUser); },
    importFile,
    /** live : interroge le service de cotations ; force : même si les cours sont récents. */
    async refreshPerf(live = true, force = live) { return recompute(live, force); },
    updateBalance, removeBalance,
    pinSymbol, savePosition, removePosition, countPositionOperations,
    setCash, clearCash, removeOperation, addOperation,
    saveSettings,
    get settings() { return settings; },
    get portfolio() { return rawPortfolio; },
    get refreshing() { return refreshing; },
    get lastError() { return lastError; },
    get liveQuotes() { return !!WORKER_URL; }
  };

  window.PatrimoineBootError = null;
  // Les modules ES sont différés : ce signal réveille le script de rendu classique.
  window.dispatchEvent(new Event('patrimoine:ready'));
}
