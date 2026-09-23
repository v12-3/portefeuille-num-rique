/**
 * Tests du moteur de calcul (public/app-core.js), sans dépendance :
 *   node --test tests/
 * Ils verrouillent les montants : aucun euro inventé, aucun euro perdu,
 * quel que soit le format du fichier importé.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const src = readFileSync(fileURLToPath(new URL('../public/app-core.js', import.meta.url)), 'utf8');
vm.runInThisContext(src, { filename: 'app-core.js' });
const C = globalThis.PatrimoineCore;

const enc = s => new TextEncoder().encode(s);
const empty = () => structuredClone(C.EMPTY);
const sum = rows => Math.round(rows.reduce((s, r) => s + r[1], 0) * 100) / 100;

test('nombres au format français, anglais, négatifs et entre parenthèses', () => {
  assert.equal(C.num('1 234,56'), 1234.56);
  assert.equal(C.num('1.234,56 €'), 1234.56);
  assert.equal(C.num('1,234.56'), 1234.56);
  assert.equal(C.num('-516,56'), -516.56);
  assert.equal(C.num('−12,5'), -12.5);
  assert.equal(C.num('(12,5)'), -12.5);
  assert.equal(C.num(''), null);
  assert.equal(C.num('abc'), null);
});

test('dates : ISO, française, série Excel', () => {
  assert.equal(C.date('2026-07-17'), '2026-07-17');
  assert.equal(C.date('17/07/2026'), '2026-07-17');
  assert.equal(C.date('17.07.26'), '2026-07-17');
  assert.equal(C.date(46220), '2026-07-17');
  assert.equal(C.date(''), null);
});

test('enveloppes normalisées sans mélanger CTO/PEA ni LDDS/Livret A', () => {
  assert.equal(C.normCompte('PEA'), 'PEA');
  assert.equal(C.normCompte('pea bourse direct'), 'PEA');
  assert.equal(C.normCompte('PEA-PME'), 'PEA-PME');
  assert.equal(C.normCompte('CTO'), 'CTO');
  assert.equal(C.normCompte('Compte titres ordinaire'), 'CTO');
  assert.equal(C.normCompte('Assurance-vie Linxea Spirit'), 'Assurance Vie');
  assert.equal(C.normCompte('PER individuel'), 'PER');
  assert.equal(C.normCompte('LDDS'), 'LDDS');
  assert.equal(C.normCompte('LEP'), 'LEP');
  assert.equal(C.normCompte('Livret A'), 'Livret A');
  assert.equal(C.normCompte('Livret Jeune'), 'Livret Jeune');
  assert.equal(C.normCompte('', 'PEA'), 'PEA');
});

test('import CSV d\'opérations avec en-têtes', async () => {
  const csv = 'Date;Compte;Type;Montant;Ticker;Quantité;Cours\n' +
    '2026-01-10;PEA;VERSEMENT;1000,00;;;\n' +
    '2026-01-12;PEA;ACHAT;-500,00;AI;2;250\n';
  const r = await C.parseFile(enc(csv), 'ops.csv');
  assert.equal(r.kind, 'operations');
  assert.equal(r.operations.length, 2);
  assert.equal(r.operations[1].type, 'Achat');
  assert.equal(r.operations[1].qty, 2);
});

test('import sans ligne d\'en-tête : colonnes reconnues par le contenu', async () => {
  const csv = '10/01/2026;PEA;Versement;1000\n12/01/2026;PEA;Achat;-500\n';
  const r = await C.parseFile(enc(csv), 'sans-entete.csv');
  assert.equal(r.kind, 'operations');
  assert.equal(r.operations.length, 2, 'la première ligne ne doit pas être avalée comme en-tête');
});

test('fichier .xls ancien : message clair', async () => {
  await assert.rejects(C.parseFile(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]), 'vieux.xls'), /xlsx/);
});

/** Même relevé, deux conventions de signe : le patrimoine doit être identique. */
function portfolioFrom(ops){ const p = empty(); C.mergeOperations(p, ops); return p; }
const OPS_SIGNED = [
  { date:'2026-01-10', compte:'PEA', type:'Versement', libelle:'Versement', ticker:'', isin:'', montant:5000, qty:null, price:null },
  { date:'2026-01-12', compte:'PEA', type:'Achat', libelle:'Air Liquide', ticker:'AI', isin:'', montant:-500, qty:2, price:250 },
  { date:'2026-02-12', compte:'PEA', type:'Achat', libelle:'Schneider', ticker:'SU', isin:'', montant:-392, qty:2, price:196 },
  { date:'2026-05-20', compte:'PEA', type:'Dividende', libelle:'Air Liquide', ticker:'AI', isin:'', montant:12, qty:null, price:null }
];
const OPS_POSITIVE = OPS_SIGNED.map(o => ({ ...o, montant: Math.abs(o.montant) }));

test('achats écrits en positif : pas de patrimoine doublé ni de liquidités fantômes', () => {
  const a = C.value(portfolioFrom(OPS_SIGNED));
  const b = C.value(portfolioFrom(OPS_POSITIVE));
  // 5000 versés + 12 de dividende = 5012 : c'est tout l'argent qui existe
  assert.equal(a.totals.patrimoine, 5012);
  assert.equal(b.totals.patrimoine, 5012);
  assert.equal(a.comptes.PEA.cash, 5000 - 500 - 392 + 12);
  assert.equal(b.comptes.PEA.cash, a.comptes.PEA.cash);
  assert.deepEqual(b.cashDetail.PEA, a.cashDetail.PEA);
});

test('une ligne « Solde » n\'est pas un versement', () => {
  const p = portfolioFrom([...OPS_SIGNED, { date:'2026-06-01', compte:'PEA', type:'Solde', libelle:'Solde du compte', ticker:'', isin:'', montant:5012, qty:null, price:null }]);
  assert.equal(C.value(p).totals.patrimoine, 5012);
});

test('vente traitée après l\'achat même si le journal est dans le désordre', () => {
  const p = portfolioFrom([
    { date:'2026-03-01', compte:'PEA', type:'Vente', libelle:'Air Liquide', ticker:'AI', isin:'', montant:300, qty:1, price:300 },
    { date:'2026-01-01', compte:'PEA', type:'Achat', libelle:'Air Liquide', ticker:'AI', isin:'', montant:-500, qty:2, price:250 }
  ]);
  const { positions } = C.deriveFromOperations(p);
  assert.equal(positions.length, 1);
  assert.equal(positions[0].qty, 1);
  assert.equal(positions[0].pru, 250);
});

test('ligne soldée : elle disparaît', () => {
  const p = portfolioFrom([
    { date:'2026-01-01', compte:'PEA', type:'Achat', libelle:'X', ticker:'X', isin:'', montant:-100, qty:1, price:100 },
    { date:'2026-02-01', compte:'PEA', type:'Vente', libelle:'X', ticker:'X', isin:'', montant:120, qty:1, price:120 }
  ]);
  assert.equal(C.deriveFromOperations(p).positions.length, 0);
});

test('liquidités fixées à la main : elles remplacent le calcul', () => {
  const p = portfolioFrom(OPS_SIGNED);
  p.cash.PEA = 0;
  const v = C.value(p);
  assert.equal(v.comptes.PEA.cash, 0);
  assert.equal(v.totals.patrimoine, 892);        // les deux lignes au prix d'achat
});

test('instantané de positions : pas de trésorerie déduite en plus', () => {
  const p = portfolioFrom(OPS_SIGNED);
  C.mergePositions(p, [{ compte:'PEA', name:'Air Liquide', ticker:'AI', isin:'', qty:2, pru:250, price:260, amount:520, cat:'' }]);
  const v = C.value(p);
  assert.equal(v.comptes.PEA.cash, 0);
  assert.equal(v.totals.patrimoine, 520);
});

test('une ligne saisie à la main ne fait pas disparaître les liquidités ni les autres lignes', () => {
  const p = portfolioFrom(OPS_SIGNED);
  const before = C.value(p);
  p.positions.push({ compte:'PEA', name:'Total', ticker:'TTE', isin:'', qty:1, pru:60, price:60, cat:'', source:'saisie' });
  const after = C.value(p);
  assert.equal(after.comptes.PEA.cash, before.comptes.PEA.cash);
  assert.equal(after.comptes.PEA.lines.length, before.comptes.PEA.lines.length + 1);
});

test('répartitions : chaque vue totalise exactement le patrimoine', () => {
  const p = portfolioFrom(OPS_SIGNED);
  p.balances['Livret A'] = { value:6681.68, taux:2.4 };
  const v = C.value(p);
  assert.equal(sum(v.allocation.titre), v.totals.patrimoine);
  assert.equal(sum(v.allocation.classe), v.totals.patrimoine);
  assert.equal(sum(v.allocation.pays), v.totals.patrimoine);
  assert.equal(sum(v.allocation.parEnveloppe), v.totals.patrimoine);
});

test('plafonds et première opération par enveloppe', () => {
  const p = portfolioFrom([...OPS_SIGNED].reverse());
  p.balances['Livret A'] = { value:1000, taux:null };
  const v = C.value(p);
  assert.equal(v.comptes.PEA.plafond, 150000);
  assert.equal(v.comptes['Livret A'].plafond, 22950);
  assert.equal(v.comptes.PEA.premiereOperation, '2026-01-10');
  assert.equal(v.totals.premiereOperation, '2026-01-10');
});

test('pays d\'émission : action française, fonds non détaillé', () => {
  assert.equal(C.paysOf({ isin:'FR0000120073', name:'Air Liquide', classe:'Actions en direct' }), 'France');
  assert.equal(C.paysOf({ isin:'IE00B4L5Y983', name:'iShares Core MSCI World', classe:'ETF actions' }), 'Fonds (composition non détaillée)');
  assert.equal(C.paysOf({ isin:'', name:'Ligne sans ISIN' }), 'Pays non identifié');
});

test('dividendes toujours positifs, même écrits en négatif', () => {
  const p = portfolioFrom([{ date:'2026-05-20', compte:'PEA', type:'Dividende', libelle:'Engie', ticker:'', isin:'', montant:-5, qty:null, price:null }]);
  assert.equal(C.value(p).dividends['2026'].total, 5);
});

test('demande de cotation : PEA et CTO interrogent Paris en premier', () => {
  const req = C.quoteRequest([
    { compte:'CTO', name:'Schneider', ticker:'SU', isin:'', qty:1 },
    { compte:'Assurance Vie', name:'Fonds euro', manual:true, qty:1 }
  ]);
  assert.equal(req.length, 1);
  assert.equal(req[0].compte, 'PEA');
});

test('sans colonne libellé, la ligne prend le nom du ticker', async () => {
  const csv = 'Date;Compte;Type;Montant;Ticker;Quantité;Cours\n2026-06-01;CTO;VERSEMENT;2000;;;\n2026-06-02;CTO;ACHAT;1000;MC;2;500\n';
  const r = await C.parseFile(enc(csv), 'cto.csv');
  const p = portfolioFrom(r.operations);
  const v = C.value(p);
  assert.deepEqual(v.comptes.CTO.lines.map(l => l.name), ['MC']);
  assert.equal(v.comptes.CTO.value, 2000);
  assert.equal(v.comptes.CTO.cash, 1000);
});

test('cours en devise étrangère convertis en euros (dollars, pence)', () => {
  const usd = C.toEur({ price: 147.99, previousClose: 145.89, currency: 'USD' }, { USD: 1.1412 });
  assert.equal(usd.currency, 'EUR');
  assert.equal(usd.price, 129.6793);
  assert.equal(usd.fx.from, 'USD');
  const gbp = C.toEur({ price: 8500, currency: 'GBp' }, { GBP: 0.85 });
  assert.equal(gbp.price, 100);
  const eur = { price: 168.2, currency: 'EUR' };
  assert.equal(C.toEur(eur, {}), eur);
  // sans taux : pas de montant faux, la cotation est écartée
  assert.equal(C.toEur({ price: 10, currency: 'CHF' }, {}).price, null);
  assert.deepEqual(C.currenciesToConvert([{ price: 1, currency: 'GBp' }, { price: 1, currency: 'EUR' }, { price: 1, currency: 'USD' }]), ['GBP', 'USD']);
});

test('lignes cotées : nom seul envoyé, fonds euro et lignes manuelles exclus', () => {
  const req = C.quoteRequest([
    { compte:'PEA', name:'Air Liquide', qty:2 },
    { compte:'Assurance Vie', name:'Fonds euro Nouvelle Génération', qty:1 },
    { compte:'PEA', name:'Ligne manuelle', manual:true, qty:1 }
  ]);
  assert.deepEqual(req.map(r => r.key), ['Air Liquide']);
});
