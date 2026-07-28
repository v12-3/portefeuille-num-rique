'use strict';

/**
 * Serveur local du dashboard Patrimoine.
 * - sert public/
 * - /api/import : CSV / XLSX → opérations ou positions
 * - /api/perf   : valorisation du portefeuille avec cotations en direct
 * - /api/stream : flux SSE, une valorisation toutes les REFRESH_MS
 *
 * - /m          : app mobile installable (PWA)
 *
 * Zéro dépendance npm. Écoute sur 127.0.0.1 par défaut ; exposer sur le réseau
 * local (HOST=0.0.0.0, pour installer l'app sur un téléphone) exige un jeton.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const portfolio = require('./lib/portfolio');
const quotes = require('./lib/quotes');
const { parseFile } = require('./lib/importer');
const { appIcon } = require('./lib/png');
const store = require('./lib/store');
const { iso } = require('./lib/util');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const TOKEN = process.env.PATRIMOINE_TOKEN || '';
const REFRESH_MS = Number(process.env.REFRESH_MS || 60_000);
const MAX_UPLOAD = 10 * 1024 * 1024;

const LOOPBACK = ['127.0.0.1', '::1', 'localhost'].includes(HOST);

const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};

/* ------------------------------------------------------------
   Helpers
   ------------------------------------------------------------ */

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function body(req, limit = MAX_UPLOAD) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error(`Fichier trop volumineux (max ${Math.round(limit / 1024 / 1024)} Mo)`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';       // /  et  /m/  → index.html
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC)) { res.writeHead(403).end('Forbidden'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Introuvable : ' + rel); return; }
    const headers = { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' };
    // le service worker doit pouvoir contrôler toute l'étendue /m/
    if (rel.endsWith('sw.js')) headers['Service-Worker-Allowed'] = '/m/';
    res.writeHead(200, headers);
    res.end(data);
  });
}

/** Icônes PWA générées à la volée (pas de binaire dans le dépôt), gardées en mémoire. */
const iconCache = new Map();
function serveIcon(res, size) {
  if (!iconCache.has(size)) iconCache.set(size, appIcon(size));
  const png = iconCache.get(size);
  res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'public, max-age=86400' });
  res.end(png);
}

/** Jeton exigé dès que le serveur n'est plus sur la boucle locale. */
function authorized(req, url) {
  if (!TOKEN) return true;
  const given = req.headers['x-token'] || url.searchParams.get('k');
  return given === TOKEN;
}

/** Valorisation + point d'historique du jour. */
async function snapshot(live = true) {
  const snap = await portfolio.value(portfolio.load(), { live });
  snap.history = portfolio.pushHistory(snap);
  return snap;
}

/* ------------------------------------------------------------
   Routes API
   ------------------------------------------------------------ */

async function handleImport(req, res, url) {
  const filename = req.headers['x-file-name'] ? decodeURIComponent(req.headers['x-file-name']) : (url.searchParams.get('name') || 'import.csv');
  const compte = req.headers['x-compte'] ? decodeURIComponent(req.headers['x-compte']) : url.searchParams.get('compte') || undefined;

  const buf = await body(req);
  if (!buf.length) throw new Error('Fichier vide');

  const parsed = parseFile(buf, filename, { compte });
  const p = portfolio.load();

  const report = { file: filename, kind: parsed.kind, sourceRows: parsed.sourceRows, skipped: parsed.skipped };
  if (parsed.kind === 'operations') Object.assign(report, portfolio.mergeOperations(p, parsed.operations));
  else Object.assign(report, portfolio.mergePositions(p, parsed.positions));

  p.meta ||= {};
  p.meta.imports ||= [];
  p.meta.imports.push({ file: filename, at: new Date().toISOString(), kind: parsed.kind, rows: parsed.operations.length + parsed.positions.length, ok: true });
  p.meta.updatedAt = iso(new Date());
  portfolio.save(p);

  quotes.clearCache();
  json(res, 200, { ok: true, report, snapshot: await snapshot(true) });
}

async function handleBalance(req, res) {
  const payload = JSON.parse((await body(req, 64 * 1024)).toString('utf8') || '{}');
  const { compte, value, taux } = payload;
  if (!compte || typeof value !== 'number') throw new Error('Attendu : { compte, value, taux? }');

  const p = portfolio.load();
  p.balances ||= {};
  p.balances[compte] = { value, taux: taux ?? p.balances[compte]?.taux ?? null, updatedAt: iso(new Date()) };
  portfolio.save(p);
  json(res, 200, { ok: true, snapshot: await snapshot(false) });
}

/** Épingle un symbole de cotation sur une ligne (ISIN, ticker ou nom exact). */
async function handleSymbol(req, res) {
  const { match, symbol, manual } = JSON.parse((await body(req, 64 * 1024)).toString('utf8') || '{}');
  if (!match) throw new Error('Attendu : { match: "<ISIN|ticker|nom>", symbol: "SU.PA" } ou { match, manual: true }');

  const p = portfolio.load();
  const needle = String(match).toUpperCase();
  const hits = p.positions.filter(x =>
    (x.isin || '').toUpperCase() === needle ||
    (x.ticker || '').toUpperCase() === needle ||
    (x.name || '').toUpperCase() === needle
  );
  if (!hits.length) throw new Error(`Aucune ligne ne correspond à « ${match} »`);

  for (const h of hits) {
    if (manual) { h.manual = true; delete h.symbol; }
    else { h.symbol = symbol; delete h.manual; }
  }
  portfolio.save(p);
  quotes.clearCache();
  json(res, 200, { ok: true, updated: hits.map(h => h.name), snapshot: await snapshot(true) });
}

function handleStream(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });

  let closed = false;
  const send = async () => {
    if (closed) return;
    try {
      const snap = await snapshot(true);
      res.write(`event: perf\ndata: ${JSON.stringify(snap)}\n\n`);
    } catch (e) {
      res.write(`event: error\ndata: ${JSON.stringify({ message: e.message })}\n\n`);
    }
  };

  send();
  const timer = setInterval(send, REFRESH_MS);
  const ping = setInterval(() => !closed && res.write(': ping\n\n'), 20_000);
  req.on('close', () => { closed = true; clearInterval(timer); clearInterval(ping); });
}

/* ------------------------------------------------------------
   Routeur
   ------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const route = `${req.method} ${url.pathname}`;

  try {
    if (url.pathname.startsWith('/api/') && !authorized(req, url)) {
      return json(res, 401, { error: 'Jeton manquant ou invalide (X-Token ou ?k=)' });
    }

    switch (route) {
      case 'GET /m/icon-192.png': return serveIcon(res, 192);
      case 'GET /m/icon-512.png': return serveIcon(res, 512);

      case 'GET /api/perf':
        return json(res, 200, await snapshot(url.searchParams.get('live') !== '0'));

      case 'GET /api/portfolio':
        return json(res, 200, portfolio.load());

      case 'GET /api/history':
        return json(res, 200, portfolio.history());

      case 'GET /api/quotes': {
        const symbols = (url.searchParams.get('symbols') || '').split(',').map(s => s.trim()).filter(Boolean);
        return json(res, 200, await Promise.all(symbols.map(s => quotes.quote(s))));
      }

      case 'GET /api/stream':
        return handleStream(req, res);

      case 'POST /api/import':
        return await handleImport(req, res, url);

      case 'POST /api/balance':
        return await handleBalance(req, res);

      case 'POST /api/symbol':
        return await handleSymbol(req, res);

      case 'POST /api/refresh':
        quotes.clearCache();
        return json(res, 200, await snapshot(true));

      default:
        if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'Route inconnue : ' + url.pathname });
        return serveStatic(req, res, url.pathname);
    }
  } catch (e) {
    console.error('[api]', route, '→', e.message);
    json(res, 400, { error: e.message });
  }
});

/** Adresse IPv4 de la machine sur le réseau local, pour l'installation sur téléphone. */
function lanAddress() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return null;
}

// Sans jeton, exposer le portefeuille au réseau local le rendrait lisible et
// modifiable (import de fichiers) par n'importe quelle machine du réseau.
if (!LOOPBACK && !TOKEN) {
  console.error(`Refus de démarrer sur ${HOST} sans jeton.`);
  console.error('  Définis PATRIMOINE_TOKEN=<secret> avant de lancer, ou reste sur HOST=127.0.0.1.');
  process.exit(1);
}

const seeded = store.ensureSeed();
if (seeded.length) console.log(`Premier lancement : ${seeded.join(', ')} initialisé(s) depuis les fichiers d'exemple.`);

server.listen(PORT, HOST, () => {
  const p = portfolio.load();
  console.log(`Patrimoine → http://${LOOPBACK ? '127.0.0.1' : HOST}:${PORT}`);
  console.log(`  ${p.positions.length} ligne(s), ${p.operations.length} opération(s) · cotations : ${quotes.PRIMARY} · rafraîchissement ${REFRESH_MS / 1000}s`);
  if (!LOOPBACK) {
    const ip = lanAddress();
    console.log(`  app mobile : http://${ip || HOST}:${PORT}/m/?k=${TOKEN}`);
    console.log('  (ouvre ce lien sur le téléphone puis « Ajouter à l\'écran d\'accueil »)');
  } else {
    console.log(`  app mobile : http://127.0.0.1:${PORT}/m/  ·  réseau local : HOST=0.0.0.0 PATRIMOINE_TOKEN=<secret> node server.js`);
  }
  if (!fs.existsSync(path.join(store.DATA_DIR, 'portfolio.json'))) console.log('  data/portfolio.json absent → portefeuille vide, importe un fichier pour démarrer');
});
