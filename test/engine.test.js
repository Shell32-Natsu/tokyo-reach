// node test/engine.test.js — sanity checks against well-known trips.
// Exits non-zero if the data or the engine look broken, so an automatic data
// update never publishes a bad build.
const fs = require('fs'), zlib = require('zlib'), path = require('path');
require('../src/engine.js');
const { Network, decodeGeo, decodeBase, haversine, japanHolidays, dayType } = globalThis.Reach;
const failures = [];
const check = (ok, msg) => { if (!ok) failures.push(msg); };
const D = path.join(__dirname, '..', 'public', 'data');
const gz = f => new Uint8Array(zlib.gunzipSync(fs.readFileSync(path.join(D, f))));
let t = Date.now();
const net = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(D, 'net.bin'))));
const nw = new Network(net, gz('tt.bin'));
console.log('decode', Date.now() - t, 'ms; trips', nw.T, 'stops', nw.stopStation.length);
t = Date.now(); nw.calendar(1); console.log('calendar build', Date.now() - t, 'ms; conns', nw.calendar(1).n);
t = Date.now(); const g = decodeGeo(gz('geo13.bin')); const b = decodeBase(gz('base.bin'));
console.log('geo+base decode', Date.now() - t, 'ms', g.sections.length, b.land.length);

const name = s => net.stations[s].ja;
const findGroup = ja => net.stations.findIndex(s => s.ja === ja);
const fmt = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
function run(from, time, budget, cats = [true, true, false]) {
  const s0 = findGroup(from); const g0 = net.stations[s0].g;
  const t1 = Date.now();
  const r = nw.query({ group: g0, cal: 1, time, budget, cats, xfer: 1 });
  const ms = Date.now() - t1;
  const reached = [];
  const seen = new Set();
  for (let s = 0; s < nw.S; s++) if (r.reached(s) && net.stations[s].c && !seen.has(net.stations[s].g)) { seen.add(net.stations[s].g); reached.push(s); }
  reached.sort((a, b) => haversine(net.stations[s0].c, net.stations[b].c) - haversine(net.stations[s0].c, net.stations[a].c));
  console.log(`\n${from} ${fmt(time)} +${budget}min: ${reached.length} groups, scanned ${r.scanned}, ${ms} ms`);
  for (const s of reached.slice(0, 6)) {
    const j = r.journey(s);
    const km = (haversine(net.stations[s0].c, net.stations[s].c) / 1000).toFixed(1);
    console.log(`  ${name(s)} ${km}km +${r.minutes(s)}min :: ` + j.legs.map(l => l.kind === 'walk' ? `walk ${name(l.from)}→${name(l.to)}` :
      `${fmt(l.dep)} ${name(l.from)} ─[${l.trips.map(tr => net.railways[nw.tripRail[tr]].ja + '/' + net.types[nw.tripType[tr]].ja).join(' ⇢ ')}]→ ${name(l.to)} ${fmt(l.arr)}`).join('  |  '));
  }
  t = Date.now(); const rid = r.ridden(); console.log('  ridden sections', rid.size, Date.now() - t, 'ms');
  r.groups = reached.length;
  return r;
}

// --- data volume: catches a truncated or partly missing upstream snapshot
check(nw.T > 50000, `only ${nw.T} trips`);
check(net.stations.length > 2000, `only ${net.stations.length} stations`);
{
  const perRail = new Uint32Array(net.railways.length);
  for (let i = 0; i < nw.T; i++) perRail[nw.tripRail[i]]++;
  const empty = net.railways.filter((r, i) => !perRail[i]).map(r => r.id);
  check(empty.length <= net.railways.length * 0.05, `${empty.length} lines have no trips: ${empty.slice(0, 8).join(', ')}`);
  for (const id of ['JR-East.Yamanote', 'TokyoMetro.Ginza', 'Toei.Oedo', 'Tokyu.Toyoko', 'Odakyu.Odawara', 'Keio.Keio'])
    check(perRail[net.railways.findIndex(r => r.id === id)] > 100, `${id} has almost no trips`);
}

// --- reachability on well-known trips
check(run('新宿', 8 * 60, 30).groups >= 200, '新宿 08:00 +30 reaches too few stations');
check(run('渋谷', 8 * 60, 30).groups >= 150, '渋谷 08:00 +30 reaches too few stations');
{
  const r = run('東京', 12 * 60, 45);
  check(r.groups >= 400, '東京 12:00 +45 reaches too few stations');
  const totsuka = net.stations.findIndex(s => s.ja === '戸塚');
  check(r.minutes(totsuka) !== null && r.minutes(totsuka) <= 45, '東京 → 戸塚 not reachable in 45 min');
}
run('池袋', 23 * 60 + 50, 30);
run('新宿', 8 * 60, 30, [true, true, true]);
// edge cases: late night, first trains, JR-only, Saturday
run('新宿', 24 * 60 + 30, 30);
run('新宿', 4 * 60 + 40, 30);
{
  const s0 = net.stations.findIndex(s => s.ja === '東京');
  const allow = Uint8Array.from(net.railways, r => r.op.startsWith('JR-') ? 1 : 0);
  const r = nw.query({ group: net.stations[s0].g, cal: 2, time: 600, budget: 60, cats: [true, true, false], xfer: 1, railAllowed: allow });
  let bad = 0, n = 0;
  for (let s = 0; s < nw.S; s++) if (r.reached(s)) { n++; const j = r.journey(s); for (const l of j.legs) if (l.kind === 'ride') for (const t of l.trips) if (!allow[nw.tripRail[t]]) bad++; }
  console.log('\nJR-only Saturday from 東京 60min: reached', n, 'non-JR rides', bad);
  check(bad === 0, `JR-only query used ${bad} non-JR rides`);
  check(n > 300, 'JR-only query reached too few stations');
}

// --- calendar: computed holidays match the official 2026–2027 list
{
  const expected = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-12", "2026-02-11", "2026-02-23", "2026-03-20", "2026-04-29", "2026-05-03", "2026-05-04", "2026-05-05", "2026-05-06", "2026-07-20", "2026-08-11", "2026-09-21", "2026-09-22", "2026-09-23", "2026-10-12", "2026-11-03", "2026-11-23", "2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02", "2027-01-03", "2027-01-11", "2027-02-11", "2027-02-23", "2027-03-21", "2027-03-22", "2027-04-29", "2027-05-03", "2027-05-04", "2027-05-05", "2027-07-19", "2027-08-11", "2027-09-20", "2027-09-23", "2027-10-11", "2027-11-03", "2027-11-23", "2027-12-30", "2027-12-31"];
  const iso = (y, n) => new Date(n * 864e5).toISOString().slice(0, 10);
  const got = [2026, 2027].flatMap(y => [...japanHolidays(y)].map(n => iso(y, n))).sort();
  check(JSON.stringify(got) === JSON.stringify(expected.sort()), `holidays differ: ${got.filter(d => !expected.includes(d))} / ${expected.filter(d => !got.includes(d))}`);
  check(dayType('2026-10-02') === 1 && dayType('2026-10-03') === 2 && dayType('2026-10-12') === 4 && dayType('2027-03-22') === 4, 'dayType wrong');
}

if (failures.length) {
  console.error('\nFAILED:\n  ' + failures.join('\n  '));
  process.exit(1);
}
console.log('\nall checks passed');
