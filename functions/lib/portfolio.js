'use strict';

/**
 * Logique de valorisation — identique à lib/portfolio.js du serveur local,
 * moins load()/save()/pushHistory()/history() : ici le portefeuille est un
 * objet passé en argument (lu depuis Firestore par index.js), et l'historique
 * est écrit par index.js dans la sous-collection users/{uid}/history.
 */

const quotes = require('./quotes');
const { round2, frDate } = require('./util');

const keyOf = p => p.isin || p.ticker || p.name;
const opKey = o => [o.date, o.compte, o.type, o.libelle, o.montant, o.ticker].join('|');

/* ============================================================
   Fusion des imports
   ============================================================ */

/**
 * Ajoute des opérations en ignorant les doublons exacts.
 * @returns {{added:number, duplicates:number}}
 */
function mergeOperations(portfolio, ops) {
  const seen = new Set(portfolio.operations.map(opKey));
  let added = 0, duplicates = 0;
  for (const op of ops) {
    const k = opKey(op);
    if (seen.has(k)) { duplicates++; continue; }
    seen.add(k);
    portfolio.operations.push(op);
    added++;
  }
  portfolio.operations.sort((a, b) => b.date.localeCompare(a.date));
  return { added, duplicates };
}

/**
 * Un import de positions est un instantané : il remplace les lignes
 * de l'enveloppe concernée (et met à jour le solde des livrets).
 * @returns {{added:number, updated:number, removed:number}}
 */
function mergePositions(portfolio, positions) {
  const touched = new Set(positions.map(p => p.compte));
  let added = 0, updated = 0;

  for (const p of positions) {
    if (p.qty == null && p.amount != null && /livret|ldds|lep/i.test(p.compte + ' ' + p.name)) {
      const prev = portfolio.balances[p.compte];
      portfolio.balances[p.compte] = { value: p.amount, taux: prev?.taux ?? null, updatedAt: new Date().toISOString().slice(0, 10) };
      updated++;
      continue;
    }
    const existing = portfolio.positions.find(x => x.compte === p.compte && keyOf(x) === keyOf(p));
    if (existing) {
      Object.assign(existing, {
        name: p.name || existing.name,
        ticker: p.ticker || existing.ticker,
        isin: p.isin || existing.isin,
        qty: p.qty ?? existing.qty,
        pru: p.pru ?? existing.pru,
        price: p.price ?? existing.price,
        cat: p.cat || existing.cat
      });
      updated++;
    } else {
      portfolio.positions.push({ ...p, addedAt: new Date().toISOString().slice(0, 10) });
      added++;
    }
  }

  const keep = new Set(positions.map(p => p.compte + '::' + keyOf(p)));
  const before = portfolio.positions.length;
  portfolio.positions = portfolio.positions.filter(
    x => !touched.has(x.compte) || keep.has(x.compte + '::' + keyOf(x))
  );
  return { added, updated, removed: before - portfolio.positions.length };
}

/* ============================================================
   Classement des lignes
   ============================================================ */

function classOf(pos) {
  const s = (pos.cat + ' ' + pos.name).toLowerCase();
  if (/fonds euro/.test(s)) return 'Fonds euro';
  if (/oblig|bond|govern|aggregate/.test(s)) return 'Obligations';
  if (/etf|ucits|amundi|vanguard|spdr|ishares|lyxor|msci|s&p/.test(s)) return 'ETF actions';
  if (/liquidit|especes|espèces|cash/.test(s)) return 'Liquidités';
  return 'Actions en direct';
}

/* ============================================================
   Valorisation
   ============================================================ */

/**
 * Valorise le portefeuille avec les cotations en direct.
 * @param {object} portfolio { balances, cash, positions, operations, meta }
 * @param {{live?:boolean}} opts live=false → dernier cours connu, sans appel réseau
 */
async function value(portfolio, opts = {}) {
  const live = opts.live !== false;
  const quoteMap = live ? await quotes.quoteAll(portfolio.positions) : new Map();

  let quotesOk = 0, quotesFailed = [];

  const lines = portfolio.positions.map(p => {
    const q = quoteMap.get(keyOf(p));
    const price = (q && typeof q.price === 'number') ? q.price : (p.price ?? p.pru ?? 0);
    if (q && typeof q.price === 'number' && !q.stale) quotesOk++;
    else if (live && !q?.manual) quotesFailed.push({ name: p.name, reason: q?.error || 'cours indisponible' });

    const qty = p.qty ?? 0;
    const mise = round2(qty * (p.pru ?? price));
    const val = round2(qty * price);
    const pv = round2(val - mise);
    return {
      compte: p.compte, name: p.name, ticker: p.ticker, isin: p.isin, cat: p.cat || '',
      qty, pru: p.pru, price: round2(price), value: val, mise, pv,
      pct: mise ? round2(pv / mise * 100) : 0,
      classe: classOf(p),
      symbol: q?.symbol || p.symbol || null,
      symbolPinned: !!p.symbol,
      source: q?.source || 'stocké',
      quotedAt: q?.at || null,
      manual: !!q?.manual,
      live: !!(q && typeof q.price === 'number' && !q.stale),
      dayChange: q && q.previousClose ? round2((price - q.previousClose) * qty) : null
    };
  });

  const comptes = {};
  for (const [name, cash] of Object.entries(portfolio.cash || {})) {
    comptes[name] = { name, value: round2(cash), mise: round2(cash), pv: 0, pvPct: 0, cash: round2(cash), lines: [], dayChange: 0 };
  }
  for (const l of lines) {
    const c = comptes[l.compte] ||= { name: l.compte, value: 0, mise: 0, pv: 0, pvPct: 0, cash: 0, lines: [], dayChange: 0 };
    c.lines.push(l);
    c.value = round2(c.value + l.value);
    c.mise = round2(c.mise + l.mise);
    c.dayChange = round2(c.dayChange + (l.dayChange || 0));
  }
  for (const [name, bal] of Object.entries(portfolio.balances || {})) {
    const c = comptes[name] ||= { name, value: 0, mise: 0, pv: 0, pvPct: 0, cash: 0, lines: [], dayChange: 0 };
    c.value = round2(c.value + bal.value);
    c.mise = round2(c.mise + bal.value);
    c.balance = bal.value;
    c.taux = bal.taux;
    c.garanti = true;
    if (bal.taux) c.interets = round2(bal.value * bal.taux / 100);
  }
  for (const c of Object.values(comptes)) {
    c.pv = round2(c.value - c.mise);
    c.pvPct = c.mise ? round2(c.pv / c.mise * 100) : 0;
    c.lines.sort((a, b) => b.pv - a.pv);
  }

  const patrimoine = round2(Object.values(comptes).reduce((s, c) => s + c.value, 0));
  const capital = round2(Object.values(comptes).reduce((s, c) => s + c.mise, 0));
  const bourse = round2(Object.values(comptes).filter(c => !c.garanti).reduce((s, c) => s + c.value, 0));
  const dayChange = round2(Object.values(comptes).reduce((s, c) => s + (c.dayChange || 0), 0));

  return {
    asOf: new Date().toISOString(),
    live,
    quotes: { ok: quotesOk, failed: quotesFailed, provider: quotes.PRIMARY },
    totals: {
      patrimoine, capital,
      pv: round2(patrimoine - capital),
      pvPct: capital ? round2((patrimoine - capital) / capital * 100) : 0,
      partBourse: patrimoine ? round2(bourse / patrimoine * 100) : 0,
      dayChange,
      ...flows(portfolio.operations)
    },
    comptes,
    lines,
    allocation: allocation(comptes, lines),
    operations: portfolio.operations.map(o => ({ ...o, dateFr: frDate(o.date) })),
    dividends: dividends(portfolio.operations),
    imports: (portfolio.meta?.imports || []).slice(-8).reverse()
  };
}

/* ============================================================
   Flux, dividendes, allocation
   ============================================================ */

function flows(ops = []) {
  const now = new Date();
  const ym = now.toISOString().slice(0, 7);
  const versements = ops.filter(o => o.type === 'Versement' || o.type === 'Ouverture');
  const epargneMois = round2(versements.filter(o => o.date.slice(0, 7) === ym).reduce((s, o) => s + o.montant, 0));
  const total = round2(versements.reduce((s, o) => s + o.montant, 0));
  const months = new Set(ops.map(o => o.date.slice(0, 7)));
  return {
    epargneMois,
    versementsTotal: total,
    moisSuivis: months.size,
    epargneMoyenne: months.size ? round2(total / months.size) : 0,
    premiereOperation: ops.length ? ops[ops.length - 1].date : null
  };
}

/** Dividendes/intérêts réellement encaissés, par année puis par mois. */
function dividends(ops = []) {
  const byYear = {};
  for (const o of ops) {
    if (o.type !== 'Dividende') continue;
    const y = o.date.slice(0, 4), m = Number(o.date.slice(5, 7)) - 1;
    const y_ = byYear[y] ||= { months: Array(12).fill(0), lines: Array.from({ length: 12 }, () => []), total: 0 };
    y_.months[m] = round2(y_.months[m] + o.montant);
    y_.lines[m].push([o.libelle, o.montant]);
    y_.total = round2(y_.total + o.montant);
  }
  return byYear;
}

function allocation(comptes, lines) {
  const titre = [], classe = {};
  for (const [name, c] of Object.entries(comptes)) {
    if (c.garanti) { titre.push([name, c.value]); classe['Épargne garantie'] = round2((classe['Épargne garantie'] || 0) + c.value); }
    if (c.cash) { classe['Liquidités'] = round2((classe['Liquidités'] || 0) + c.cash); }
  }
  for (const l of lines) {
    titre.push([l.name, l.value]);
    classe[l.classe] = round2((classe[l.classe] || 0) + l.value);
  }
  const cashTotal = Object.values(comptes).reduce((s, c) => s + (c.cash || 0), 0);
  if (cashTotal) titre.push(['Liquidités', round2(cashTotal)]);

  titre.sort((a, b) => b[1] - a[1]);
  return {
    titre,
    classe: Object.entries(classe).sort((a, b) => b[1] - a[1]),
    parEnveloppe: Object.entries(comptes).map(([n, c]) => [n, c.value]).sort((a, b) => b[1] - a[1])
  };
}

const EMPTY = { meta: { imports: [] }, balances: {}, cash: {}, positions: [], operations: [] };

module.exports = { value, mergeOperations, mergePositions, classOf, EMPTY };
