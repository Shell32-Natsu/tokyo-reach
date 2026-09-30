// node test/engine.test.js — sanity checks against well-known trips
const fs = require('fs'), zlib = require('zlib'), path = require('path');
require('../src/engine.js');
const { Network, decodeGeo, decodeBase, haversine } = globalThis.Reach;
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
  return r;
}
run('新宿', 8 * 60, 30);
run('渋谷', 8 * 60, 30);
run('東京', 12 * 60, 45);
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
}
