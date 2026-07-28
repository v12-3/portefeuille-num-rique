'use strict';

const zlib = require('zlib');

/* ============================================================
   Encodeur PNG minimal (RGBA 8 bits) — évite d'embarquer des
   binaires dans le dépôt : les icônes PWA sont générées à la volée.
   ============================================================ */

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** @param {number} w @param {number} h @param {Buffer} rgba w*h*4 octets */
function encodePng(w, h, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;      // profondeur
  ihdr[9] = 6;      // RGBA
  // 10..12 : compression / filtre / entrelacement = 0

  const raw = Buffer.alloc(h * (w * 4 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;                                   // filtre "none"
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Icône de l'app : carré bleu plein bord à bord (compatible masquage Android) + « P » blanc. */
function appIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, [r, g, b]) => {
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  };

  const BLUE = [0x00, 0x52, 0xff], WHITE = [0xff, 0xff, 0xff];
  const box = (x0, y0, x1, y1) => [x0 * size, y0 * size, x1 * size, y1 * size];

  // lettre P : hampe + panse (barre haute, montant droit, barre médiane)
  const parts = [
    box(0.34, 0.27, 0.435, 0.75),   // hampe
    box(0.34, 0.27, 0.62, 0.365),   // barre haute
    box(0.545, 0.27, 0.64, 0.545),  // montant droit
    box(0.34, 0.45, 0.62, 0.545)    // barre médiane
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const inLetter = parts.some(([x0, y0, x1, y1]) => x >= x0 && x < x1 && y >= y0 && y < y1);
      set(x, y, inLetter ? WHITE : BLUE);
    }
  }
  return encodePng(size, size, px);
}

module.exports = { encodePng, appIcon };
