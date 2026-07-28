# Patrimoine sur Firebase — configuration

Ce document couvre la version « vraie app » : compte Firebase Auth, données
Firestore synchronisées en temps réel, cotations calculées par des Cloud
Functions. Elle remplace le serveur local (`server.js`, données dans
`data/*.json`) qui restait mono-machine et exigeait de laisser ton PC allumé
avec un jeton pour y accéder depuis le téléphone.

## Ce qui a été construit

```
firebase.json              config Hosting + Firestore + Functions + émulateurs
firestore.rules            chaque utilisateur ne lit QUE users/{son-uid}/…
firestore.indexes.json
functions/
  package.json
  index.js                 4 Cloud Functions (voir plus bas)
  lib/{csv,xlsx,util,importer,quotes,portfolio}.js
                            portage quasi verbatim de lib/*.js — mêmes
                            parseurs, même logique de cotation/valorisation,
                            testés hors-ligne (voir « Ce qui n'est pas testé »)
public/
  firebase-config.js        ⚠️ à remplir — clés publiques de ton appli Web
  firebase-client.js        auth + écoute Firestore + appel des Functions
  index.html, m/*           rewiring : /api/* remplacé par Firebase partout
```

**Schéma Firestore** (par utilisateur, `users/{uid}/…`) :

| Chemin | Contenu |
|---|---|
| `portfolio/main` | positions, opérations, soldes, liquidités — équivalent de l'ancien `portfolio.json` |
| `portfolio/snapshot` | dernière valorisation calculée (le client la lit directement, temps réel) |
| `portfolio/symbolCache` | cache ISIN/ticker → symbole résolu |
| `history/{yyyy-mm-dd}` | un point par jour |

**Cloud Functions** (`onCall`, authentification requise) :

| Function | Rôle |
|---|---|
| `importFile` | reçoit un CSV/XLSX en base64, parse, fusionne, revalorise |
| `refreshPerf` | revalorise avec cotations fraîches |
| `updateBalance` | solde d'un livret |
| `pinSymbol` | fige/débranche la cotation d'une ligne |

Le client ne fait jamais de calcul de valorisation lui-même : il lit
`portfolio/snapshot` et `history/*` par abonnement Firestore temps réel
(`onSnapshot`), et n'appelle les Functions que pour les écritures qui
exigent la logique métier serveur. Les règles Firestore (`firestore.rules`)
interdisent toute écriture directe depuis le client — seul le SDK Admin
(dans les Functions) peut écrire, elles ne sont donc jamais contournables
depuis le navigateur.

## À faire de ton côté (obligatoire)

Je ne peux pas me connecter à ton compte Google ni deviner l'ID du projet
que tu as créé — ces étapes sont pour toi.

### 1. Connecter le CLI

```bash
firebase login
```

### 2. Lier ce dossier à ton projet

Console Firebase → ⚙️ *Paramètres du projet* → *Général* → copie l'**ID du
projet**, puis :

```bash
firebase use --add
```

Choisis ton projet dans la liste (ou édite `.firebaserc` toi-même, en
remplaçant `REMPLACE-PAR-TON-PROJECT-ID`).

### 3. Passer au forfait Blaze (paiement à l'usage)

**Décision qui t'appartient — je ne peux pas la prendre à ta place.**
Console Firebase → en bas à gauche → *Mettre à niveau* → *Blaze*.

Nécessaire car les Cloud Functions doivent appeler Yahoo Finance / Stooq
(requêtes sortantes), ce que le forfait gratuit Spark interdit purement et
simplement. Le forfait Blaze garde les mêmes quotas gratuits que Spark et ne
facture qu'au-delà (2 millions d'appels de Function/mois, 50k lectures
Firestore/jour, etc.) — pour un usage personnel comme celui-ci, la facture
attendue est 0 €, mais une carte doit être enregistrée.

### 4. Activer les méthodes de connexion

Console Firebase → *Authentication* → *Sign-in method* → active
**E-mail/mot de passe** et **Google** (les deux sont déjà câblés côté code).

### 5. Créer la base Firestore

Console Firebase → *Firestore Database* → *Créer une base* → mode
production → région `eur3` (Europe) recommandée.

### 6. Récupérer la config de l'appli Web

Console Firebase → ⚙️ *Paramètres du projet* → onglet *Général* → section
*Vos applications* → ajoute une appli **Web** (icône `</>`) si tu n'en as
pas encore, donne-lui un nom, **ne coche pas** Firebase Hosting à cette
étape (déjà configuré). Copie l'objet `firebaseConfig` affiché et colle-le
dans [public/firebase-config.js](public/firebase-config.js) à la place des
valeurs `REMPLACE-MOI`.

### 7. Déployer

```bash
cd functions && npm install && cd ..
firebase deploy
```

Ça déploie Hosting, les 4 Cloud Functions et les règles Firestore en une
fois. L'URL finale est affichée à la fin (`https://<ton-projet>.web.app`).

### 8. Tester

Ouvre l'URL affichée, crée un compte, importe un fichier CSV/XLSX pour
vérifier que tout remonte. Sur le téléphone : ouvre la même URL + `/m/`
dans Chrome, puis « Ajouter à l'écran d'accueil » — plus besoin de jeton
LAN ni de laisser ton PC allumé, ça marche depuis n'importe quel réseau.

## Ce qui n'est pas testé

Je n'ai ni tes identifiants Firebase ni Java installé sur cette machine
(requis par les émulateurs Firestore/Auth), donc :

- **Testé** : les parseurs CSV/XLSX, la résolution de cotations Yahoo/Stooq
  et le calcul de valorisation (`functions/lib/*.js`) fonctionnent
  correctement — vérifié avec des données en mémoire, hors Firestore.
- **Testé** : les deux clients (dashboard et mobile) affichent bien l'écran
  de connexion et gèrent proprement une config Firebase absente/invalide
  (message d'erreur clair au lieu d'un écran de chargement infini).
- **Non testé** : le trajet complet Cloud Function ↔ Firestore ↔ client en
  conditions réelles (règles de sécurité, permissions, `onSnapshot` avec de
  vraies données). Ce sera le premier vrai test, à l'étape 8 ci-dessus.

Si `firebase deploy` échoue ou qu'une Function renvoie une erreur, colle-moi
le message — la logique métier est déjà validée, ce sera très probablement
une histoire de règles Firestore ou de configuration.

## Et le serveur local (`server.js`) ?

Toujours là, mais **plus utilisé par le client** : `public/index.html` et
`public/m/index.html` chargent maintenant `firebase-client.js` et ne parlent
plus aux routes `/api/*`. Lancer `node server.js` sert les fichiers
statiques mais affiche l'écran de connexion Firebase (pas les anciennes
données de `data/portfolio.json`). Gardé comme référence et pour un usage
de secours ; supprimable une fois la version Firebase confirmée en place.
Pour du développement local avec Firebase, préfère les émulateurs
(`firebase emulators:start`, déjà configurés dans `firebase.json`) — ils
nécessitent Java pour Firestore/Auth.
