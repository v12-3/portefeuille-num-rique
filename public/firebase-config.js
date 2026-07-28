/**
 * Configuration Firebase du projet — valeurs publiques (protégées par les
 * règles Firestore et l'authentification, pas des secrets).
 *
 * 1) FIREBASE_CONFIG : Console Firebase → ⚙️ Paramètres du projet → tes applis →
 *    application Web → « Configuration du SDK ». Colle l'objet firebaseConfig ici.
 *
 * 2) QUOTES_WORKER_URL : l'adresse de ton Cloudflare Worker de cotations
 *    (https://<nom>.<compte>.workers.dev). Laisse vide pour désactiver les
 *    cotations en direct — l'app marche quand même avec les derniers cours connus.
 */
window.FIREBASE_CONFIG = {
  apiKey: "REMPLACE-MOI",
  authDomain: "REMPLACE-MOI.firebaseapp.com",
  projectId: "REMPLACE-MOI",
  storageBucket: "REMPLACE-MOI.firebasestorage.app",
  messagingSenderId: "000000000000",
  appId: "1:000000000000:web:0000000000000000000000"
};

window.QUOTES_WORKER_URL = "";
