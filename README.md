# Patrimoine — dashboard PEA / Assurance Vie / Livret A

Dashboard local qui valorise le portefeuille avec des **cotations en direct** et se met à jour
depuis des **exports CSV / XLSX** de courtier.

Aucune dépendance npm : parseurs CSV et XLSX écrits à la main, serveur HTTP Node natif.
Le serveur n'écoute que sur `127.0.0.1`.

## Démarrer

```bash
node C:/dev/patrimoine/server.js
```

Puis http://127.0.0.1:4173

## Import de fichiers

Glisser-déposer sur la dropzone (vue globale ou modale d'import), ou « Choisir un fichier ».
Formats : `.csv`, `.tsv`, `.txt`, `.xlsx`, `.xlsm` — 10 Mo max.

Les colonnes sont reconnues automatiquement, en français comme en anglais, accents et casse
ignorés (`Date`, `Date d'opération`, `Compte`, `Enveloppe`, `Qté`, `Nombre de parts`, `PRU`,
`PRM`, `Cotation`, `ISIN`, `Montant`…). Séparateur `;` `,` tab ou `|` détecté seul.
Les montants acceptent `1 234,56`, `1.234,56`, `1,234.56`, `−516,56`, `(120,50)`.
Les dates acceptent `17/07/2026`, `2026-07-17`, `17-07-26` et les sérials Excel.

Deux types de fichiers, distingués par les colonnes présentes :

| Type | Colonnes déclencheuses | Effet |
|---|---|---|
| **Opérations** | Date + Montant (+ Type) | ajout au journal, **doublons exacts ignorés** |
| **Positions** | Quantité + PRU/Cours/ISIN | **instantané** : remplace les lignes de l'enveloppe concernée, les lignes absentes sont soldées |

Exemples :

```csv
Date;Compte;Type;Libellé;Montant;Ticker
2026-07-17;PEA;ACHAT;Schneider Electric;-516,56;SU
```

```csv
Compte;Support;ISIN;Nombre de parts;PRM;Cotation
Assurance Vie;Amundi Core S&P 500;LU2089238146;1,6573;67,21;67,66
```

Un fichier dont les colonnes ne sont pas reconnues est refusé avec la liste des colonnes lues —
rien n'est écrit.

## Cotations en direct

Fournisseur principal **Yahoo Finance** (sans clé), repli **Stooq**. Cache mémoire de 60 s.
Le dashboard s'abonne à `/api/stream` (SSE) et reçoit une valorisation toutes les 60 s ;
si le flux tombe, il bascule en polling. Bouton « Actualiser » pour forcer.

### Résolution des symboles

Un symbole deviné n'est **jamais** accepté sur la seule foi de la recherche par ISIN : celle-ci
renvoie régulièrement un autre fonds du même émetteur (Yahoo répond *Amundi Global Luxury* pour
l'ISIN d'un S&P 500 hedged, *Euro Gov 1-3Y* pour une tranche 5-7Y). Un candidat n'est retenu que
si le **libellé concorde** (tokens significatifs + tokens numériques compatibles) ou si son
**cours est à moins de 6 %** du dernier cours connu de la ligne. Sinon la ligne reste sur son
dernier cours connu et le bandeau l'indique.

Pour figer un symbole, soit le champ `symbol` dans `data/portfolio.json`, soit :

```bash
curl -X POST http://127.0.0.1:4173/api/symbol -d "{\"match\":\"LU2089238146\",\"symbol\":\"SP5.PA\"}"
```

Une ligne non cotée (fonds euro, support non listé) se marque `"manual": true` — elle n'est plus
comptée comme échec de cotation.

## App mobile Android

`/m/` sert la même donnée qu'`/`, en **PWA installable** : trois écrans (Accueil, Portefeuille,
Activité), nav basse, masquage des montants (icône œil, mémorisé), import par bottom sheet.

### Installer sur le téléphone

Le téléphone doit joindre la machine, donc le serveur doit sortir de la boucle locale — ce qui
exige un jeton (le serveur **refuse de démarrer** sur une adresse non-loopback sans lui) :

```bash
PATRIMOINE_TOKEN=un-secret-long HOST=0.0.0.0 node server.js
```

Le démarrage affiche l'URL à ouvrir sur le téléphone (`http://<ip-locale>:4173/m/?k=<jeton>`).
Chrome Android → menu → « Ajouter à l'écran d'accueil » : l'app s'ouvre ensuite en plein écran,
sans barre d'adresse, avec sa propre icône.

Le jeton est mémorisé par l'app au premier lancement (`localStorage`) et renvoyé en `X-Token`.
Toutes les routes `/api/*` l'exigent ; la coquille `/m/` reste servie sans jeton (aucune donnée
n'y est incluse). Sans `PATRIMOINE_TOKEN`, l'accès local reste ouvert comme avant.

### Hors réseau

Un service worker met la coquille en cache (jamais `/api/*`) et l'app conserve le dernier
instantané reçu : elle s'ouvre remplie même sans serveur joignable, avec le bandeau
« Hors ligne · dernières valeurs connues ». Le rafraîchissement est suspendu quand l'app passe
en arrière-plan, et relancé au retour au premier plan.

Les icônes (192 et 512 px, dont une maskable) sont **générées à la volée** par `lib/png.js` —
aucun binaire dans le dépôt.

### Emballer en APK (optionnel)

La PWA suffit pour un usage perso. Pour un vrai APK, deux voies, toutes deux hors de ce dépôt :

- **TWA / Bubblewrap** — `npx @bubblewrap/cli init --manifest https://<hôte>/m/manifest.webmanifest`.
  Exige HTTPS et un `assetlinks.json` sur le domaine ; incompatible avec un simple serveur LAN en http.
- **Capacitor** — `npx cap init` puis `server.url` pointant sur l'adresse du serveur, `npx cap add android`.
  Fonctionne en http sur le réseau local (via `android:usesCleartextTraffic`).

## API

| Route | Effet |
|---|---|
| `GET /api/perf` | valorisation complète (totaux, comptes, lignes, allocation, opérations, dividendes) |
| `GET /api/stream` | flux SSE, événement `perf` toutes les `REFRESH_MS` |
| `POST /api/refresh` | vide le cache de cotations et revalorise |
| `POST /api/import` | corps = fichier brut, en-tête `X-File-Name` (option `X-Compte`) |
| `POST /api/balance` | `{ compte, value, taux? }` — solde d'un livret |
| `POST /api/symbol` | `{ match, symbol }` ou `{ match, manual: true }` |
| `GET /api/portfolio` · `GET /api/history` · `GET /api/quotes?symbols=SU.PA,ENGI.PA` | lecture brute |

Variables d'environnement : `PORT` (4173), `REFRESH_MS` (60000), `QUOTE_PROVIDER`
(`yahoo`\|`stooq`), `QUOTE_TTL_MS` (60000), `QUOTE_NEAR_PRICE` (0.06), `QUOTE_TIMEOUT_MS` (6000).

## Données

**Le dossier `data/` est hors dépôt** (`.gitignore`) : il contient des montants personnels.
Seuls `portfolio.example.json` et `history.example.json` sont versionnés ; ils sont copiés
automatiquement au premier lancement si les fichiers réels sont absents.

- `data/portfolio.json` — positions, opérations, soldes, liquidités. Seule source de vérité.
- `data/history.json` — un point par jour (patrimoine, capital, détail par enveloppe), alimenté
  à chaque valorisation. Amorcé avec les 8 mois de la maquette ; les points par enveloppe
  n'existent qu'à partir du premier lancement réel, avant quoi les graphes par enveloppe tracent
  une droite début → aujourd'hui.
- `data/symbols.json` — cache ISIN/ticker → symbole, régénérable (supprimable sans risque).

Écritures atomiques (fichier temporaire + rename), pas de JSON tronqué en cas de coupure.

### Ce qui reste statique dans l'UI

Non déductible d'un export courtier, donc codé en dur dans `public/index.html` :
projections de dividendes à venir, répartition **sectorielle** (transparence des ETF),
onglet **Exposition réelle** (look-through des ETF) et ses commentaires, dates de maturité
fiscale. Tout le reste — totaux, plus-values, cours, allocation par ligne et par classe,
journal, dividendes encaissés, projection d'objectif — est calculé.

## Calcul de la plus-value

`capital = Σ (quantité × PRU) + soldes garantis + liquidités`, `plus-value = valorisation − capital`.
Les dividendes encaissés sont donc comptés séparément (bloc « Dividendes ») et non dans la
plus-value latente.
