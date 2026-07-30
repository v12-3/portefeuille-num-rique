/**
 * Client Firebase partagé par le dashboard (/) et l'app mobile (/m/).
 *
 * Architecture 100 % gratuite (Firebase forfait Spark, sans carte) :
 *  - Auth Firebase : e-mail/mot de passe + Google.
 *  - Firestore : stocke le portefeuille brut (users/{uid}/portfolio/main) et
 *    l'historique (users/{uid}/history/*). Le client lit ET écrit ses propres
 *    documents (les règles Firestore limitent chacun à son uid).
 *  - Valorisation : calculée DANS le navigateur (window.PatrimoineCore, voir
 *    app-core.js) au lieu d'une Cloud Function — c'est ce qui permet de rester
 *    sur le forfait gratuit.
 *  - Cotations : récupérées via un Cloudflare Worker (window.QUOTES_WORKER_URL),
 *    car un navigateur ne peut pas appeler Yahoo directement (CORS). Sans URL
 *    de Worker configurée, l'app fonctionne quand même avec les derniers cours
 *    connus (stockés dans le portefeuille), simplement sans rafraîchissement.
 *
 * Expose window.PatrimoineAuth / window.PatrimoineData pour le code de rendu
 * (script classique dans index.html et m/index.html).
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signInWithPopup, GoogleAuthProvider, signOut as fbSignOut, sendPasswordResetEmail,
  setPersistence, browserLocalPersistence
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import {
  getFirestore, doc, setDoc, getDoc, collection, query, orderBy, onSnapshot,
  enableIndexedDbPersistence
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';

const cfg = window.FIREBASE_CONFIG;
if (!cfg || cfg.apiKey === 'REMPLACE-MOI') {
  console.error('[firebase] public/firebase-config.js non renseigné — colle la config de ton appli Web (Console Firebase → Paramètres du projet).');
}
const WORKER_URL = (window.QUOTES_WORKER_URL || '').replace(/\/+$/, '');
if (!WORKER_URL) {
  console.warn('[quotes] window.QUOTES_WORKER_URL non renseigné — cotations en direct désactivées (derniers cours connus utilisés).');
}

const Core = window.PatrimoineCore;
if (!Core) console.error('[app-core] window.PatrimoineCore absent — charge app-core.js avant firebase-client.js.');

const app = initializeApp(cfg);
const auth = getAuth(app);
const db = getFirestore(app);

setPersistence(auth, browserLocalPersistence).catch(e => console.warn('[firebase] persistance auth indisponible :', e.message));
enableIndexedDbPersistence(db).catch(e => {
  if (e.code !== 'failed-precondition' && e.code !== 'unimplemented') console.warn('[firebase] persistance Firestore indisponible :', e.message);
});

/* ============================================================
   Authentification
   ============================================================ */
const authListeners = new Set();
let currentUser = null;

onAuthStateChanged(auth, user => { currentUser = user; authListeners.forEach(cb => cb(user)); });

function friendlyAuthError(e) {
  const map = {
    'auth/invalid-email': 'Adresse e-mail invalide.',
    'auth/user-disabled': 'Ce compte a été désactivé.',
    'auth/user-not-found': 'Aucun compte avec cette adresse.',
    'auth/wrong-password': 'Mot de passe incorrect.',
    'auth/invalid-credential': 'Adresse e-mail ou mot de passe incorrect.',
    'auth/email-already-in-use': 'Un compte existe déjà avec cette adresse.',
    'auth/weak-password': 'Mot de passe trop court (6 caractères minimum).',
    'auth/too-many-requests': 'Trop de tentatives — réessaie dans quelques minutes.',
    'auth/popup-closed-by-user': 'Fenêtre Google fermée avant la fin de la connexion.',
    'auth/network-request-failed': 'Réseau indisponible.',
    'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'Configuration Firebase manquante — renseigne public/firebase-config.js (voir README-FIREBASE.md).',
    'auth/invalid-api-key': 'Configuration Firebase manquante — renseigne public/firebase-config.js (voir README-FIREBASE.md).',
    'auth/configuration-not-found': "Méthode de connexion non activée — Console Firebase → Authentication → Sign-in method.",
    'auth/operation-not-allowed': "Méthode de connexion non activée — Console Firebase → Authentication → Sign-in method."
  };
  return map[e.code] || e.message || 'Erreur de connexion.';
}

window.PatrimoineAuth = {
  onUser(cb) { authListeners.add(cb); if (currentUser !== undefined) cb(currentUser); return () => authListeners.delete(cb); },
  get user() { return currentUser; },
  async signIn(email, password) { try { await signInWithEmailAndPassword(auth, email, password); } catch (e) { throw new Error(friendlyAuthError(e)); } },
  async signUp(email, password) { try { await createUserWithEmailAndPassword(auth, email, password); } catch (e) { throw new Error(friendlyAuthError(e)); } },
  async signInGoogle() { try { await signInWithPopup(auth, new GoogleAuthProvider()); } catch (e) { throw new Error(friendlyAuthError(e)); } },
  async resetPassword(email) { try { await sendPasswordResetEmail(auth, email); } catch (e) { throw new Error(friendlyAuthError(e)); } },
  async signOut() { await fbSignOut(auth); }
};

/* ============================================================
   Données — Firestore (brut) + valorisation client + Worker (cotations)
   ============================================================ */
let uid = null;
let unsubPortfolio = null, unsubHistory = null;
let rawPortfolio = null, history = [], lastSnapshot = null;
let refreshing = false;
const dataListeners = new Set();

const mainRef = () => doc(db, 'users', uid, 'portfolio', 'main');
const historyCol = () => collection(db, 'users', uid, 'history');

function emit() {
  const payload = lastSnapshot ? { ...lastSnapshot, history } : null;
  dataListeners.forEach(cb => cb(payload));
}

function stopListening() {
  unsubPortfolio?.(); unsubHistory?.();
  unsubPortfolio = unsubHistory = null;
  rawPortfolio = null; history = []; lastSnapshot = null; uid = null;
}

function startListening(user) {
  stopListening();
  uid = user.uid;

  unsubHistory = onSnapshot(
    query(historyCol(), orderBy('date')),
    qs => { history = qs.docs.map(d => d.data()); if (lastSnapshot) emit(); },
    err => console.error('[firestore] history:', err.message)
  );

  unsubPortfolio = onSnapshot(
    mainRef(),
    async snap => {
      rawPortfolio = normalize(snap.exists() ? snap.data() : null);
      // valorisation immédiate au dernier cours connu, puis rafraîchissement réseau
      lastSnapshot = Core.value(rawPortfolio, new Map());
      emit();
      recompute(true).catch(e => console.warn('[quotes] rafraîchissement:', e.message));
    },
    err => console.error('[firestore] portfolio:', err.message)
  );
}

function normalize(data) {
  if (!data) return structuredClone(Core.EMPTY);
  return {
    meta: data.meta || { imports: [] },
    balances: data.balances || {},
    cash: data.cash || {},
    positions: data.positions || [],
    operations: data.operations || []
  };
}

/** Cotations depuis le Worker Cloudflare. Renvoie une Map key → quote (vide si indisponible).
    Délai maximal borné : au pire on garde les derniers cours connus, jamais de blocage. */
async function fetchQuotes(positions) {
  if (!WORKER_URL) return new Map();
  const req = Core.quoteRequest(positions);
  if (!req.length) return new Map();

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`cotations HTTP ${res.status}`);
    return new Map(Object.entries(await res.json()));
  } finally {
    clearTimeout(timer);
  }
}

/** Recalcule la valorisation. live=true → interroge le Worker ; sinon derniers cours connus. */
async function recompute(live) {
  if (!rawPortfolio) return null;
  let quoteMap = new Map();
  if (live && WORKER_URL) {
    refreshing = true; emitStatus();
    // inclut les lignes reconstruites depuis les opérations, sinon un
    // portefeuille issu d'un CSV de transactions ne serait jamais coté
    const toQuote = [
      ...(rawPortfolio.positions || []),
      ...Core.deriveFromOperations(rawPortfolio).positions
    ];
    try { quoteMap = await fetchQuotes(toQuote); }
    finally { refreshing = false; }
  }

  lastSnapshot = Core.value(rawPortfolio, quoteMap);
  emit();

  if (live && quoteMap.size) {
    await persistResolvedSymbols(quoteMap);
    await writeHistoryPoint(lastSnapshot);
  }
  return lastSnapshot;
}

// signal d'état pour l'UI (badge « rafraîchissement en cours »)
function emitStatus() { /* réservé : l'UI relit lastSnapshot.quotes ; hook laissé pour extension */ }

/** Un symbole résolu par le Worker est réécrit dans le portefeuille pour ne
    plus avoir à le redeviner ensuite. Écriture unique, seulement si nouveau. */
async function persistResolvedSymbols(quoteMap) {
  let changed = false;
  for (const p of rawPortfolio.positions) {
    if (p.symbol) continue;
    const q = quoteMap.get(Core.keyOf(p));
    if (q && q.symbol && (q.confidence === 'libellé' || q.confidence === 'cours')) { p.symbol = q.symbol; changed = true; }
  }
  if (changed) { try { await setDoc(mainRef(), rawPortfolio); } catch (e) { console.warn('[firestore] symboles:', e.message); } }
}

async function writeHistoryPoint(snapshot) {
  const today = snapshot.asOf.slice(0, 10);
  const comptes = {};
  for (const [name, c] of Object.entries(snapshot.comptes)) comptes[name] = { value: c.value, mise: c.mise };
  try {
    await setDoc(doc(historyCol(), today), { date: today, val: snapshot.totals.patrimoine, cap: snapshot.totals.capital, comptes });
  } catch (e) { console.warn('[firestore] history:', e.message); }
}

async function ensureLoaded() {
  if (rawPortfolio) return;
  const snap = await getDoc(mainRef());
  rawPortfolio = normalize(snap.exists() ? snap.data() : null);
}

/* ---------- écritures (import, solde, symbole) ---------- */
async function importFile(file) {
  await ensureLoaded();
  const u8 = new Uint8Array(await file.arrayBuffer());
  const parsed = await Core.parseFile(u8, file.name, {});

  const report = { file: file.name, kind: parsed.kind, sourceRows: parsed.sourceRows, skipped: parsed.skipped };
  if (parsed.kind === 'operations') Object.assign(report, Core.mergeOperations(rawPortfolio, parsed.operations));
  else Object.assign(report, Core.mergePositions(rawPortfolio, parsed.positions));

  rawPortfolio.meta = rawPortfolio.meta || { imports: [] };
  rawPortfolio.meta.imports = rawPortfolio.meta.imports || [];
  rawPortfolio.meta.imports.push({ file: file.name, at: new Date().toISOString(), kind: parsed.kind, rows: parsed.operations.length + parsed.positions.length, ok: true });
  rawPortfolio.meta.updatedAt = new Date().toISOString().slice(0, 10);

  // Enregistre d'abord et rends la main tout de suite : la valorisation au
  // dernier cours connu suffit à confirmer l'import. Le rafraîchissement des
  // cotations (appel réseau au Worker) se fait en arrière-plan via le listener
  // onSnapshot déclenché par cette écriture — ne PAS l'attendre ici, sinon
  // l'import « reste bloqué » tant que les cotations ne répondent pas.
  await setDoc(mainRef(), rawPortfolio);
  const snapshot = Core.value(rawPortfolio, new Map());
  lastSnapshot = snapshot;
  return { ok: true, report, snapshot };
}

async function updateBalance(compte, value, taux) {
  await ensureLoaded();
  rawPortfolio.balances = rawPortfolio.balances || {};
  rawPortfolio.balances[compte] = { value, taux: taux ?? rawPortfolio.balances[compte]?.taux ?? null, updatedAt: new Date().toISOString().slice(0, 10) };
  await setDoc(mainRef(), rawPortfolio);
  return recompute(false);
}

/* ---------- saisie manuelle des lignes ---------- */

const posId = p => (p.isin || p.ticker || p.name || '').toUpperCase() + '|' + (p.compte || '');

/**
 * Ajoute ou remplace une ligne saisie à la main (action, ETF, obligation,
 * fonds euro, liquidités…). Identifiée par ISIN/ticker/nom + enveloppe :
 * ressaisir la même ligne la met à jour au lieu de la dupliquer.
 * @param {{compte,name,ticker?,isin?,symbol?,qty,pru,price?,cat?,manual?}} pos
 */
async function savePosition(pos) {
  await ensureLoaded();
  const clean = {
    compte: String(pos.compte || '').trim() || 'PEA',
    name: String(pos.name || '').trim(),
    ticker: String(pos.ticker || '').trim().toUpperCase(),
    isin: String(pos.isin || '').trim().toUpperCase(),
    qty: Number(pos.qty),
    pru: Number(pos.pru),
    cat: String(pos.cat || '').trim()
  };
  if (!clean.name) throw new Error('Le libellé est obligatoire.');
  if (!Number.isFinite(clean.qty) || clean.qty <= 0) throw new Error('Quantité invalide.');
  if (!Number.isFinite(clean.pru) || clean.pru < 0) throw new Error('Prix de revient (PRU) invalide.');

  const price = Number(pos.price);
  clean.price = Number.isFinite(price) && price > 0 ? price : clean.pru;   // sans cours saisi, on part du PRU
  if (pos.symbol) clean.symbol = String(pos.symbol).trim().toUpperCase();
  if (pos.manual) clean.manual = true;                                     // ligne jamais cotée (fonds euro…)

  rawPortfolio.positions = rawPortfolio.positions || [];
  const idx = rawPortfolio.positions.findIndex(x => posId(x) === posId(clean));
  const created = idx < 0;
  if (created) rawPortfolio.positions.push({ ...clean, addedAt: new Date().toISOString().slice(0, 10) });
  else rawPortfolio.positions[idx] = { ...rawPortfolio.positions[idx], ...clean };

  await setDoc(mainRef(), rawPortfolio);
  lastSnapshot = Core.value(rawPortfolio, new Map());
  emit();
  recompute(true).catch(e => console.warn('[quotes]', e.message));         // cotation en arrière-plan
  return { ok: true, created, name: clean.name, snapshot: lastSnapshot };
}

/** Supprime une ligne saisie ou importée. */
async function removePosition(name, compte) {
  await ensureLoaded();
  const before = (rawPortfolio.positions || []).length;
  rawPortfolio.positions = (rawPortfolio.positions || []).filter(
    x => !(x.name === name && (!compte || x.compte === compte))
  );
  if (rawPortfolio.positions.length === before) throw new Error(`Ligne « ${name} » introuvable.`);
  await setDoc(mainRef(), rawPortfolio);
  lastSnapshot = Core.value(rawPortfolio, new Map());
  emit();
  return { ok: true, snapshot: lastSnapshot };
}

/** Ajoute une opération saisie à la main (versement, dividende, achat…). */
async function addOperation(op) {
  await ensureLoaded();
  const clean = {
    date: Core.date(op.date) || new Date().toISOString().slice(0, 10),
    compte: String(op.compte || '').trim() || 'PEA',
    type: String(op.type || '').trim() || 'Versement',
    libelle: String(op.libelle || '').trim(),
    ticker: String(op.ticker || '').trim().toUpperCase(),
    isin: '',
    montant: Number(op.montant),
    qty: null, price: null
  };
  if (!Number.isFinite(clean.montant)) throw new Error('Montant invalide.');
  if (!clean.libelle) clean.libelle = clean.type;

  rawPortfolio.operations = rawPortfolio.operations || [];
  const merged = Core.mergeOperations(rawPortfolio, [clean]);
  if (!merged.added) throw new Error('Cette opération existe déjà (même date, compte, type, libellé et montant).');

  await setDoc(mainRef(), rawPortfolio);
  lastSnapshot = Core.value(rawPortfolio, new Map());
  emit();
  return { ok: true, snapshot: lastSnapshot };
}

async function pinSymbol(match, symbol, manual) {
  await ensureLoaded();
  const needle = String(match).toUpperCase();
  const hits = rawPortfolio.positions.filter(x =>
    (x.isin || '').toUpperCase() === needle || (x.ticker || '').toUpperCase() === needle || (x.name || '').toUpperCase() === needle);
  if (!hits.length) throw new Error(`Aucune ligne ne correspond à « ${match} »`);
  for (const h of hits) { if (manual) { h.manual = true; delete h.symbol; } else { h.symbol = symbol; delete h.manual; } }
  await setDoc(mainRef(), rawPortfolio);
  const snapshot = await recompute(true);
  return { ok: true, updated: hits.map(h => h.name), snapshot };
}

window.PatrimoineAuth.onUser(user => { if (user) startListening(user); else stopListening(); });

window.PatrimoineData = {
  onSnapshot(cb) { dataListeners.add(cb); if (lastSnapshot) emit(); return () => dataListeners.delete(cb); },
  importFile,
  refreshPerf(live = true) { return recompute(live); },
  updateBalance,
  pinSymbol,
  savePosition,
  removePosition,
  addOperation,
  get portfolio() { return rawPortfolio; },
  get refreshing() { return refreshing; }
};

// Les modules ES sont différés : ce signal réveille le script de rendu classique.
window.dispatchEvent(new Event('patrimoine:ready'));
