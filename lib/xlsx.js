'use strict';

const zlib = require('zlib');

/* ============================================================
   Lecture ZIP minimale (stored + deflate), sans dépendance
   ============================================================ */

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;

function readZip(buf) {
  // End of central directory : on remonte depuis la fin (commentaire max 64 Ko)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Archive ZIP invalide (fin de répertoire central introuvable)');

  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(off) !== CEN_SIG) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);

    // en-tête local : 30 octets fixes + nom + extra (longueurs propres au local)
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const start = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);

    files.set(name, () => method === 0 ? raw : zlib.inflateRawSync(raw));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

/* ============================================================
   XML : extraction sans parseur DOM
   ============================================================ */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? m;
  });
}

/** Texte de tous les <t> d'un fragment, concaténé (gère les runs <r><t>). */
function textOf(xml) {
  let out = '';
  const re = /<t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/t>)/g;
  let m;
  while ((m = re.exec(xml))) out += decode(m[1] ?? '');
  return out;
}

function sharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  const re = /<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) out.push(textOf(m[1]));
  return out;
}

/** "BC12" → 54 (index de colonne 0-based) */
function colIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref);
  if (!letters) return 0;
  let n = 0;
  for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/* ============================================================
   Feuille → tableau de lignes
   ============================================================ */

function parseSheet(xml, strings) {
  const rows = [];
  const rowRe = /<row(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/row>)/g;
  let rm;
  while ((rm = rowRe.exec(xml))) {
    const inner = rm[1] || '';
    const cells = [];
    const cellRe = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    let cm;
    while ((cm = cellRe.exec(inner))) {
      const attrs = cm[1] || '';
      const body = cm[2] || '';
      const ref = /r="([A-Z]+\d+)"/.exec(attrs);
      const type = /t="([^"]+)"/.exec(attrs);
      const idx = ref ? colIndex(ref[1]) : cells.length;

      let value = '';
      const t = type ? type[1] : 'n';
      if (t === 's') {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = v ? (strings[Number(v[1])] ?? '') : '';
      } else if (t === 'inlineStr') {
        value = textOf(body);
      } else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body);
        value = v ? decode(v[1]) : '';
        if (t === 'n' && value !== '') {
          const n = Number(value);
          if (Number.isFinite(n)) value = n;
        }
      }
      cells[idx] = value;
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}

/** Nom de la 1re feuille dans l'ordre du classeur → chemin du XML. */
function firstSheetPath(files) {
  const wb = files.get('xl/workbook.xml');
  const rels = files.get('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const wbXml = wb().toString('utf8');
    const relsXml = rels().toString('utf8');
    const sheet = /<sheet\s[^>]*?r:id="([^"]+)"[^>]*\/?>/.exec(wbXml);
    if (sheet) {
      const rel = new RegExp(`<Relationship[^>]*Id="${sheet[1]}"[^>]*Target="([^"]+)"`).exec(relsXml);
      if (rel) {
        let target = rel[1].replace(/^\//, '');
        if (!target.startsWith('xl/')) target = 'xl/' + target;
        if (files.has(target)) return target;
      }
    }
  }
  for (const name of files.keys()) if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) return name;
  throw new Error('Aucune feuille trouvée dans le classeur');
}

/**
 * Parse un .xlsx (Buffer) → { header:[string], rows:[[string|number]] }.
 * Ignore les lignes vides en tête et prend la première ligne remplie comme en-tête.
 */
function parseXlsx(buf) {
  const files = readZip(buf);
  const ss = files.get('xl/sharedStrings.xml');
  const strings = sharedStrings(ss ? ss().toString('utf8') : null);
  const sheetXml = files.get(firstSheetPath(files))().toString('utf8');

  const all = parseSheet(sheetXml, strings)
    .filter(r => r.some(c => c !== '' && c != null));
  if (!all.length) return { header: [], rows: [] };

  // en-tête = première ligne comptant au moins 2 cellules texte
  let h = 0;
  for (let i = 0; i < Math.min(all.length, 20); i++) {
    const textCells = all[i].filter(c => typeof c === 'string' && c.trim() !== '').length;
    if (textCells >= 2) { h = i; break; }
  }
  return { header: all[h].map(c => String(c ?? '').trim()), rows: all.slice(h + 1) };
}

module.exports = { parseXlsx, readZip };
