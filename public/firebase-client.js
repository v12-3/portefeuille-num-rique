/**
 * Client Firebase partagé par le dashboard (/) et l'app mobile (/m/).
 * Module ES chargé par <script type="module">, expose une API classique
 * sur window.PatrimoineAuth / window.PatrimoineData pour le reste du code
 * (state + render() en script non-module dans index.html et m/index.html).
 *
 * - Auth : email/mot de passe + Google, un seul compte = un seul portefeuille.
 * - Données : le client lit users/{uid}/portfolio/snapshot et
 *   users/{uid}/history/* directement via Firestore (temps réel, hors-ligne
 *   géré nativement par le SDK) ; il n'appelle les Cloud Functions que pour
 *   les écritures qui exigent la logique métier serveur (import, cotations).
 */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signInWithPopup, GoogleAuthProvider, signOut as fbSignOut, sendPasswordResetEmail,
  setPersistence, browserLocalPersistence
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js';
import {
  getFirestore, doc, collection, query, orderBy, onSnapshot,
  enableIndexedDbPersistence
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js';
import {
  getFunctions, httpsCallable
} from 'https://www.gstatic.com/firebasejs/11.6.1/firebase-functions.js';

const cfg = window.FIREBASE_CONFIG;
if (!cfg || cfg.apiKey === 'REMPLACE-MOI') {
  console.error('[firebase] public/firebase-config.js non renseigné — colle la config de ton appli Web (Console Firebase → Paramètres du projet).');
}

const app = initializeApp(cfg);
const auth = getAuth(app);
const db = getFirestore(app);
const fns = getFunctions(app, 'europe-west1');

setPersistence(auth, browserLocalPersistence).catch(e => console.warn('[firebase] persistance auth indisponible :', e.message));
enableIndexedDbPersistence(db).catch(e => {
  // 'failed-precondition' = plusieurs onglets ouverts, 'unimplemented' = navigateur trop ancien : pas bloquant.
  if (e.code !== 'failed-precondition' && e.code !== 'unimplemented') console.warn('[firebase] persistance Firestore indisponible :', e.message);
});

/* ============================================================
   Authentification
   ============================================================ */

const authListeners = new Set();
let currentUser = null;

onAuthStateChanged(auth, user => {
  currentUser = user;
  authListeners.forEach(cb => cb(user));
});

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
    'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'Configuration Firebase manquante — renseigne public/firebase-config.js (voir README).',
    'auth/invalid-api-key': 'Configuration Firebase manquante — renseigne public/firebase-config.js (voir README).',
    'auth/configuration-not-found': "Méthode de connexion non activée — Console Firebase → Authentication → Sign-in method."
  };
  return map[e.code] || e.message || 'Erreur de connexion.';
}

window.PatrimoineAuth = {
  onUser(cb) { authListeners.add(cb); if (currentUser !== undefined) cb(currentUser); return () => authListeners.delete(cb); },
  get user() { return currentUser; },

  async signIn(email, password) {
    try { await signInWithEmailAndPassword(auth, email, password); }
    catch (e) { throw new Error(friendlyAuthError(e)); }
  },
  async signUp(email, password) {
    try { await createUserWithEmailAndPassword(auth, email, password); }
    catch (e) { throw new Error(friendlyAuthError(e)); }
  },
  async signInGoogle() {
    try { await signInWithPopup(auth, new GoogleAuthProvider()); }
    catch (e) { throw new Error(friendlyAuthError(e)); }
  },
  async resetPassword(email) {
    try { await sendPasswordResetEmail(auth, email); }
    catch (e) { throw new Error(friendlyAuthError(e)); }
  },
  async signOut() { await fbSignOut(auth); }
};

/* ============================================================
   Données (Firestore temps réel + Cloud Functions pour les écritures)
   ============================================================ */

let unsubSnapshot = null, unsubHistory = null;
let latestSnapshot = null, latestHistory = [];
const dataListeners = new Set();

function emit() {
  if (!latestSnapshot) { dataListeners.forEach(cb => cb(null)); return; }
  dataListeners.forEach(cb => cb({ ...latestSnapshot, history: latestHistory }));
}

function stopListening() {
  unsubSnapshot?.(); unsubHistory?.();
  unsubSnapshot = unsubHistory = null;
  latestSnapshot = null; latestHistory = [];
}

function startListening(uid) {
  stopListening();

  unsubSnapshot = onSnapshot(
    doc(db, 'users', uid, 'portfolio', 'snapshot'),
    snap => { latestSnapshot = snap.exists() ? snap.data() : null; emit(); },
    err => console.error('[firestore] snapshot:', err.message)
  );

  unsubHistory = onSnapshot(
    query(collection(db, 'users', uid, 'history'), orderBy('date')),
    qs => { latestHistory = qs.docs.map(d => d.data()); emit(); },
    err => console.error('[firestore] history:', err.message)
  );
}

// s'abonne automatiquement aux données du bon utilisateur à chaque connexion/déconnexion
window.PatrimoineAuth.onUser(user => { if (user) startListening(user.uid); else stopListening(); });

function friendlyFnError(e) {
  if (e.code === 'functions/unauthenticated') return 'Connexion requise.';
  if (e.code === 'functions/invalid-argument') return e.message;
  if (e.code === 'functions/not-found') return e.message;
  return e.message || 'Erreur serveur.';
}

const call = name => {
  const fn = httpsCallable(fns, name);
  return async (data) => {
    try { return (await fn(data)).data; }
    catch (e) { throw new Error(friendlyFnError(e)); }
  };
};

const _importFile = call('importFile');
const _refreshPerf = call('refreshPerf');
const _updateBalance = call('updateBalance');
const _pinSymbol = call('pinSymbol');

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Lecture du fichier impossible'));
    reader.readAsDataURL(file);
  });
}

window.PatrimoineData = {
  /** S'abonne aux données du portefeuille. cb(null) tant qu'aucune donnée n'est disponible. */
  onSnapshot(cb) { dataListeners.add(cb); emit(); return () => dataListeners.delete(cb); },

  async importFile(file) {
    const contentBase64 = await readFileAsBase64(file);
    return _importFile({ filename: file.name, contentBase64 });
  },
  refreshPerf(live = true) { return _refreshPerf({ live }); },
  updateBalance(compte, value, taux) { return _updateBalance({ compte, value, taux }); },
  pinSymbol(match, symbol, manual) { return _pinSymbol({ match, symbol, manual }); }
};

// Les modules ES sont toujours différés (comme <script defer>), même placés
// dans <head> : ils s'exécutent après le script classique en fin de <body>.
// Ce signal permet à ce dernier d'attendre que window.Patrimoine* existent.
window.dispatchEvent(new Event('patrimoine:ready'));
