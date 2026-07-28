'use strict';

/** Retire accents + casse pour comparer des en-têtes de colonnes. */
function slug(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

const SPACES = /[\s   ]/g;

/**
 * Parse un nombre écrit en FR ou EN.
 * "1 234,56" · "1.234,56" · "1,234.56" · "−516,56" · "(120,50)" → -120.5
 */
function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  let s = String(v).replace(SPACES, '').replace(/[€$£%]/g, '').replace(/−/g, '-');
  if (!s) return null;
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  const dot = s.lastIndexOf('.'), comma = s.lastIndexOf(',');
  if (dot >= 0 && comma >= 0) {
    // le séparateur le plus à droite est le décimal
    if (comma > dot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (comma >= 0) {
    // une seule virgule : décimale, sauf motif de milliers 1,234
    s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (dot >= 0) {
    if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/** Sérial Excel → Date UTC (gère le bug d'année bissextile 1900). */
function fromExcelSerial(n) {
  return new Date(EXCEL_EPOCH + Math.round(n) * 86400000);
}

/**
 * Parse une date en ISO `YYYY-MM-DD`.
 * Accepte dd/mm/yyyy, dd-mm-yyyy, yyyy-mm-dd, dd.mm.yy et les sérials Excel.
 */
function date(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return iso(v);
  if (typeof v === 'number' || /^\d{5}(\.\d+)?$/.test(String(v).trim())) {
    const n = Number(v);
    if (n > 20000 && n < 60000) return iso(fromExcelSerial(n));
  }
  const s = String(v).trim();
  let m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(s);
  if (m) return pad(m[1], m[2], m[3]);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/.exec(s);
  if (m) {
    let y = m[3];
    if (y.length === 2) y = (Number(y) > 70 ? '19' : '20') + y;
    return pad(y, m[2], m[1]);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : iso(d);
}

const pad = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const iso = d => d.toISOString().slice(0, 10);

/** `2026-07-17` → `17/07/2026` */
const frDate = s => (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? s.slice(8) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : (s || '');

const eur = n => n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const eur0 = n => Math.round(n).toLocaleString('fr-FR') + ' €';
const pct2 = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' %';
const signedEur = n => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';

const round2 = n => Math.round(n * 100) / 100;

module.exports = { slug, num, date, frDate, iso, fromExcelSerial, eur, eur0, pct2, signedEur, round2 };
