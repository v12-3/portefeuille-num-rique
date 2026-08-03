/**
 * Cloudflare Worker — proxy de cotations pour l'app Patrimoine.
 *
 * Un navigateur ne peut pas appeler Yahoo Finance directement (pas d'en-têtes
 * CORS côté Yahoo). Ce Worker fait l'appel côté serveur et renvoie le résultat
 * avec les bons en-têtes CORS. Il est gratuit (Cloudflare Workers, 100 000
 * requêtes/jour sans carte bancaire) et sans état : le cache des symboles
 * résolus est géré par le client dans Firestore, pas ici.
 *
 * Logique de résolution/cotation identique à functions/lib/quotes.js.
 *
 * Déploiement (le plus simple, sans outil) :
 *   dash.cloudflare.com → Workers & Pages → Create → Create Worker →
 *   remplace le code par défaut par CE fichier → Deploy.
 *   Note l'URL affichée (https://<nom>.<compte>.workers.dev) et colle-la dans
 *   public/firebase-config.js → window.QUOTES_WORKER_URL.
 *
 * API :
 *   POST /  body = [{ key, symbol?, isin?, ticker?, name?, price?, compte? }]
 *   → 200  { [key]: { symbol, price, previousClose, currency, at, source,
 *                     confidence, error?, manual? } }
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) patrimoine-worker/1.0';
const NEAR_PRICE = 0.06;
const TIMEOUT_MS = 6000;
const SUFFIX = { PEA: '.PA' };

/*
 * Origines autorisées à appeler ce Worker. Sans liste, n'importe quel site
 * pourrait l'utiliser comme proxy gratuit vers Yahoo et consommer le quota.
 * Ajoute ici tout nouveau domaine servant l'application.
 */
const ALLOWED_ORIGINS = [
  'https://portefeuille-d10c5.web.app',
  'https://portefeuille-d10c5.firebaseapp.com',
  'http://localhost:4173',
  'http://127.0.0.1:4173'
];

function corsFor(request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

export default {
  async fetch(request) {
    const CORS = corsFor(request);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') {
      return json({ error: 'POST attendu : corps = liste de positions à coter' }, 405, CORS);
    }
    let positions;
    try {
      positions = await request.json();
      if (!Array.isArray(positions)) throw new Error('corps invalide');
    } catch {
      return json({ error: 'JSON invalide (attendu : tableau de positions)' }, 400, CORS);
    }
    if (positions.length > 200) return json({ error: 'trop de lignes (max 200)' }, 400, CORS);

    const memo = new Map();          // symbol → quote, sur la durée de la requête
    const out = {};
    await Promise.all(positions.map(async (p) => {
      const key = p.key || p.isin || p.ticker || p.name;
      if (!key) return;
      try {
        const resolved = await resolveSymbol(p, memo);
        if (!resolved) { out[key] = { symbol: null, price: null, error: 'symbole non confirmé' }; return; }
        const q = await quote(resolved.symbol, memo);
        out[key] = { ...q, confidence: resolved.confidence };
      } catch (e) {
        out[key] = { symbol: null, price: null, error: e.message || 'erreur' };
      }
    }));
    return json(out, 200, CORS);
  }
};

function json(body, status = 200, cors = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors }
  });
}

async function get(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- fournisseurs ---------- */
async function yahoo(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`;
  const j = await (await get(url)).json();
  const meta = j?.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  if (typeof price !== 'number') throw new Error('cotation absente de la réponse Yahoo');
  return {
    symbol, price, name: meta.longName || meta.shortName || '',
    previousClose: meta.chartPreviousClose ?? meta.previousClose ?? null,
    currency: meta.currency || 'EUR',
    at: new Date(meta.regularMarketTime ? meta.regularMarketTime * 1000 : Date.now()).toISOString(),
    source: 'yahoo'
  };
}
async function stooq(symbol) {
  const base = symbol.replace(/\.(PA|AS|BR|LS)$/i, '').toLowerCase();
  const suffix = /\.(PA|AS|BR|LS)$/i.test(symbol) ? '.fr' : '.us';
  const text = await (await get(`https://stooq.com/q/l/?s=${encodeURIComponent(base + suffix)}&f=sd2t2ohlcv&h&e=csv`)).text();
  const [head, row] = text.trim().split('\n');
  if (!row) throw new Error('réponse Stooq vide');
  const cols = head.split(',').map(s => s.trim().toLowerCase());
  const vals = row.split(',');
  const close = Number(vals[cols.indexOf('close')]);
  const open = Number(vals[cols.indexOf('open')]);
  if (!Number.isFinite(close)) throw new Error('cotation Stooq indisponible');
  return { symbol, price: close, previousClose: Number.isFinite(open) ? open : null, currency: 'EUR', at: new Date().toISOString(), source: 'stooq' };
}
const PROVIDERS = [yahoo, stooq];

async function quote(symbol, memo) {
  if (!symbol) return null;
  if (memo.has(symbol)) return memo.get(symbol);
  let lastErr;
  for (const provider of PROVIDERS) {
    try { const q = await provider(symbol); memo.set(symbol, q); return q; }
    catch (e) { lastErr = e; }
  }
  const q = { symbol, price: null, error: lastErr?.message || 'indisponible', source: null };
  memo.set(symbol, q);
  return q;
}

/* ---------- résolution de symbole ---------- */
async function resolveSymbol(pos, memo) {
  const { symbol, ticker, isin, compte, name, price } = pos;
  if (symbol) return { symbol, confidence: 'épinglé' };
  const key = isin || ticker || name;
  if (!key) return null;

  const candidates = [];
  if (ticker && SUFFIX[compte]) candidates.push({ symbol: ticker + SUFFIX[compte], label: '' });
  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(key)}&quotesCount=6&newsCount=0`;
    const j = await (await get(url)).json();
    for (const q of j?.quotes || []) {
      if (q.symbol && ['EQUITY', 'ETF', 'MUTUALFUND'].includes(q.quoteType)) {
        candidates.push({ symbol: q.symbol, label: q.shortname || q.longname || '' });
      }
    }
  } catch { /* hors ligne ou quota */ }

  for (const c of candidates) {
    let q;
    try { q = await quote(c.symbol, memo); } catch { continue; }
    if (!q || typeof q.price !== 'number') continue;
    const label = q.name || c.label;
    let confidence = null;
    if (name && label && nameMatches(name, label)) confidence = 'libellé';
    else if (typeof price === 'number' && price > 0 && Math.abs(q.price - price) / price <= NEAR_PRICE) confidence = 'cours';
    if (confidence) return { symbol: c.symbol, confidence };
  }
  return null;
}

const NOISE = new Set(['ucits', 'etf', 'eur', 'usd', 'acc', 'dist', 'c', 'a', 'ae', 'index', 'fund', 'de', 'du', 'la', 'le', 'les', 'swap', 'daily', 'hedged', 'sicav', 'plc', 'sa', 'se', 'nv']);
const tokens = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9&+]+/).filter(t => t && !NOISE.has(t));
function nameMatches(want, got) {
  if (!got) return false;
  const a = tokens(want), b = new Set(tokens(got));
  if (!a.length) return false;
  const digitsA = a.filter(t => /\d/.test(t)), digitsB = [...b].filter(t => /\d/.test(t));
  if (digitsA.length && digitsB.length && !digitsA.some(d => b.has(d))) return false;
  const hits = a.filter(t => b.has(t)).length;
  return hits >= Math.min(2, a.length) && hits / a.length >= 0.4;
}
