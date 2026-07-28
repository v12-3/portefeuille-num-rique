'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function file(name) { return path.join(DATA_DIR, name); }

function read(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(name), 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') console.error(`[store] ${name} illisible :`, e.message);
    return structuredClone(fallback);
  }
}

/** Écriture atomique : tmp + rename, pour ne jamais laisser un JSON tronqué. */
function write(name, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dest = file(name);
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, dest);
  return value;
}

/**
 * Premier lancement (dépôt fraîchement cloné) : les données réelles sont hors git,
 * on démarre donc sur les fichiers d'exemple plutôt que sur un portefeuille vide.
 */
function ensureSeed() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const seeded = [];
  for (const name of ['portfolio.json', 'history.json']) {
    const dest = file(name);
    const example = file(name.replace('.json', '.example.json'));
    if (!fs.existsSync(dest) && fs.existsSync(example)) {
      fs.copyFileSync(example, dest);
      seeded.push(name);
    }
  }
  return seeded;
}

module.exports = { read, write, ensureSeed, DATA_DIR };
