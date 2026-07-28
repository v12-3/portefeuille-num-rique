'use strict';

const { parseCsv } = require('./csv');
const { parseXlsx } = require('./xlsx');
const { slug, num, date, round2 } = require('./util');

/* ============================================================
   Reconnaissance des colonnes
   ============================================================ */

const FIELDS = {
  date:    ['date', 'date operation', 'date d operation', 'date d execution', 'date valeur', 'date de l operation', 'jour'],
  compte:  ['compte', 'enveloppe', 'portefeuille', 'contrat', 'support fiscal', 'account'],
  type:    ['type', 'nature', 'operation', 'sens', 'libelle operation', 'mouvement'],
  libelle: ['libelle', 'libelle complet', 'description', 'designation', 'intitule', 'nom', 'support', 'valeur', 'produit', 'label'],
  montant: ['montant', 'montant net', 'montant brut', 'montant eur', 'amount', 'total', 'net'],
  ticker:  ['ticker', 'symbole', 'symbol', 'mnemo', 'mnemonique', 'code valeur'],
  isin:    ['isin', 'code isin'],
  qty:     ['quantite', 'qte', 'qty', 'nombre de parts', 'parts', 'nb parts', 'nombre'],
  pru:     ['pru', 'prm', 'prix de revient', 'prix moyen', 'prix de revient unitaire', 'prix moyen pondere', 'cout unitaire'],
  price:   ['cours', 'cotation', 'valeur liquidative', 'vl', 'derniere cotation', 'prix', 'cours de cloture'],
  amount:  ['montant', 'valorisation', 'valeur de rachat', 'contre valeur', 'montant investi'],
  cat:     ['categorie', 'classe', 'classe d actifs', 'type de support', 'poche']
};

/** header[] → { field: colIndex } */
function mapColumns(header) {
  const map = {};
  const slugs = header.map(slug);
  for (const [field, names] of Object.entries(FIELDS)) {
    let idx = slugs.findIndex(h => h && names.includes(h));
    if (idx < 0) idx = slugs.findIndex(h => h && names.some(n => h.startsWith(n)));
    if (idx >= 0 && !(field in map)) map[field] = idx;
  }
  return map;
}

const cell = (row, i) => (i == null || row[i] == null) ? '' : row[i];

/* ============================================================
   Normalisation des types d'opération
   ============================================================ */

const TYPES = [
  [/(achat|buy|souscription|arbitrage entrant)/i, 'Achat'],
  [/(vente|sell|rachat partiel|arbitrage sortant)/i, 'Vente'],
  [/(dividende|coupon|interet|intérêt)/i, 'Dividende'],
  [/(versement|virement|apport|alimentation|depot|dépôt)/i, 'Versement'],
  [/(retrait|prelevement|prélèvement|frais)/i, 'Retrait'],
  [/(ouverture|initial)/i, 'Ouverture'],
  [/(solde|position|valorisation)/i, 'Solde']
];

function normType(raw, montant) {
  const s = String(raw || '');
  for (const [re, out] of TYPES) if (re.test(s)) return out;
  if (montant != null) return montant < 0 ? 'Achat' : 'Versement';
  return 'Autre';
}

/** Nom d'enveloppe canonique. */
function normCompte(raw, fallback) {
  const s = slug(raw);
  if (!s) return fallback || 'PEA';
  if (/(pea|bourse direct|compte titre|cto)/.test(s)) return 'PEA';
  if (/(assurance vie|^av$|linxea|spirit|spirica|contrat)/.test(s)) return 'Assurance Vie';
  if (/(livret|ldds|lep|epargne reglementee)/.test(s)) return 'Livret A';
  return raw.trim();
}

/* ============================================================
   Détection du type de fichier
   ============================================================ */

function detectKind(map, header) {
  const hasPos = map.qty != null && (map.pru != null || map.price != null || map.isin != null);
  const hasOps = map.date != null && map.montant != null;
  if (hasPos && !hasOps) return 'positions';
  if (hasPos && hasOps) return map.type != null ? 'operations' : 'positions';
  if (hasOps) return 'operations';
  if (map.isin != null || map.ticker != null) return 'positions';
  throw new Error(
    'Colonnes non reconnues. Attendu pour des opérations : Date, Compte, Type, Montant, Ticker. ' +
    'Pour des positions : Libellé/ISIN, Quantité, PRU, Cours. Colonnes lues : ' + header.filter(Boolean).join(', ')
  );
}

/* ============================================================
   Lignes → entités
   ============================================================ */

function toOperation(row, map, defaults) {
  const d = date(cell(row, map.date));
  if (!d) return null;
  const montant = num(cell(row, map.montant));
  if (montant == null) return null;
  const libelle = String(cell(row, map.libelle) || '').trim();
  const type = normType(cell(row, map.type) || libelle, montant);
  return {
    date: d,
    compte: normCompte(cell(row, map.compte), defaults.compte),
    type,
    libelle: libelle || type,
    ticker: String(cell(row, map.ticker) || '').trim().toUpperCase(),
    isin: String(cell(row, map.isin) || '').trim().toUpperCase(),
    montant: round2(montant),
    qty: num(cell(row, map.qty)),
    price: num(cell(row, map.price))
  };
}

function toPosition(row, map, defaults) {
  const name = String(cell(row, map.libelle) || '').trim();
  const isin = String(cell(row, map.isin) || '').trim().toUpperCase();
  const ticker = String(cell(row, map.ticker) || '').trim().toUpperCase();
  if (!name && !isin && !ticker) return null;

  const qty = num(cell(row, map.qty));
  const price = num(cell(row, map.price));
  const pru = num(cell(row, map.pru));
  let amount = num(cell(row, map.amount));
  if (amount == null && qty != null && price != null) amount = qty * price;
  if (qty == null && amount == null) return null;

  return {
    compte: normCompte(cell(row, map.compte), defaults.compte),
    name: name || ticker || isin,
    ticker, isin,
    qty: qty == null ? null : qty,
    pru: pru == null ? null : round2(pru),
    price: price == null ? null : price,
    amount: amount == null ? null : round2(amount),
    cat: String(cell(row, map.cat) || '').trim()
  };
}

/* ============================================================
   Entrée publique
   ============================================================ */

/**
 * Parse un fichier importé.
 * @param {Buffer} buf contenu brut
 * @param {string} filename nom d'origine (détermine csv vs xlsx)
 * @param {{compte?:string}} defaults enveloppe par défaut si absente du fichier
 * @returns {{kind:'operations'|'positions', operations:[], positions:[], skipped:number, columns:object, sourceRows:number}}
 */
function parseFile(buf, filename, defaults = {}) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  let header, rows;

  if (ext === 'xlsx' || ext === 'xlsm') {
    ({ header, rows } = parseXlsx(buf));
  } else if (ext === 'csv' || ext === 'txt' || ext === 'tsv') {
    ({ header, rows } = parseCsv(buf.toString('utf8')));
  } else if (buf.length > 2 && buf[0] === 0x50 && buf[1] === 0x4b) {
    ({ header, rows } = parseXlsx(buf));           // signature ZIP → xlsx
  } else {
    ({ header, rows } = parseCsv(buf.toString('utf8')));
  }

  if (!header.length) throw new Error('Fichier vide ou illisible');

  const map = mapColumns(header);
  const kind = detectKind(map, header);

  const operations = [], positions = [];
  let skipped = 0;

  for (const row of rows) {
    const item = kind === 'operations' ? toOperation(row, map, defaults) : toPosition(row, map, defaults);
    if (!item) { skipped++; continue; }
    (kind === 'operations' ? operations : positions).push(item);
  }

  if (!operations.length && !positions.length) {
    throw new Error(`Aucune ligne exploitable (${rows.length} ligne(s) lue(s), ${skipped} ignorée(s)). Vérifie le format des dates et des montants.`);
  }

  return { kind, operations, positions, skipped, sourceRows: rows.length, columns: map };
}

module.exports = { parseFile, mapColumns, detectKind, normCompte, normType };
