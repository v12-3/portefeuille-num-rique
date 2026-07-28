'use strict';

/**
 * Cloud Functions du dashboard Patrimoine.
 * Remplace les routes /api/* du serveur local : même logique métier
 * (functions/lib/*, portés depuis lib/* sans changement de comportement),
 * mais les données vivent dans Firestore (users/{uid}/...) au lieu d'un
 * fichier JSON local, et chaque appel est authentifié (Firebase Auth) au
 * lieu du jeton LAN.
 *
 * Schéma Firestore :
 *   users/{uid}/portfolio/main        { meta, balances, cash, positions[], operations[] }
 *   users/{uid}/portfolio/snapshot    dernière valorisation calculée
 *   users/{uid}/portfolio/symbolCache { map: { isin: {symbol, confidence} } }
 *   users/{uid}/history/{yyyy-mm-dd}  un point par jour
 *
 * Le client lit portfolio/snapshot et history/* directement via le SDK
 * Firestore (onSnapshot, temps réel, hors-ligne géré nativement) ; il
 * n'appelle ces functions que pour les écritures qui exigent la logique
 * métier serveur (import, revalorisation avec cotations, etc.).
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

const { parseFile } = require('./lib/importer');
const portfolioLib = require('./lib/portfolio');
const quotes = require('./lib/quotes');

admin.initializeApp();
const db = admin.firestore();

// europe-west1 (Belgique) : région Firebase la plus proche pour un usage France/Europe.
setGlobalOptions({ region: 'europe-west1', maxInstances: 10 });

const MAX_UPLOAD = 10 * 1024 * 1024; // 10 Mo décodés (le payload base64 fait ~1,33×)

function requireAuth(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Connexion requise.');
  return request.auth.uid;
}

const portfolioDoc = uid => db.doc(`users/${uid}/portfolio/main`);
const snapshotDoc = uid => db.doc(`users/${uid}/portfolio/snapshot`);
const symbolCacheDoc = uid => db.doc(`users/${uid}/portfolio/symbolCache`);
const historyCol = uid => db.collection(`users/${uid}/history`);

async function loadPortfolio(uid) {
  const snap = await portfolioDoc(uid).get();
  if (!snap.exists) return structuredClone(portfolioLib.EMPTY);
  const data = snap.data();
  return {
    meta: data.meta || { imports: [] },
    balances: data.balances || {},
    cash: data.cash || {},
    positions: data.positions || [],
    operations: data.operations || []
  };
}

const savePortfolio = (uid, portfolio) => portfolioDoc(uid).set(portfolio);

/** Valorise avec cotations en direct, écrit l'instantané + le point d'historique du jour. */
async function revalue(uid, portfolio, { live = true } = {}) {
  const cacheSnap = await symbolCacheDoc(uid).get();
  quotes.loadSymbolCache(cacheSnap.exists ? cacheSnap.data().map : {});

  const snapshot = await portfolioLib.value(portfolio, { live });

  if (quotes.symbolCacheChanged()) {
    await symbolCacheDoc(uid).set({ map: quotes.getSymbolCache() });
  }
  await snapshotDoc(uid).set(snapshot);

  const today = snapshot.asOf.slice(0, 10);
  const comptes = {};
  for (const [name, c] of Object.entries(snapshot.comptes)) comptes[name] = { value: c.value, mise: c.mise };
  await historyCol(uid).doc(today).set({ date: today, val: snapshot.totals.patrimoine, cap: snapshot.totals.capital, comptes });

  return snapshot;
}

/* ============================================================
   importFile — CSV / XLSX → opérations ou positions
   ============================================================ */
exports.importFile = onCall({ cors: true }, async (request) => {
  const uid = requireAuth(request);
  const { filename, contentBase64, compte } = request.data || {};
  if (!filename || !contentBase64) throw new HttpsError('invalid-argument', 'Attendu : { filename, contentBase64 }');

  const buf = Buffer.from(contentBase64, 'base64');
  if (buf.length > MAX_UPLOAD) throw new HttpsError('invalid-argument', `Fichier trop volumineux (max ${MAX_UPLOAD / 1024 / 1024} Mo)`);
  if (!buf.length) throw new HttpsError('invalid-argument', 'Fichier vide');

  let parsed;
  try {
    parsed = parseFile(buf, filename, { compte });
  } catch (e) {
    throw new HttpsError('invalid-argument', e.message);
  }

  const portfolio = await loadPortfolio(uid);
  const report = { file: filename, kind: parsed.kind, sourceRows: parsed.sourceRows, skipped: parsed.skipped };
  if (parsed.kind === 'operations') Object.assign(report, portfolioLib.mergeOperations(portfolio, parsed.operations));
  else Object.assign(report, portfolioLib.mergePositions(portfolio, parsed.positions));

  portfolio.meta ||= { imports: [] };
  portfolio.meta.imports ||= [];
  portfolio.meta.imports.push({ file: filename, at: new Date().toISOString(), kind: parsed.kind, rows: parsed.operations.length + parsed.positions.length, ok: true });
  portfolio.meta.updatedAt = new Date().toISOString().slice(0, 10);

  await savePortfolio(uid, portfolio);
  quotes.clearCache();

  let snapshot;
  try {
    snapshot = await revalue(uid, portfolio, { live: true });
  } catch (e) {
    logger.error('revalue after import failed', e);
    throw new HttpsError('internal', 'Import enregistré mais la revalorisation a échoué : ' + e.message);
  }
  return { ok: true, report, snapshot };
});

/* ============================================================
   refreshPerf — revalorise avec cotations fraîches
   ============================================================ */
exports.refreshPerf = onCall({ cors: true }, async (request) => {
  const uid = requireAuth(request);
  const live = request.data?.live !== false;
  const portfolio = await loadPortfolio(uid);
  if (live) quotes.clearCache();
  return revalue(uid, portfolio, { live });
});

/* ============================================================
   updateBalance — solde d'un livret / compte garanti
   ============================================================ */
exports.updateBalance = onCall({ cors: true }, async (request) => {
  const uid = requireAuth(request);
  const { compte, value, taux } = request.data || {};
  if (!compte || typeof value !== 'number') throw new HttpsError('invalid-argument', 'Attendu : { compte, value, taux? }');

  const portfolio = await loadPortfolio(uid);
  portfolio.balances ||= {};
  portfolio.balances[compte] = { value, taux: taux ?? portfolio.balances[compte]?.taux ?? null, updatedAt: new Date().toISOString().slice(0, 10) };
  await savePortfolio(uid, portfolio);

  return revalue(uid, portfolio, { live: false });
});

/* ============================================================
   pinSymbol — fige/débranche la cotation d'une ligne
   ============================================================ */
exports.pinSymbol = onCall({ cors: true }, async (request) => {
  const uid = requireAuth(request);
  const { match, symbol, manual } = request.data || {};
  if (!match) throw new HttpsError('invalid-argument', 'Attendu : { match, symbol } ou { match, manual: true }');

  const portfolio = await loadPortfolio(uid);
  const needle = String(match).toUpperCase();
  const hits = portfolio.positions.filter(x =>
    (x.isin || '').toUpperCase() === needle ||
    (x.ticker || '').toUpperCase() === needle ||
    (x.name || '').toUpperCase() === needle
  );
  if (!hits.length) throw new HttpsError('not-found', `Aucune ligne ne correspond à « ${match} »`);

  for (const h of hits) {
    if (manual) { h.manual = true; delete h.symbol; }
    else { h.symbol = symbol; delete h.manual; }
  }
  await savePortfolio(uid, portfolio);
  quotes.clearCache();

  const snapshot = await revalue(uid, portfolio, { live: true });
  return { ok: true, updated: hits.map(h => h.name), snapshot };
});
