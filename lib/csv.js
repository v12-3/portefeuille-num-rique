'use strict';

/**
 * Parseur CSV/TSV (RFC 4180 + guillemets doublés), détection auto du séparateur.
 * Retourne { header:[string], rows:[[string]] }.
 */
function parseCsv(text) {
  let s = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const delim = detectDelimiter(s);

  const rows = [];
  let row = [], field = '', quoted = false;

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') { quoted = true; continue; }
    if (c === delim) { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  const clean = rows
    .map(r => r.map(f => f.trim()))
    .filter(r => r.some(f => f !== ''));

  if (!clean.length) return { header: [], rows: [] };
  return { header: clean[0], rows: clean.slice(1) };
}

/** Compte les séparateurs candidats hors guillemets sur les 5 premières lignes. */
function detectDelimiter(s) {
  const sample = s.split('\n').slice(0, 5).join('\n');
  const cands = [';', ',', '\t', '|'];
  let best = ';', bestScore = -1;
  for (const d of cands) {
    let count = 0, quoted = false;
    for (let i = 0; i < sample.length; i++) {
      const c = sample[i];
      if (c === '"') quoted = !quoted;
      else if (c === d && !quoted) count++;
    }
    if (count > bestScore) { bestScore = count; best = d; }
  }
  return bestScore > 0 ? best : ';';
}

module.exports = { parseCsv };
