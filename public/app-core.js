/**
 * Cœur métier côté navigateur — parsing CSV/XLSX, mapping des colonnes,
 * valorisation du portefeuille. Portage des modules Node lib/*.js et
 * functions/lib/*.js vers des API 100 % web (Uint8Array, DataView,
 * TextDecoder, DecompressionStream), pour tourner dans le navigateur sans
 * Buffer ni zlib.
 *
 * Pourquoi ici et pas dans une Cloud Function : le forfait gratuit Firebase
 * (Spark) n'autorise pas les Cloud Functions. En calculant la valorisation
 * dans le navigateur, l'app reste gratuite sans carte bancaire. Les cotations,
 * elles, passent par un petit service Cloudflare Worker (voir worker/), car un
 * navigateur ne peut pas appeler Yahoo directement (CORS).
 *
 * Expose window.PatrimoineCore. Reste identique en logique à functions/lib/* —
 * si les règles de parsing ou de valorisation changent, garder les trois copies
 * (lib/, functions/lib/, ce fichier) synchronisées.
 */
(function (glob) {
  'use strict';

  /* ============================================================
     util
     ============================================================ */
  function slug(s) {
    return String(s ?? '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  const SPACES = /[\s   ]/g;

  function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (v == null) return null;
    let s = String(v).replace(SPACES, '').replace(/[€$£%]/g, '').replace(/−/g, '-');
    if (!s) return null;
    let neg = false;
    if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
    const dot = s.lastIndexOf('.'), comma = s.lastIndexOf(',');
    if (dot >= 0 && comma >= 0) {
      if (comma > dot) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
    } else if (comma >= 0) {
      s = /^-?\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
    } else if (dot >= 0) {
      if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
    }
    const n = Number(s);
    if (!Number.isFinite(n)) return null;
    return neg ? -n : n;
  }

  const EXCEL_EPOCH = Date.UTC(1899, 11, 30);
  const fromExcelSerial = n => new Date(EXCEL_EPOCH + Math.round(n) * 86400000);
  const pad = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const iso = d => d.toISOString().slice(0, 10);

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

  const frDate = s => (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) ? s.slice(8) + '/' + s.slice(5, 7) + '/' + s.slice(0, 4) : (s || '');
  const round2 = n => Math.round(n * 100) / 100;

  /* ============================================================
     CSV / TSV (RFC 4180, séparateur auto)
     ============================================================ */
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

  function parseCsv(text) {
    let s = String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
    const delim = detectDelimiter(s);
    const rows = [];
    let row = [], field = '', quoted = false;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (quoted) {
        if (c === '"') { if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
        else field += c;
        continue;
      }
      if (c === '"' && field === '') { quoted = true; continue; }
      if (c === delim) { row.push(field); field = ''; continue; }
      if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
      field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    const clean = rows.map(r => r.map(f => f.trim())).filter(r => r.some(f => f !== ''));
    if (!clean.length) return { header: [], rows: [] };
    return { header: clean[0], rows: clean.slice(1) };
  }

  /* ============================================================
     XLSX (ZIP + XML) — version navigateur : DataView + DecompressionStream
     ============================================================ */
  const EOCD_SIG = 0x06054b50, CEN_SIG = 0x02014b50;
  const decoder = new TextDecoder('utf-8');
  const u32 = (dv, i) => dv.getUint32(i, true);
  const u16 = (dv, i) => dv.getUint16(i, true);

  async function inflateRaw(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  function readZipIndex(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65535); i--) {
      if (u32(dv, i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Archive ZIP invalide (fin de répertoire central introuvable)');

    const count = u16(dv, eocd + 10);
    let off = u32(dv, eocd + 16);
    const entries = new Map();
    for (let i = 0; i < count; i++) {
      if (u32(dv, off) !== CEN_SIG) break;
      const method = u16(dv, off + 10);
      const compSize = u32(dv, off + 20);
      const nameLen = u16(dv, off + 28);
      const extraLen = u16(dv, off + 30);
      const commentLen = u16(dv, off + 32);
      const localOff = u32(dv, off + 42);
      const name = decoder.decode(u8.subarray(off + 46, off + 46 + nameLen));

      const lNameLen = u16(dv, localOff + 26);
      const lExtraLen = u16(dv, localOff + 28);
      const start = localOff + 30 + lNameLen + lExtraLen;
      entries.set(name, { method, raw: u8.subarray(start, start + compSize) });
      off += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  }

  async function entryBytes(entry) {
    return entry.method === 0 ? entry.raw : inflateRaw(entry.raw);
  }
  async function entryText(entries, name) {
    const e = entries.get(name);
    if (!e) return null;
    return decoder.decode(await entryBytes(e));
  }

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function xmlDecode(s) {
    return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
      return ENTITIES[e] ?? m;
    });
  }
  function textOf(xml) {
    let out = '';
    const re = /<t(?:\s[^>]*)?(?:\/>|>([\s\S]*?)<\/t>)/g;
    let m;
    while ((m = re.exec(xml))) out += xmlDecode(m[1] ?? '');
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
  function colIndex(ref) {
    const letters = /^([A-Z]+)/.exec(ref);
    if (!letters) return 0;
    let n = 0;
    for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n - 1;
  }
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
        const attrs = cm[1] || '', body = cm[2] || '';
        const ref = /r="([A-Z]+\d+)"/.exec(attrs);
        const type = /t="([^"]+)"/.exec(attrs);
        const idx = ref ? colIndex(ref[1]) : cells.length;
        let value = '';
        const t = type ? type[1] : 'n';
        if (t === 's') {
          const vv = /<v>([\s\S]*?)<\/v>/.exec(body);
          value = vv ? (strings[Number(vv[1])] ?? '') : '';
        } else if (t === 'inlineStr') {
          value = textOf(body);
        } else {
          const vv = /<v>([\s\S]*?)<\/v>/.exec(body);
          value = vv ? xmlDecode(vv[1]) : '';
          if (t === 'n' && value !== '') { const n = Number(value); if (Number.isFinite(n)) value = n; }
        }
        cells[idx] = value;
      }
      for (let i = 0; i < cells.length; i++) if (cells[i] === undefined) cells[i] = '';
      rows.push(cells);
    }
    return rows;
  }
  async function firstSheetName(entries) {
    const wb = await entryText(entries, 'xl/workbook.xml');
    const rels = await entryText(entries, 'xl/_rels/workbook.xml.rels');
    if (wb && rels) {
      const sheet = /<sheet\s[^>]*?r:id="([^"]+)"[^>]*\/?>/.exec(wb);
      if (sheet) {
        const rel = new RegExp(`<Relationship[^>]*Id="${sheet[1]}"[^>]*Target="([^"]+)"`).exec(rels);
        if (rel) {
          let target = rel[1].replace(/^\//, '');
          if (!target.startsWith('xl/')) target = 'xl/' + target;
          if (entries.has(target)) return target;
        }
      }
    }
    for (const name of entries.keys()) if (/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) return name;
    throw new Error('Aucune feuille trouvée dans le classeur');
  }

  async function parseXlsx(u8) {
    const entries = readZipIndex(u8);
    const strings = sharedStrings(await entryText(entries, 'xl/sharedStrings.xml'));
    const sheetXml = await entryText(entries, await firstSheetName(entries));
    const all = parseSheet(sheetXml, strings).filter(r => r.some(c => c !== '' && c != null));
    if (!all.length) return { header: [], rows: [] };
    let h = 0;
    for (let i = 0; i < Math.min(all.length, 20); i++) {
      const textCells = all[i].filter(c => typeof c === 'string' && c.trim() !== '').length;
      if (textCells >= 2) { h = i; break; }
    }
    return { header: all[h].map(c => String(c ?? '').trim()), rows: all.slice(h + 1) };
  }

  /* ============================================================
     Import — reconnaissance des colonnes, lignes → entités
     ============================================================ */
  // Libellés de colonnes acceptés, accents et casse ignorés (voir slug()).
  // Couvre les exports Bourse Direct, Boursorama, Fortuneo, Degiro, Trade
  // Republic, Linxea/Spirica, ainsi que les en-têtes anglais courants.
  const FIELDS = {
    date:    ['date', 'date operation', 'date d operation', 'date de l operation', 'date d execution', 'date d execution ordre',
              'date valeur', 'date de valeur', 'date comptable', 'date de transaction', 'date transaction', 'date de negociation',
              'jour', 'day', 'trade date', 'value date', 'datetime'],
    compte:  ['compte', 'enveloppe', 'portefeuille', 'contrat', 'support fiscal', 'account', 'numero de compte',
              'compte titre', 'type de compte', 'nom du contrat', 'reference contrat'],
    type:    ['type', 'nature', 'operation', 'sens', 'libelle operation', 'mouvement', 'nature de l operation',
              'type d operation', 'type de mouvement', 'transaction type', 'transaction'],
    libelle: ['libelle', 'libelle complet', 'libelle de l operation', 'description', 'designation', 'intitule', 'nom',
              'support', 'nom du support', 'valeur', 'nom de la valeur', 'produit', 'instrument', 'label', 'name'],
    montant: ['montant', 'montant net', 'montant brut', 'montant eur', 'montant total', 'montant de l operation',
              'montant en euros', 'amount', 'total', 'net', 'debit credit', 'credit debit'],
    ticker:  ['ticker', 'symbole', 'symbol', 'mnemo', 'mnemonique', 'code valeur', 'code mnemonique'],
    isin:    ['isin', 'code isin', 'isin code', 'identifiant isin'],
    qty:     ['quantite', 'qte', 'qty', 'quantity', 'nombre de parts', 'nombre d unites de compte', 'parts', 'nb parts',
              'nombre de titres', 'nombre', 'shares', 'units'],
    pru:     ['pru', 'prm', 'prix de revient', 'prix de revient unitaire', 'prix moyen', 'prix moyen pondere',
              'prix moyen d achat', 'prix d achat', 'pmp', 'cout unitaire', 'prix unitaire moyen', 'average price'],
    price:   ['cours', 'cours de bourse', 'cours actuel', 'cotation', 'derniere cotation', 'dernier cours',
              'valeur liquidative', 'vl', 'prix', 'cours de cloture', 'last price', 'price', 'close'],
    amount:  ['montant', 'valorisation', 'valorisation en euros', 'valeur de rachat', 'contre valeur', 'contre valeur en euros',
              'montant investi', 'solde', 'market value'],
    cat:     ['categorie', 'classe', 'classe d actifs', 'type de support', 'poche', 'secteur', 'asset class']
  };

  // Ordre de priorité : un champ précis (isin) est attribué avant un champ
  // générique (ticker), sinon « Code ISIN » finirait aussi dans le ticker.
  // `montant` avant `amount` : les deux acceptent le libellé « Montant », mais
  // c'est `montant` qui identifie un fichier d'opérations (cf. detectKind).
  const FIELD_ORDER = ['isin', 'date', 'compte', 'type', 'qty', 'pru', 'price', 'montant', 'amount', 'ticker', 'cat', 'libelle'];

  function mapColumns(header) {
    const map = {};
    const slugs = header.map(slug);
    const taken = new Set();                       // une colonne ne sert qu'un seul champ

    const claim = (field, idx) => { map[field] = idx; taken.add(idx); };
    const fields = [...FIELD_ORDER.filter(f => f in FIELDS), ...Object.keys(FIELDS).filter(f => !FIELD_ORDER.includes(f))];

    // 1er passage : correspondance exacte du libellé de colonne
    for (const field of fields) {
      if (field in map) continue;
      const idx = slugs.findIndex((h, i) => h && !taken.has(i) && FIELDS[field].includes(h));
      if (idx >= 0) claim(field, idx);
    }
    // 2e passage : correspondance par préfixe (« montant net de frais »…)
    for (const field of fields) {
      if (field in map) continue;
      const idx = slugs.findIndex((h, i) => h && !taken.has(i) && FIELDS[field].some(n => h.startsWith(n)));
      if (idx >= 0) claim(field, idx);
    }
    // `amount` (valorisation) et `montant` partagent des libellés : si seul
    // `montant` a été trouvé sur un fichier de positions, il fait office de montant.
    if (map.amount == null && map.montant != null && map.qty != null) map.amount = map.montant;
    return map;
  }
  const cell = (row, i) => (i == null || row[i] == null) ? '' : row[i];

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
  function normCompte(raw, fallback) {
    const s = slug(raw);
    if (!s) return fallback || 'PEA';
    if (/(pea|bourse direct|compte titre|cto)/.test(s)) return 'PEA';
    if (/(assurance vie|^av$|linxea|spirit|spirica|contrat)/.test(s)) return 'Assurance Vie';
    if (/(livret|ldds|lep|epargne reglementee)/.test(s)) return 'Livret A';
    return raw.trim();
  }

  /* ============================================================
     Reconnaissance par le contenu

     Quand les en-têtes ne ressemblent à rien de connu (colonnes en langue
     étrangère, intitulés maison, export sans en-tête), on déduit le rôle de
     chaque colonne en observant les valeurs : dates, codes ISIN, montants
     signés, quantités, libellés. Complète le mapping par libellé, sans jamais
     l'écraser.
     ============================================================ */

  const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;
  const COMPTE_RE = /(pea|assurance|^av$|linxea|spirit|livret|ldds|lep|cto|compte titre|bourse direct)/i;
  const TYPE_RE = /(achat|vente|buy|sell|versement|virement|dividende|coupon|interet|intérêt|retrait|souscription|arbitrage|apport|depot|dépôt)/i;

  /**
   * Une valeur ressemble-t-elle vraiment à une date ?
   * date() est volontairement permissif (il finit par `new Date(s)`), au point
   * d'accepter « 4 » ou « 5 » : une colonne de quantités passait pour des dates.
   * Ici on exige une forme datée explicite, ou un sérial Excel plausible.
   */
  function looksLikeDate(s) {
    const t = String(s).trim();
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(t)) return true;            // 2026-07-17
    if (/^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/.test(t)) return true;        // 17/07/2026
    if (/^\d{5}(\.\d+)?$/.test(t)) { const n = Number(t); return n > 20000 && n < 60000; }
    if (/[a-zéûà]{3,}/i.test(t) && !Number.isNaN(Date.parse(t))) return true;  // « 17 juil. 2026 »
    return false;
  }

  /** Profil statistique d'une colonne sur un échantillon de lignes. */
  function profile(rows, idx, sample = 60) {
    const vals = rows.slice(0, sample).map(r => cell(r, idx)).filter(v => v !== '' && v != null);
    if (!vals.length) return null;
    const strs = vals.map(v => String(v).trim());
    const nums = vals.map(num).filter(n => n != null);
    const dates = strs.filter(s => looksLikeDate(s) && date(s));
    const ratio = n => n / vals.length;
    return {
      idx, count: vals.length,
      dateRatio: ratio(dates.length),
      numRatio: ratio(nums.length),
      isinRatio: ratio(strs.filter(s => ISIN_RE.test(s.replace(/\s/g, '').toUpperCase())).length),
      compteRatio: ratio(strs.filter(s => COMPTE_RE.test(s)).length),
      typeRatio: ratio(strs.filter(s => TYPE_RE.test(s)).length),
      tickerRatio: ratio(strs.filter(s => /^[A-Z0-9.\-]{1,8}$/.test(s) && s === s.toUpperCase() && /[A-Z]/.test(s)).length),
      negRatio: nums.length ? nums.filter(n => n < 0).length / nums.length : 0,
      intRatio: nums.length ? nums.filter(n => Number.isInteger(n)).length / nums.length : 0,
      distinct: new Set(strs).size,
      avgLen: strs.reduce((s, v) => s + v.length, 0) / strs.length,
      median: nums.length ? nums.map(Math.abs).sort((a, b) => a - b)[Math.floor(nums.length / 2)] : null,
      nums
    };
  }

  /**
   * Devine les colonnes manquantes à partir des valeurs.
   * @param {object} map mapping déjà obtenu par les libellés (prioritaire)
   */
  function inferColumns(map, header, rows) {
    if (!rows.length) return map;
    const width = Math.max(header.length, ...rows.slice(0, 20).map(r => r.length));
    const used = new Set(Object.values(map));
    const profiles = [];
    for (let i = 0; i < width; i++) {
      if (used.has(i)) continue;
      const p = profile(rows, i);
      if (p) profiles.push(p);
    }
    const take = (field, pick) => {
      if (map[field] != null) return;
      const cands = profiles.filter(p => !used.has(p.idx));
      const best = pick(cands);
      if (best) { map[field] = best.idx; used.add(best.idx); }
    };
    const bestBy = (list, ok, score) => list.filter(ok).sort((a, b) => score(b) - score(a))[0];

    // identifiants : très discriminants, on les prend en premier
    take('isin',   c => bestBy(c, p => p.isinRatio > 0.6, p => p.isinRatio));
    take('date',   c => bestBy(c, p => p.dateRatio > 0.7 && p.numRatio < 0.9, p => p.dateRatio));
    if (map.date == null) take('date', c => bestBy(c, p => p.dateRatio > 0.7, p => p.dateRatio));
    take('compte', c => bestBy(c, p => p.compteRatio > 0.6 && p.distinct <= 12, p => p.compteRatio));
    take('type',   c => bestBy(c, p => p.typeRatio > 0.6 && p.distinct <= 15, p => p.typeRatio));

    // libellé : la colonne texte la plus « bavarde »
    take('libelle', c => bestBy(c, p => p.numRatio < 0.3 && p.dateRatio < 0.3 && p.avgLen >= 3, p => p.avgLen + p.distinct / 100));

    // colonnes numériques restantes
    const numeric = profiles.filter(p => !used.has(p.idx) && p.numRatio > 0.8);

    // montant : colonne avec des valeurs signées, ou la plus grande en valeur absolue
    take('montant', () => bestBy(numeric, p => p.negRatio > 0.15, p => p.median || 0));

    // quantité : petits nombres, souvent entiers
    take('qty', () => bestBy(numeric.filter(p => !used.has(p.idx)),
      p => p.median != null && p.median > 0 && p.median < 10000,
      p => p.intRatio - (p.median || 0) / 1e6));

    // parmi les colonnes de prix restantes, la plus petite est le PRU
    // (prix d'achat) et la plus grande la valorisation, sauf incohérence.
    const rest = numeric.filter(p => !used.has(p.idx)).sort((a, b) => (a.median || 0) - (b.median || 0));
    if (map.pru == null && rest.length) { map.pru = rest[0].idx; used.add(rest[0].idx); }
    if (map.price == null && rest.length > 1) { map.price = rest[1].idx; used.add(rest[1].idx); }

    // ticker en dernier : critère le plus laxiste, il capterait sinon d'autres colonnes
    take('ticker', c => bestBy(c, p => p.tickerRatio > 0.7 && p.avgLen <= 8, p => p.tickerRatio));

    // cohérence : si quantité × PRU ≈ montant, le mapping tient la route ;
    // sinon PRU et montant ont probablement été inversés.
    if (map.qty != null && map.pru != null && map.montant != null) {
      const ok = rows.slice(0, 20).filter(r => {
        const q = num(cell(r, map.qty)), p = num(cell(r, map.pru)), m = num(cell(r, map.montant));
        return q && p && m && Math.abs(Math.abs(m) - q * p) / Math.abs(m) < 0.05;
      }).length;
      const swapped = rows.slice(0, 20).filter(r => {
        const q = num(cell(r, map.qty)), p = num(cell(r, map.montant)), m = num(cell(r, map.pru));
        return q && p && m && Math.abs(Math.abs(m) - q * p) / Math.abs(m) < 0.05;
      }).length;
      if (swapped > ok) { const t = map.pru; map.pru = map.montant; map.montant = t; }
    }
    return map;
  }

  /**
   * La première ligne est-elle un en-tête, ou déjà une ligne de données ?
   * Un intitulé de colonne ne contient ni date ni montant : la présence de
   * l'un ou de l'autre trahit une ligne de données (qui serait sinon avalée
   * comme en-tête, et donc perdue à l'import).
   */
  function looksLikeHeader(header) {
    const cells = header.map(h => String(h ?? '').trim()).filter(Boolean);
    if (!cells.length) return false;
    if (cells.some(looksLikeDate)) return false;
    if (cells.filter(c => num(c) != null).length >= 2) return false;
    const texty = cells.filter(c => num(c) == null).length;
    return texty >= Math.max(1, cells.length * 0.5);
  }

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

  function toOperation(row, map, defaults) {
    const d = date(cell(row, map.date));
    if (!d) return null;
    const montant = num(cell(row, map.montant));
    if (montant == null) return null;
    const libelle = String(cell(row, map.libelle) || '').trim();
    const type = normType(cell(row, map.type) || libelle, montant);
    return {
      date: d, compte: normCompte(cell(row, map.compte), defaults.compte),
      type, libelle: libelle || type,
      ticker: String(cell(row, map.ticker) || '').trim().toUpperCase(),
      isin: String(cell(row, map.isin) || '').trim().toUpperCase(),
      montant: round2(montant),
      qty: num(cell(row, map.qty)), price: num(cell(row, map.price))
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
      name: name || ticker || isin, ticker, isin,
      qty: qty == null ? null : qty,
      pru: pru == null ? null : round2(pru),
      price: price == null ? null : price,
      amount: amount == null ? null : round2(amount),
      cat: String(cell(row, map.cat) || '').trim()
    };
  }

  /**
   * Parse un fichier importé (Uint8Array).
   * @returns {Promise<{kind, operations, positions, skipped, sourceRows, columns}>}
   */
  // Décodage texte robuste : la plupart des exports français sont en UTF-8,
  // mais certains courtiers exportent en Windows-1252 (Latin-1). Si le décodage
  // UTF-8 produit des caractères de remplacement (accents cassés), on réessaie
  // en Windows-1252. La reconnaissance des colonnes ignore de toute façon les
  // accents (slug), ce repli sert surtout à afficher les libellés proprement.
  function decodeText(u8) {
    let s = decoder.decode(u8);
    if (s.includes('�')) {
      try { s = new TextDecoder('windows-1252').decode(u8); } catch { /* navigateur sans win-1252 */ }
    }
    return s;
  }

  async function parseFile(u8, filename, defaults = {}) {
    const ext = String(filename || '').toLowerCase().split('.').pop();
    let header, rows;
    const looksZip = u8.length > 2 && u8[0] === 0x50 && u8[1] === 0x4b;      // xlsx = archive ZIP
    const looksOle = u8.length > 2 && u8[0] === 0xd0 && u8[1] === 0xcf;      // .xls ancien (binaire OLE)

    if (looksOle || ext === 'xls') {
      throw new Error("Format .xls (ancien Excel) non pris en charge. Ré-enregistre le fichier en .xlsx (Excel : Fichier → Enregistrer sous → « Classeur Excel (.xlsx) ») ou en CSV, puis réimporte.");
    }
    if (ext === 'xlsx' || ext === 'xlsm' || (looksZip && ext !== 'csv' && ext !== 'txt' && ext !== 'tsv')) {
      ({ header, rows } = await parseXlsx(u8));
    } else {
      ({ header, rows } = parseCsv(decodeText(u8)));
    }
    if (!header.length) throw new Error('Fichier vide ou illisible');

    // Fichier sans ligne d'en-tête : la première ligne est de la donnée, on la
    // réintègre et on travaille uniquement par reconnaissance du contenu.
    if (!looksLikeHeader(header)) {
      rows = [header, ...rows];
      header = header.map(() => '');
    }

    // 1) libellés de colonnes connus, 2) déduction par le contenu pour le reste
    const map = inferColumns(mapColumns(header), header, rows);
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

  /* ============================================================
     Portefeuille — fusion + valorisation (functions/lib/portfolio.js)
     ============================================================ */
  const keyOf = p => p.isin || p.ticker || p.name;
  const opKey = o => [o.date, o.compte, o.type, o.libelle, o.montant, o.ticker].join('|');
  const EMPTY = { meta: { imports: [] }, balances: {}, cash: {}, positions: [], operations: [] };

  function mergeOperations(portfolio, ops) {
    const seen = new Set(portfolio.operations.map(opKey));
    let added = 0, duplicates = 0;
    for (const op of ops) {
      const k = opKey(op);
      if (seen.has(k)) { duplicates++; continue; }
      seen.add(k); portfolio.operations.push(op); added++;
    }
    portfolio.operations.sort((a, b) => b.date.localeCompare(a.date));
    return { added, duplicates };
  }

  function mergePositions(portfolio, positions) {
    const touched = new Set(positions.map(p => p.compte));
    let added = 0, updated = 0;
    for (const p of positions) {
      if (p.qty == null && p.amount != null && /livret|ldds|lep/i.test(p.compte + ' ' + p.name)) {
        const prev = portfolio.balances[p.compte];
        portfolio.balances[p.compte] = { value: p.amount, taux: prev?.taux ?? null, updatedAt: iso(new Date()) };
        updated++; continue;
      }
      const existing = portfolio.positions.find(x => x.compte === p.compte && keyOf(x) === keyOf(p));
      if (existing) {
        Object.assign(existing, {
          name: p.name || existing.name, ticker: p.ticker || existing.ticker,
          isin: p.isin || existing.isin, qty: p.qty ?? existing.qty,
          pru: p.pru ?? existing.pru, price: p.price ?? existing.price, cat: p.cat || existing.cat
        });
        updated++;
      } else {
        portfolio.positions.push({ ...p, addedAt: iso(new Date()) });
        added++;
      }
    }
    const keep = new Set(positions.map(p => p.compte + '::' + keyOf(p)));
    const before = portfolio.positions.length;
    portfolio.positions = portfolio.positions.filter(x => !touched.has(x.compte) || keep.has(x.compte + '::' + keyOf(x)));
    return { added, updated, removed: before - portfolio.positions.length };
  }

  /**
   * Reconstruit les lignes détenues à partir du journal d'opérations.
   *
   * Un CSV d'opérations (achats, ventes, versements) ne contient pas de
   * positions : sans cette reconstruction, importer un relevé de transactions
   * donnait un patrimoine à zéro. Les achats cumulent quantité et prix de
   * revient (moyenne pondérée), les ventes réduisent la quantité en laissant le
   * PRU inchangé.
   *
   * Les lignes explicites (instantané de positions importé, ou saisie manuelle)
   * font toujours foi : on ne dérive que ce qui manque, pour ne jamais compter
   * deux fois le même titre.
   *
   * @returns {{positions: Array, cash: Object}}
   */
  /** Types qui déplacent réellement des espèces sur le compte. */
  const CASH_TYPES = new Set(['Versement', 'Ouverture', 'Retrait', 'Achat', 'Vente', 'Dividende']);

  /** Sens de sortie de trésorerie par type d'opération. */
  const CASH_OUT = new Set(['Achat', 'Retrait']);

  /**
   * Montant signé selon le sens réel de l'opération, indépendamment de la
   * convention du fichier importé.
   *
   * Beaucoup d'exports courtier écrivent tous les montants en positif et
   * indiquent le sens dans une colonne séparée (« Achat » / « Vente »). Avec le
   * signe brut, un achat *ajoutait* alors des espèces au lieu d'en retirer,
   * pendant que le titre acheté était compté en plus : le patrimoine doublait
   * et une trésorerie fantôme apparaissait.
   */
  function signedCash(type, montant) {
    const abs = Math.abs(montant);
    return CASH_OUT.has(type) ? -abs : abs;
  }

  function deriveFromOperations(portfolio) {
    // Chronologique : le journal est stocké du plus récent au plus ancien, or
    // une vente traitée avant son achat faussait la quantité et le PRU.
    const ops = [...(portfolio.operations || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));

    // Index de TOUS les identifiants des lignes explicites (ISIN, ticker, nom) :
    // un instantané identifie par ISIN et le journal par ticker, sans quoi la
    // même valeur apparaîtrait deux fois.
    const explicit = new Set();
    for (const p of portfolio.positions || []) {
      for (const id of [p.isin, p.ticker, p.name]) {
        if (id) explicit.add((p.compte || '') + '::' + String(id).toUpperCase());
      }
    }
    const comptesWithExplicit = new Set((portfolio.positions || []).map(p => p.compte));

    const held = new Map();      // compte::clé → { compte, name, ticker, isin, qty, cost }
    const flow = {};             // compte → solde de trésorerie déduit des flux
    const detail = {};           // compte → décomposition des flux, pour l'affichage

    for (const o of ops) {
      const compte = o.compte || 'PEA';
      const montant = Number(o.montant) || 0;

      // Seuls les vrais mouvements d'espèces alimentent la trésorerie. Une ligne
      // « Solde »/« Valorisation » (photo du compte, fréquente dans les exports)
      // ou un type non reconnu ne sont pas des flux : les compter créait de
      // l'argent qui n'a jamais été versé.
      if (CASH_TYPES.has(o.type)) {
        flow[compte] = round2((flow[compte] || 0) + signedCash(o.type, montant));
        // détail conservé pour pouvoir expliquer le montant à l'écran
        const dt = detail[compte] || (detail[compte] = { Versement:0, Ouverture:0, Achat:0, Vente:0, Dividende:0, Retrait:0, count:0 });
        dt[o.type] = round2((dt[o.type] || 0) + Math.abs(montant));
        dt.count++;
      }

      if (o.type !== 'Achat' && o.type !== 'Vente') continue;

      const label = (o.ticker || o.isin || o.libelle || '').trim();
      if (!label) continue;

      // quantité : celle de l'opération, sinon déduite du montant et du prix
      let qty = Number(o.qty);
      const price = Number(o.price);
      let amountOnly = false;
      if (!Number.isFinite(qty) || qty <= 0) {
        if (Number.isFinite(price) && price > 0) {
          qty = Math.abs(montant) / price;
        } else {
          // Ni quantité ni cours : impossible de suivre le titre au marché. On
          // conserve quand même le montant investi (qty=1, PRU=montant cumulé),
          // sinon l'argent dépensé disparaîtrait du patrimoine. La ligne est
          // marquée non cotable plutôt que d'afficher une fausse cotation.
          qty = 1;
          amountOnly = true;
        }
      }
      const cost = amountOnly ? Math.abs(montant)
        : (Number.isFinite(price) && price > 0 ? qty * price : Math.abs(montant));

      const k = compte + '::' + label.toUpperCase();
      const cur = held.get(k) || { compte, name: o.libelle || label, ticker: o.ticker || '', isin: o.isin || '', qty: 0, cost: 0, amountOnly: false };
      if (amountOnly) cur.amountOnly = true;
      if (amountOnly && o.type === 'Achat') {
        // cumul du montant investi, la « quantité » reste 1
        cur.qty = 1;
        cur.cost = cur.cost + cost;
        held.set(k, cur);
        continue;
      }
      if (o.type === 'Achat') {
        cur.qty = cur.qty + qty;
        cur.cost = cur.cost + cost;
      } else {
        const pru = cur.qty > 0 ? cur.cost / cur.qty : 0;
        cur.qty = cur.qty - qty;
        cur.cost = Math.max(0, cur.cost - qty * pru);   // PRU conservé sur le reliquat
      }
      held.set(k, cur);
    }

    const positions = [];
    for (const [k, h] of held) {
      if (h.qty <= 0.0000001) continue;                 // ligne soldée
      // couverte par une ligne explicite sous n'importe lequel de ses identifiants
      const ids = [h.isin, h.ticker, h.name].filter(Boolean).map(id => h.compte + '::' + String(id).toUpperCase());
      if (ids.some(id => explicit.has(id)) || explicit.has(k)) continue;
      positions.push({
        compte: h.compte, name: h.name, ticker: h.ticker, isin: h.isin,
        qty: round2(h.qty * 1000000) / 1000000,
        pru: round2(h.cost / h.qty),
        price: round2(h.cost / h.qty),                  // en attente de cotation
        cat: '', derived: true,
        // sans quantité connue, la ligne n'est pas cotable au marché
        ...(h.amountOnly ? { manual: true, amountOnly: true } : {})
      });
    }

    // Trésorerie déduite : seulement pour les enveloppes sans instantané de
    // positions. Là où un instantané existe, il est réputé complet — sinon un
    // versement non suivi d'un achat dans le journal gonflerait le total.
    const cash = {};
    for (const [compte, solde] of Object.entries(flow)) {
      if (comptesWithExplicit.has(compte)) continue;
      if (portfolio.cash && portfolio.cash[compte] != null) continue;
      if (portfolio.balances && portfolio.balances[compte] != null) continue;
      if (solde > 0.005) cash[compte] = solde;
    }
    return { positions, cash, cashDetail: detail };
  }

  function classOf(pos) {
    const s = (pos.cat + ' ' + pos.name).toLowerCase();
    if (/fonds euro/.test(s)) return 'Fonds euro';
    if (/oblig|bond|govern|aggregate/.test(s)) return 'Obligations';
    if (/etf|ucits|amundi|vanguard|spdr|ishares|lyxor|msci|s&p/.test(s)) return 'ETF actions';
    if (/liquidit|especes|espèces|cash/.test(s)) return 'Liquidités';
    return 'Actions en direct';
  }

  function flows(ops = []) {
    const ym = new Date().toISOString().slice(0, 7);
    const versements = ops.filter(o => o.type === 'Versement' || o.type === 'Ouverture');
    // valeurs absolues : un versement reste un versement quel que soit le signe
    // utilisé par le fichier d'origine
    const epargneMois = round2(versements.filter(o => o.date.slice(0, 7) === ym).reduce((s, o) => s + Math.abs(o.montant), 0));
    const total = round2(versements.reduce((s, o) => s + Math.abs(o.montant), 0));
    const months = new Set(ops.map(o => o.date.slice(0, 7)));
    return {
      epargneMois, versementsTotal: total, moisSuivis: months.size,
      epargneMoyenne: months.size ? round2(total / months.size) : 0,
      premiereOperation: ops.length ? ops[ops.length - 1].date : null
    };
  }
  function dividends(ops = []) {
    const byYear = {};
    for (const o of ops) {
      if (o.type !== 'Dividende') continue;
      const y = o.date.slice(0, 4), m = Number(o.date.slice(5, 7)) - 1;
      const y_ = byYear[y] || (byYear[y] = { months: Array(12).fill(0), lines: Array.from({ length: 12 }, () => []), total: 0 });
      const encaisse = Math.abs(o.montant);      // un dividende est toujours encaissé
      y_.months[m] = round2(y_.months[m] + encaisse);
      y_.lines[m].push([o.libelle, encaisse]);
      y_.total = round2(y_.total + encaisse);
    }
    return byYear;
  }
  function allocation(comptes, lines) {
    const titre = [], classe = {};
    for (const [name, c] of Object.entries(comptes)) {
      if (c.garanti) { titre.push([name, c.value]); classe['Épargne garantie'] = round2((classe['Épargne garantie'] || 0) + c.value); }
      if (c.cash) classe['Liquidités'] = round2((classe['Liquidités'] || 0) + c.cash);
    }
    for (const l of lines) { titre.push([l.name, l.value]); classe[l.classe] = round2((classe[l.classe] || 0) + l.value); }
    const cashTotal = Object.values(comptes).reduce((s, c) => s + (c.cash || 0), 0);
    if (cashTotal) titre.push(['Liquidités', round2(cashTotal)]);
    titre.sort((a, b) => b[1] - a[1]);
    return {
      titre,
      classe: Object.entries(classe).sort((a, b) => b[1] - a[1]),
      parEnveloppe: Object.entries(comptes).map(([n, c]) => [n, c.value]).sort((a, b) => b[1] - a[1])
    };
  }

  /**
   * Valorise le portefeuille. Les cotations sont fournies par l'appelant
   * (via le Cloudflare Worker) sous forme de Map key → { price, ... }, ou vide
   * pour une valorisation « dernier cours connu ».
   * @param {object} portfolio
   * @param {Map<string,object>} quoteMap
   */
  function value(portfolio, quoteMap = new Map()) {
    const live = quoteMap.size > 0;
    let quotesOk = 0; const quotesFailed = [];

    // lignes explicites + lignes reconstruites depuis le journal d'opérations
    const derived = deriveFromOperations(portfolio);
    const allPositions = [...(portfolio.positions || []), ...derived.positions];
    const allCash = { ...derived.cash, ...(portfolio.cash || {}) };

    const lines = allPositions.map(p => {
      const q = quoteMap.get(keyOf(p));
      const price = (q && typeof q.price === 'number') ? q.price : (p.price ?? p.pru ?? 0);
      if (q && typeof q.price === 'number' && !q.stale) quotesOk++;
      else if (live && !q?.manual && !p.manual) quotesFailed.push({ name: p.name, reason: q?.error || 'cours indisponible' });

      const qty = p.qty ?? 0;
      const mise = round2(qty * (p.pru ?? price));
      const val = round2(qty * price);
      const pv = round2(val - mise);
      return {
        compte: p.compte, name: p.name, ticker: p.ticker, isin: p.isin, cat: p.cat || '',
        qty, pru: p.pru, price: round2(price), value: val, mise, pv,
        pct: mise ? round2(pv / mise * 100) : 0, classe: classOf(p),
        symbol: q?.symbol || p.symbol || null, symbolPinned: !!p.symbol,
        source: q?.source || 'stocké', quotedAt: q?.at || null,
        manual: !!(q?.manual || p.manual),
        live: !!(q && typeof q.price === 'number' && !q.stale),
        dayChange: q && q.previousClose ? round2((price - q.previousClose) * qty) : null
      };
    });

    const comptes = {};
    for (const [name, cash] of Object.entries(allCash))
      comptes[name] = { name, value: round2(cash), mise: round2(cash), pv: 0, pvPct: 0, cash: round2(cash), lines: [], dayChange: 0 };
    for (const l of lines) {
      const c = comptes[l.compte] || (comptes[l.compte] = { name: l.compte, value: 0, mise: 0, pv: 0, pvPct: 0, cash: 0, lines: [], dayChange: 0 });
      c.lines.push(l); c.value = round2(c.value + l.value); c.mise = round2(c.mise + l.mise); c.dayChange = round2(c.dayChange + (l.dayChange || 0));
    }
    for (const [name, bal] of Object.entries(portfolio.balances || {})) {
      const c = comptes[name] || (comptes[name] = { name, value: 0, mise: 0, pv: 0, pvPct: 0, cash: 0, lines: [], dayChange: 0 });
      c.value = round2(c.value + bal.value); c.mise = round2(c.mise + bal.value);
      c.balance = bal.value; c.taux = bal.taux; c.garanti = true;
      if (bal.taux) c.interets = round2(bal.value * bal.taux / 100);
    }
    for (const c of Object.values(comptes)) {
      c.pv = round2(c.value - c.mise); c.pvPct = c.mise ? round2(c.pv / c.mise * 100) : 0;
      c.lines.sort((a, b) => b.pv - a.pv);
    }

    const patrimoine = round2(Object.values(comptes).reduce((s, c) => s + c.value, 0));
    const capital = round2(Object.values(comptes).reduce((s, c) => s + c.mise, 0));
    const bourse = round2(Object.values(comptes).filter(c => !c.garanti).reduce((s, c) => s + c.value, 0));
    const dayChange = round2(Object.values(comptes).reduce((s, c) => s + (c.dayChange || 0), 0));

    return {
      asOf: new Date().toISOString(), live,
      quotes: { ok: quotesOk, failed: quotesFailed, provider: live ? 'cloudflare' : 'stocké' },
      totals: {
        patrimoine, capital, pv: round2(patrimoine - capital),
        pvPct: capital ? round2((patrimoine - capital) / capital * 100) : 0,
        partBourse: patrimoine ? round2(bourse / patrimoine * 100) : 0, dayChange,
        ...flows(portfolio.operations)
      },
      comptes, lines, allocation: allocation(comptes, lines),
      cashDetail: derived.cashDetail,        // décomposition de la trésorerie déduite
      operations: portfolio.operations.map(o => ({ ...o, dateFr: frDate(o.date) })),
      dividends: dividends(portfolio.operations),
      imports: (portfolio.meta?.imports || []).slice(-8).reverse()
    };
  }

  /** Positions à coter → payload minimal pour le Worker. */
  function quoteRequest(positions) {
    return positions
      .filter(p => !(p.manual || (!p.symbol && !p.ticker && !p.isin)))
      .map(p => ({ key: keyOf(p), symbol: p.symbol || null, isin: p.isin || null, ticker: p.ticker || null, name: p.name || null, price: p.price ?? null, compte: p.compte || null }));
  }

  glob.PatrimoineCore = {
    parseFile, parseCsv, parseXlsx, mapColumns, detectKind,
    value, mergeOperations, mergePositions, classOf, quoteRequest, keyOf,
    deriveFromOperations, inferColumns, num, date, slug, round2, iso, frDate, EMPTY
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
