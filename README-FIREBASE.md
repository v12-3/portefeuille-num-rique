# Patrimoine — publier gratuitement (sans carte bancaire)

Guide clic-par-clic pour mettre l'app en ligne pour la famille, **100 %
gratuit, sans jamais entrer de carte**.

Deux services gratuits, deux comptes à créer :

| Service | Rôle | Gratuit ? |
|---|---|---|
| **Firebase** (forfait Spark) | Connexion des comptes + base de données + hébergement du site | Oui, à vie, sans carte |
| **Cloudflare Workers** | Récupère les cotations de bourse (un navigateur ne peut pas appeler Yahoo directement) | Oui, 100 000 requêtes/jour, sans carte |

> Pourquoi deux services ? Les Cloud Functions de Firebase — qui feraient
> tout côté serveur — exigent une carte bancaire. On les remplace donc par :
> le calcul dans le navigateur (déjà codé, `public/app-core.js`) + un mini
> service Cloudflare pour les cotations. Résultat : zéro carte.

---

## Partie A — Cloudflare Worker (les cotations)

### A1. Créer un compte Cloudflare

Va sur **https://dash.cloudflare.com/sign-up** → crée un compte (e-mail +
mot de passe). Gratuit, aucune carte demandée.

### A2. Créer le Worker

1. Dans le tableau de bord Cloudflare, menu de gauche → **Workers & Pages**.
2. Bouton **Create application** → onglet **Create Worker**.
3. Donne-lui un nom, par ex. `patrimoine-cotations` → **Deploy** (il déploie
   un exemple par défaut, on va le remplacer).
4. Une fois déployé → bouton **Edit code** (ou **Continue to project** →
   **Edit code**).
5. Efface tout le code affiché, puis colle **l'intégralité** du fichier
   [worker/quotes-worker.js](worker/quotes-worker.js) de ce dépôt.
6. Bouton **Deploy** (en haut à droite).

### A3. Noter l'URL

En haut de la page du Worker, tu vois son adresse, du genre
`https://patrimoine-cotations.TON-COMPTE.workers.dev`.
**Copie-la** — tu en as besoin à l'étape B7.

---

## Partie B — Firebase (comptes, base, site)

### B1. Installer l'outil (une seule fois)

Déjà fait sur cette machine (`firebase --version` répond). Sinon :
`npm install -g firebase-tools`.

### B2. Se connecter

```bash
firebase login
```

Ça ouvre le navigateur → connecte-toi avec ton compte Google.

### B3. Lier ce dossier à ton projet Firebase

Tu as dit avoir déjà créé le projet dans la console. Récupère son **ID** :
Console Firebase (**https://console.firebase.google.com**) → ton projet →
⚙️ *Paramètres du projet* → *Général* → **ID du projet**. Puis :

```bash
firebase use --add
```

Choisis ton projet dans la liste. (Ça remplit `.firebaserc`. Tu peux aussi
éditer `.firebaserc` à la main et remplacer `REMPLACE-PAR-TON-PROJECT-ID`.)

**Pas besoin du forfait Blaze.** On ne déploie aucune Cloud Function, le
forfait gratuit Spark suffit. Ne mets pas de carte.

### B4. Activer les méthodes de connexion

Console Firebase → **Authentication** → si demandé, *Get started* →
onglet **Sign-in method** → active :
- **E-mail/Mot de passe** (clique dessus → *Enable* → *Save*),
- **Google** (clique dessus → *Enable* → choisis un e-mail d'assistance →
  *Save*).

### B5. Créer la base Firestore

Console Firebase → **Firestore Database** → *Create database* →
**Start in production mode** → région **eur3 (europe-west)** → *Enable*.

(Les règles de sécurité de ce dépôt seront déployées à l'étape B8, elles
verrouillent chaque compte à ses propres données.)

### B6. Récupérer la config de l'appli Web

Console Firebase → ⚙️ *Paramètres du projet* → *Général* → descends jusqu'à
**Vos applications**. Si aucune appli Web (icône `</>`), clique l'icône
`</>`, donne un surnom, **ne coche PAS** « Firebase Hosting » ici → *Enregistrer*.
Firebase affiche un bloc `const firebaseConfig = { ... }`. **Copie l'objet.**

### B7. Coller les deux configs

Ouvre [public/firebase-config.js](public/firebase-config.js) et remplace :
- l'objet `window.FIREBASE_CONFIG = {...}` par celui copié en B6 ;
- `window.QUOTES_WORKER_URL = "";` par l'URL du Worker copiée en A3, par ex.
  `window.QUOTES_WORKER_URL = "https://patrimoine-cotations.ton-compte.workers.dev";`

### B8. Déployer le site + les règles

```bash
firebase deploy --only hosting,firestore
```

À la fin, Firebase affiche l'URL du site :
`https://TON-PROJET.web.app`.

---

## Partie C — Utiliser

1. Ouvre `https://TON-PROJET.web.app` → crée ton compte (e-mail + mot de
   passe, ou Google).
2. Importe un fichier CSV/XLSX pour vérifier que le portefeuille remonte et
   que les cotations s'affichent.
3. **Sur le téléphone** : ouvre `https://TON-PROJET.web.app/m/` dans Chrome →
   menu ⋮ → *Ajouter à l'écran d'accueil*. L'app s'installe, plein écran,
   avec son icône. Marche depuis n'importe quel réseau, PC éteint.
4. **Pour la famille** : partage juste l'URL. Chacun crée son compte, chacun
   a son propre portefeuille (les données ne se mélangent pas).

---

## Ce qui a été testé / pas testé

- **Testé** (sur cette machine, hors Firebase) : parsing CSV et XLSX dans le
  navigateur (décompression via `DecompressionStream`), calcul de
  valorisation, et le Worker de cotations (résolution de symbole + Yahoo/Stooq
  répondent correctement).
- **Testé** : les deux apps (dashboard et mobile) affichent l'écran de
  connexion et réagissent proprement à une config absente (message clair).
- **Non testé** : le trajet complet navigateur ↔ Firestore ↔ Worker en
  conditions réelles (il me faut ton projet Firebase et ton Worker en ligne).
  C'est ce que tu valides à la Partie C.

Si `firebase deploy` échoue ou qu'une cotation ne remonte pas, colle-moi le
message d'erreur (console du navigateur : F12 → onglet *Console*) — la
logique est déjà validée, ce sera très probablement une règle Firestore, une
méthode de connexion oubliée (B4) ou l'URL du Worker (B7).

---

## Coûts — vraiment gratuit ?

Oui, pour un usage familial :
- **Firebase Spark** : gratuit à vie, sans carte. Quotas largement
  au-dessus d'un usage famille (50 000 lectures / 20 000 écritures Firestore
  par jour, 10 Go d'hébergement).
- **Cloudflare Workers** : 100 000 requêtes/jour gratuites, sans carte. Une
  actualisation de cotations = quelques requêtes.

Aucune carte n'est demandée nulle part dans ce guide. Si un écran te réclame
une carte, c'est que tu es sur une option payante (forfait Blaze de Firebase,
ou un plan Cloudflare payant) — reviens en arrière, tu n'en as pas besoin.

## Développement local

`node server.js` sert encore les fichiers en local, mais les clients parlent
maintenant à Firebase : tu verras l'écran de connexion. Pour tester la logique
sans déployer, les émulateurs Firebase (`firebase emulators:start`) sont
configurés dans `firebase.json` — ils demandent Java (absent de cette machine).
