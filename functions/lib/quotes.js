'use strict';

/**
 * Cotations en direct — identique à lib/quotes.js du serveur local, sauf pour
 * le cache de symboles résolus : ici il n'écrit jamais sur disque (le système
 * de fichiers d'une Cloud Function est éphémère). L'appelant (index.js) le
 * charge depuis Firestore avant l'appel et le réenregistre après si modifié,
 * via loadSymbolCache() / getSymbolCache().
 *
 * Fournisseur principal : Yahoo Finance (endpoint chart, sans clé).
 * Repli : Stooq (CSV) pour les actions Euronext.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) patrimoine-functions/1.0';
const TTL_MS = Number(process.env.QUOTE_TTL_MS || 60_000);
const NEAR_PRICE = Number(process.env.QUOTE_NEAR_PRICE || 0.06);   // tolérance de confirmation par le cours
const TIMEOUT_MS = Number(process.env.QUOTE_TIMEOUT_MS || 6_000);

const memo = new Map();                  // symbol → { at, quote } — survit tant que l'instance reste chaude
let symbolCache = {};                    // ISIN/ticker → { symbol, confidence } — chargé depuis Firestore par l'appelant
let symbolCacheDirty = false;

function loadSymbolCache(obj) { symbolCache = obj && typeof obj === 'object' ? obj : {}; symbolCacheDirty = false; }
function getSymbolCache() { return symbolCache; }
function symbolCacheChanged() { return symbolCacheDirty; }

/** Suffixes de place par défaut pour les tickers Euronext connus. */
const SUFFIX = { PEA: '.PA' };

async function get(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------
   Fournisseurs
   ------------------------------------------------------------ */

async function yahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const json = await (await get(url)).json();
  const meta = json?.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  if (typeof price !== 'number') throw new Error('cotation absente de la réponse Yahoo');
  return {
    symbol,
    price,
    name: meta.longName || meta.shortName || '',
    previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
    currency: meta.currency || 'EUR',
    at: new Date((meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now())).toISOString(),
    source: 'yahoo'
  };
}

async function stooq(symbol) {
  // SU.PA → su.fr  ·  AAPL → aapl.us
  const base = symbol.replace(/\.(PA|AS|BR|LS)$/i, '').toLowerCase();
  const suffix = /\.(PA|AS|BR|LS)$/i.test(symbol) ? '.fr' : '.us';
  const url = `https://stooq.com/q/l/?s=${encodeURIComponent(base + suffix)}&f=sd2t2ohlcv&h&e=csv`;
  const text = await (await get(url)).text();
  const [head, row] = text.trim().split('\n');
  if (!row) throw new Error('réponse Stooq vide');
  const cols = head.split(',').map(s => s.trim().toLowerCase());
  const vals = row.split(',');
  const close = Number(vals[cols.indexOf('close')]);
  const open = Number(vals[cols.indexOf('open')]);
  if (!Number.isFinite(close)) throw new Error('cotation Stooq indisponible');
  return { symbol, price: close, previousClose: Number.isFinite(open) ? open : null, currency: 'EUR', at: new Date().toISOString(), source: 'stooq' };
}

const PROVIDERS = { yahoo, stooq };
const PRIMARY = process.env.QUOTE_PROVIDER || 'yahoo';

/* ------------------------------------------------------------
   Résolution de symbole
   ------------------------------------------------------------ */

/**
 * Position → symbole de cotation.
 * Un symbole deviné n'est retenu que s'il est confirmé, soit par le libellé,
 * soit par un cours cohérent avec le dernier cours connu de la ligne.
 * @returns {Promise<{symbol:string, confidence:string}|null>}
 */
async function resolveSymbol(pos) {
  const { symbol, ticker, isin, compte, name, price } = pos;
  if (symbol) return { symbol, confidence: 'épinglé' };

  const key = isin || ticker || name;
  if (!key) return null;
  if (symbolCache[key]) return symbolCache[key];

  const candidates = [];
  if (ticker && SUFFIX[compte]) candidates.push({ symbol: ticker + SUFFIX[compte], label: '' });

  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(key)}&quotesCount=6&newsCount=0`;
    const json = await (await get(url)).json();
    for (const q of json?.quotes || []) {
      if (q.symbol && ['EQUITY', 'ETF', 'MUTUALFUND'].includes(q.quoteType)) {
        candidates.push({ symbol: q.symbol, label: q.shortname || q.longname || '' });
      }
    }
  } catch { /* hors ligne ou quota atteint */ }

  for (const c of candidates) {
    let q;
    try { q = await quote(c.symbol); } catch { continue; }
    if (!q || typeof q.price !== 'number') continue;

    const label = q.name || c.label;
    let confidence = null;
    if (name && label && nameMatches(name, label)) confidence = 'libellé';
    else if (typeof price === 'number' && price > 0 && Math.abs(q.price - price) / price <= NEAR_PRICE) confidence = 'cours';
    if (!confidence) continue;

    const resolved = { symbol: c.symbol, confidence };
    symbolCache[key] = resolved;
    symbolCacheDirty = true;
    return resolved;
  }

  return null;
}

const NOISE = new Set(['ucits', 'etf', 'eur', 'usd', 'acc', 'dist', 'c', 'a', 'ae', 'index', 'fund', 'de', 'du', 'la', 'le', 'les', 'swap', 'daily', 'hedged', 'sicav', 'plc', 'sa', 'se', 'nv']);

const tokens = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().split(/[^a-z0-9&+]+/).filter(t => t && !NOISE.has(t));

/**
 * La recherche Yahoo par ISIN renvoie régulièrement un autre fonds du même émetteur
 * (Amundi Global Luxury pour un S&P 500, tranche 1-3Y pour une 5-7Y).
 * On n'accepte un symbole deviné que si le libellé concorde vraiment.
 */
function nameMatches(want, got) {
  if (!got) return false;
  const a = tokens(want), b = new Set(tokens(got));
  if (!a.length) return false;

  const digitsA = a.filter(t => /\d/.test(t));
  const digitsB = [...b].filter(t => /\d/.test(t));
  if (digitsA.length && digitsB.length && !digitsA.some(d => b.has(d))) return false;

  const hits = a.filter(t => b.has(t)).length;
  return hits >= Math.min(2, a.length) && hits / a.length >= 0.4;
}

/* ------------------------------------------------------------
   API publique
   ------------------------------------------------------------ */

/** Cotation d'un symbole, avec cache mémoire TTL et repli fournisseur. */
async function quote(symbol) {
  if (!symbol) return null;
  const hit = memo.get(symbol);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.quote;

  const order = [PRIMARY, ...Object.keys(PROVIDERS).filter(p => p !== PRIMARY)];
  let lastErr;
  for (const name of order) {
    try {
      const q = await PROVIDERS[name](symbol);
      memo.set(symbol, { at: Date.now(), quote: q });
      return q;
    } catch (e) { lastErr = e; }
  }
  const stale = memo.get(symbol);
  if (stale) return { ...stale.quote, stale: true, error: lastErr?.message };
  return { symbol, price: null, error: lastErr?.message || 'indisponible', source: null };
}

/**
 * Cotations pour une liste de positions.
 * @returns {Map<string, object>} clé = isin || ticker || name
 */
async function quoteAll(positions) {
  const out = new Map();
  const jobs = positions.map(async p => {
    const key = p.isin || p.ticker || p.name;

    if (p.manual || (!p.symbol && !p.ticker && !p.isin)) {
      out.set(key, { symbol: null, price: null, manual: true });
      return;
    }

    const resolved = await resolveSymbol(p);
    if (!resolved) {
      out.set(key, { symbol: null, price: null, error: 'symbole non confirmé — épingle-le (pinSymbol)' });
      return;
    }

    const q = await quote(resolved.symbol);
    out.set(key, { ...q, confidence: resolved.confidence, pinned: resolved.confidence === 'épinglé' });
  });
  await Promise.all(jobs);
  return out;
}

function clearCache() { memo.clear(); }

module.exports = {
  quote, quoteAll, resolveSymbol, clearCache, PRIMARY,
  loadSymbolCache, getSymbolCache, symbolCacheChanged
};
