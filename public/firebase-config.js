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
  apiKey: "AIzaSyDK1RbYja4EUxXeFzvwnsShrV48Uigy9oA",
  authDomain: "portefeuille-d10c5.firebaseapp.com",
  projectId: "portefeuille-d10c5",
  storageBucket: "portefeuille-d10c5.firebasestorage.app",
  messagingSenderId: "69621908624",
  appId: "1:69621908624:web:94554ec3370577272bc415",
  measurementId: "G-PZSK6ZWY8S"
};

window.QUOTES_WORKER_URL = "https://patrimoine-cotations.vmeslin07.workers.dev";
