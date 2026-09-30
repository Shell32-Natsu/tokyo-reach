/* Tokyo Reach — map, controls and results. Depends on engine.js (window.Reach)
 * and MapLibre GL (window.maplibregl). */
(function () {
  'use strict';
  const { Network, decodeBase, decodeGeo, haversine, INF } = window.Reach;
  const $ = (s, el = document) => el.querySelector(s);
  const DATA = 'data/';
  const EXT = window.TR_DATA_EXT || '.bin'; // '.txt' = base64 text (for hosts that only serve text)
  const ZOOMS = [13, 14, 15, 16];
  const ZRANGE = { 13: [0, 12.4], 14: [12.4, 13.4], 15: [13.4, 14.4], 16: [14.4, 24] };
  const MPP0 = 63556; // metres per pixel at zoom 0 around 35.7°N (512px tiles)
  const WALK = 80;    // metres per minute
  const WALK_CAP = 15;

  // Japanese national holidays + year-end (railways run holiday timetables).
  const HOLIDAYS = new Set([
    '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-12', '2026-02-11', '2026-02-23', '2026-03-20', '2026-04-29',
    '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06', '2026-07-20', '2026-08-11', '2026-09-21', '2026-09-22',
    '2026-09-23', '2026-10-12', '2026-11-03', '2026-11-23', '2026-12-30', '2026-12-31',
    '2027-01-01', '2027-01-02', '2027-01-03', '2027-01-11', '2027-02-11', '2027-02-23', '2027-03-21', '2027-03-22',
    '2027-04-29', '2027-05-03', '2027-05-04', '2027-05-05', '2027-07-19', '2027-08-11', '2027-09-20', '2027-09-23',
    '2027-10-11', '2027-11-03', '2027-11-23', '2027-12-30', '2027-12-31',
  ]);

  // ------------------------------------------------------------ state
  const prefs = (() => { try { return JSON.parse(localStorage.getItem('tokyo-reach') || '{}'); } catch (e) { return {}; } })();
  const state = {
    origin: -1, dest: -1,
    cal: 1, time: 480, budget: prefs.budget || 30,
    cats: prefs.cats || [true, true, false],
    xfer: prefs.xfer || 1, ops: prefs.ops || 'all', walk: prefs.walk !== false, lang: prefs.lang || 'ja',
  };
  function savePrefs() {
    try {
      const o = state.origin >= 0 ? net.stations[groupInfo[state.origin].stations[0]].id : null;
      localStorage.setItem('tokyo-reach', JSON.stringify({ origin: o, budget: state.budget, cats: state.cats, xfer: state.xfer, ops: state.ops, walk: state.walk, lang: state.lang }));
    } catch (e) { /* storage unavailable */ }
  }

  let net, nw, base, map, result = null, groupMin, groupBest, ridden = new Map(), far = [];
  let groupInfo = [];
  const geo = {};           // zoom -> decoded geometry
  const sectionIndex = {};  // zoom -> Map(key -> pieces)
  const anchors = {};       // zoom -> Float64Array lon/lat per group
  let prevSec = new Map(), prevGrp = new Map();

  // ------------------------------------------------------------ helpers
  function tok(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
  function isDark() {
    const t = document.documentElement.getAttribute('data-theme');
    if (t) return t === 'dark';
    return matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function hex(c) { const m = c.replace('#', ''); return [0, 2, 4].map(i => parseInt(m.slice(i, i + 2), 16)); }
  function toHex(rgb) { return '#' + rgb.map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join(''); }
  function mix(a, b, t) { const A = hex(a), B = hex(b); return toHex(A.map((v, i) => v + (B[i] - v) * t)); }
  function lum(c) { const [r, g, b] = hex(c).map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }); return .2126 * r + .7152 * g + .0722 * b; }
  function lineColor(c, dark) {
    if (!/^#[0-9a-f]{6}$/i.test(c)) c = '#888888';
    const L = lum(c);
    if (dark && L < .12) return mix(c, '#ffffff', .42 - L);
    if (!dark && L > .6) return mix(c, '#000000', .14);
    return c;
  }
  function rampAt(f) {
    const stops = ['--r0', '--r1', '--r2', '--r3', '--r4'].map(tok);
    f = Math.max(0, Math.min(1, f)) * 4;
    const i = Math.min(3, Math.floor(f));
    return mix(stops[i], stops[i + 1], f - i);
  }
  const inkOn = c => lum(c) > .22 ? '#15191c' : '#ffffff';
  const hhmm = m => `${String(Math.floor(m / 60) % 24).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const L = o => o[state.lang] || o.ja || o.en;

  function tokyoNow() {
    const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
    let date = new Date(Date.UTC(+p.year, +p.month - 1, +p.day));
    let minutes = (+p.hour % 24) * 60 + +p.minute;
    if (+p.hour < 3) { date = new Date(date.getTime() - 864e5); minutes += 1440; }
    const iso = date.toISOString().slice(0, 10), dow = date.getUTCDay();
    const cal = HOLIDAYS.has(iso) || dow === 0 ? 4 : dow === 6 ? 2 : 1;
    return { minutes, cal, iso };
  }

  async function fetchBytes(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const total = +res.headers.get('content-length') || 0;
    let buf;
    if (res.body && total && onProgress) {
      const reader = res.body.getReader(), chunks = []; let got = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; onProgress(got, total); }
      buf = new Uint8Array(got); let o = 0; for (const c of chunks) { buf.set(c, o); o += c.length; }
    } else buf = new Uint8Array(await res.arrayBuffer());
    if (url.endsWith('.txt')) {
      const bin = atob(new TextDecoder().decode(buf).trim());
      buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
    }
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    }
    return buf;
  }

  // ------------------------------------------------------------ names
  function opName(op) {
    const o = net.operators[op];
    if (!o) return '';
    return state.lang === 'zh' ? o[1] : state.lang === 'en' ? o[2] : o[0];
  }
  function railName(ri, withOp = true) {
    const r = net.railways[ri];
    const n = L(r);
    if (!withOp) return n;
    const op = opName(r.op);
    if (r.op.startsWith('JR')) return (state.lang === 'en' ? 'JR ' : 'JR') + n;
    if (n.includes(op) || ['TWR', 'Minatomirai', 'MIR', 'Yurikamome', 'YokohamaSeaside', 'SaitamaTransit', 'TokyoMonorail', 'TamaMonorail', 'ShonanMonorail', 'ChibaMonorail'].includes(r.op)) return n;
    return `${op}${state.lang === 'en' ? ' ' : ''}${n}`;
  }
  function stName(s) { return L(net.stations[s]); }
  function groupName(g) { return stName(groupInfo[g].stations[0]); }
  function typeName(ti) { const t = net.types[ti]; return state.lang === 'zh' ? t.zh : state.lang === 'en' ? t.en : t.ja; }

  // ------------------------------------------------------------ boot
  const meter = $('#loading .meter i'), status = $('#loading p');
  async function boot() {
    const parts = { net: 0, tt: 0, base: 0, geo: 0 }, sizes = { net: 1, tt: 7, base: 5, geo: 2.4 };
    const prog = k => (got, total) => { parts[k] = got / total; const t = Object.keys(parts).reduce((a, x) => a + parts[x] * sizes[x], 0) / 15.4; meter.style.width = `${Math.round(t * 100)}%`; };
    status.textContent = '正在加载时刻表与线路数据…';
    const [netBytes, ttBytes, baseBytes, g13] = await Promise.all([
      fetchBytes(DATA + 'net' + EXT, prog('net')), fetchBytes(DATA + 'tt' + EXT, prog('tt')),
      fetchBytes(DATA + 'base' + EXT, prog('base')), fetchBytes(DATA + 'geo13' + EXT, prog('geo')),
    ]);
    meter.style.width = '100%';
    status.textContent = '正在建立索引…';
    await new Promise(r => setTimeout(r, 20));
    net = JSON.parse(new TextDecoder().decode(netBytes));
    nw = new Network(net, ttBytes);
    base = decodeBase(baseBytes);
    buildGroups();
    addGeo(13, decodeGeo(g13));
    await initMap();
    initUI();
    // default origin: last used, else 新宿
    let og = -1;
    if (prefs.origin) { const s = net.stations.findIndex(x => x.id === prefs.origin); if (s >= 0) og = net.stations[s].g; }
    if (og < 0) og = net.stations.findIndex(x => x.id === 'JR-East.Yamanote.Shinjuku') >= 0 ? net.stations[net.stations.findIndex(x => x.id === 'JR-East.Yamanote.Shinjuku')].g : 0;
    const now = tokyoNow();
    state.cal = now.cal;
    state.time = now.minutes >= 300 && now.minutes <= 1500 ? now.minutes : 480;
    setOrigin(og, false);
    $('#loading').classList.add('done');
    // remaining zoom levels in the background
    for (const z of [14, 15, 16]) {
      fetchBytes(DATA + `geo${z}` + EXT).then(b => { addGeo(z, decodeGeo(b)); addGeoLayers(z); applyStates(true); drawLabelsSoon(); }).catch(() => {});
    }
  }

  // ------------------------------------------------------------ groups
  function buildGroups() {
    groupInfo = net.groups.map((subs, g) => {
      const stations = subs.flat();
      const rails = [...new Set(stations.map(s => net.stations[s].r).filter(r => r >= 0))];
      const cs = stations.map(s => net.stations[s].c).filter(Boolean);
      const c = cs.length ? [cs.reduce((a, x) => a + x[0], 0) / cs.length, cs.reduce((a, x) => a + x[1], 0) / cs.length] : null;
      // served lines, excluding pure track-sharing aliases (same name & colour)
      const seen = new Set(), lines = [];
      for (const r of rails) { const R = net.railways[r]; const k = R.op + R.ja; if (!seen.has(k)) { seen.add(k); lines.push(r); } }
      const names = new Set(); for (const s of stations) { const st = net.stations[s]; names.add(st.ja); names.add(st.zh); names.add((st.en || '').toLowerCase()); }
      return { g, stations, rails, lines, c, imp: lines.length, names: [...names].filter(Boolean) };
    });
  }

  function addGeo(z, g) {
    geo[z] = g;
    const idx = new Map();
    for (const sec of g.sections) idx.set(sec.ri * 512 + sec.k, sec.pieces);
    sectionIndex[z] = idx;
    const a = new Float64Array(groupInfo.length * 2);
    groupInfo.forEach((gi, i) => {
      let x = 0, y = 0, n = 0;
      for (const s of gi.stations) { const p = g.snapped[s]; if (p && (p[0] || p[1])) { x += p[0]; y += p[1]; n++; } }
      if (!n && gi.c) { x = gi.c[0]; y = gi.c[1]; n = 1; }
      a[i * 2] = n ? x / n : NaN; a[i * 2 + 1] = n ? y / n : NaN;
    });
    anchors[z] = a;
  }

  // ------------------------------------------------------------ map
  const stR = (z) => ({ 8: 1, 9: 1.2, 10: 1.6, 11: 2.2, 12: 3, 13: 4, 14: 5.2, 15: 6.6, 16: 8, 17: 9 })[z];
  const lineWx = (x = 0) => ['interpolate', ['exponential', 1.4], ['zoom'], 8, 0.9 + x, 10, 1.6 + x, 12, 2.6 + x, 14, 4 + x, 16, 6 + x];
  const lineW = lineWx(0);

  function railGeoJSON(z) {
    const dark = isDark();
    const feats = [];
    for (const sec of geo[z].sections) {
      const r = net.railways[sec.ri];
      const key = sec.ri * 512 + sec.k;
      for (const p of sec.pieces) {
        if (p.coords.length < 2) continue;
        feats.push({ type: 'Feature', id: key, properties: { cl: lineColor(r.color, false), cd: lineColor(r.color, true), f: p.faint }, geometry: { type: 'LineString', coordinates: p.coords } });
      }
    }
    return { type: 'FeatureCollection', features: feats };
  }

  function stationGeoJSON(z) {
    const snapped = geo[z].snapped, feats = [];
    net.groups.forEach((subs, g) => {
      const centers = [];
      for (const sub of subs) {
        const pts = [];
        for (const s of sub) { const p = snapped[s]; if (p && (p[0] || p[1]) && !pts.some(q => Math.abs(q[0] - p[0]) < 1e-5 && Math.abs(q[1] - p[1]) < 1e-5)) pts.push(p); }
        if (!pts.length) continue;
        centers.push([pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length]);
        if (pts.length === 1) feats.push({ type: 'Feature', id: g, properties: { k: 0 }, geometry: { type: 'Point', coordinates: pts[0] } });
        else feats.push({ type: 'Feature', id: g, properties: { k: 1 }, geometry: { type: 'LineString', coordinates: pts } });
      }
      if (centers.length > 1) feats.push({ type: 'Feature', id: g, properties: { k: 2 }, geometry: { type: 'LineString', coordinates: centers } });
    });
    return { type: 'FeatureCollection', features: feats };
  }

  function mapColors() {
    const dark = isDark();
    const land = tok('--map-land');
    return {
      dark, land, sea: tok('--map-sea'), muni: tok('--map-muni'), pref: tok('--map-pref'),
      stFill: tok('--st-fill'), stCase: tok('--st-case'), sel: tok('--sel'),
      w1: dark ? mix(land, rampAt(.5), .2) : mix(land, rampAt(.12), .3), w2: dark ? mix(land, rampAt(.72), .17) : mix(land, rampAt(.5), .18), w3: dark ? mix(land, rampAt(1), .16) : mix(land, rampAt(.9), .12),
      ramp: [tok('--r0'), tok('--r1'), tok('--r2'), tok('--r3'), tok('--r4')],
    };
  }

  function initMap() {
    const C = mapColors();
    const mobile = innerWidth < 760;
    map = new maplibregl.Map({
      container: 'map',
      style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': C.sea } }] },
      center: mobile ? [139.70, 35.62] : [139.62, 35.69], zoom: mobile ? 9.7 : 10.4,
      minZoom: 8, maxZoom: 16.8, maxBounds: [[137.9, 34.1], [141.6, 37.6]],
      attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false,
      renderWorldCopies: false, fadeDuration: 0,
    });
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation && map.keyboard.disableRotation();
    return new Promise(resolve => map.on('load', () => {
      const land = { type: 'FeatureCollection', features: base.land.map(p => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: p } })) };
      map.addSource('land', { type: 'geojson', data: land, tolerance: 0.25, buffer: 16 });
      map.addSource('muni', { type: 'geojson', data: { type: 'FeatureCollection', features: base.muni.map(l => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: l } })) }, tolerance: 0.4 });
      map.addSource('pref', { type: 'geojson', data: { type: 'FeatureCollection', features: base.pref.map(l => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: l } })) }, tolerance: 0.4 });
      map.addSource('walk', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      map.addLayer({ id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': C.land, 'fill-antialias': true } });
      map.addLayer({ id: 'muni', type: 'line', source: 'muni', minzoom: 9.5, paint: { 'line-color': C.muni, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, .5, 14, 1.2] } });
      map.addLayer({ id: 'pref', type: 'line', source: 'pref', paint: { 'line-color': C.pref, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, .7, 14, 1.8], 'line-dasharray': [3, 2] } });
      const rad = key => ['interpolate', ['exponential', 2], ['zoom'], 8, ['/', ['get', key], MPP0 / 256], 17, ['/', ['get', key], MPP0 / 131072]];
      map.addLayer({ id: 'walk3', type: 'circle', source: 'walk', paint: { 'circle-radius': rad('r3'), 'circle-color': C.w3, 'circle-blur': .12, 'circle-pitch-alignment': 'map' } });
      map.addLayer({ id: 'walk2', type: 'circle', source: 'walk', filter: ['>', ['get', 'r2'], 0], paint: { 'circle-radius': rad('r2'), 'circle-color': C.w2, 'circle-blur': .12, 'circle-pitch-alignment': 'map' } });
      map.addLayer({ id: 'walk1', type: 'circle', source: 'walk', filter: ['>', ['get', 'r1'], 0], paint: { 'circle-radius': rad('r1'), 'circle-color': C.w1, 'circle-blur': .12, 'circle-pitch-alignment': 'map' } });
      addGeoLayers(13);
      resolve();
    }));
  }

  function railOpacity(active) {
    const faint = ['==', ['get', 'f'], 1];
    if (!active) return ['case', faint, .3, 1];
    return ['case', ['boolean', ['feature-state', 'r'], false], ['case', faint, .45, 1], ['case', faint, .06, .17]];
  }
  function stationFill(C) {
    return ['case',
      ['boolean', ['feature-state', 'o'], false], C.sel,
      ['boolean', ['feature-state', 's'], false], C.sel,
      ['>=', ['number', ['feature-state', 'f'], -1], 0],
      ['interpolate', ['linear'], ['number', ['feature-state', 'f'], 0], 0, C.ramp[0], .25, C.ramp[1], .5, C.ramp[2], .75, C.ramp[3], 1, C.ramp[4]],
      C.stFill];
  }
  function stationOpacity(active) {
    if (!active) return ['interpolate', ['linear'], ['zoom'], 9, .7, 11, 1];
    const on = ['any', ['boolean', ['feature-state', 'o'], false], ['>=', ['number', ['feature-state', 'f'], -1], 0]];
    return ['interpolate', ['linear'], ['zoom'], 9, ['case', on, 1, 0], 11, ['case', on, 1, .12], 13, ['case', on, 1, .35]];
  }

  function addGeoLayers(z) {
    if (!map || map.getSource(`rail${z}`)) return;
    const C = mapColors(), [minzoom, maxzoom] = ZRANGE[z];
    const active = state.origin >= 0;
    map.addSource(`rail${z}`, { type: 'geojson', data: railGeoJSON(z), tolerance: 0.3 });
    map.addSource(`path${z}`, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    map.addSource(`st${z}`, { type: 'geojson', data: stationGeoJSON(z), tolerance: 0.2 });
    const before = map.getLayer('st-anchor') ? 'st-anchor' : undefined;
    const add = (l, b) => map.addLayer({ minzoom, maxzoom, ...l }, b);
    add({ id: `halo${z}`, type: 'line', source: `rail${z}`, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': C.land, 'line-width': lineWx(2.5), 'line-opacity': ['case', ['boolean', ['feature-state', 'r'], false], active ? 1 : 0, 0] } }, before);
    add({ id: `rail${z}`, type: 'line', source: `rail${z}`, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', C.dark ? 'cd' : 'cl'], 'line-width': lineW, 'line-opacity': railOpacity(active) } }, before);
    add({ id: `pathcase${z}`, type: 'line', source: `path${z}`, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': C.stCase, 'line-width': lineWx(6) } }, before);
    add({ id: `path${z}`, type: 'line', source: `path${z}`, layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', C.dark ? 'cd' : 'cl'], 'line-width': lineWx(2.5) } }, before);
    // station markers: all casings first, then fills, so touching markers merge
    const R = zz => stR(zz);
    const rExpr = (extra, k2) => ['interpolate', ['linear'], ['zoom'], 9, ['match', ['get', 'k'], 2, k2 * R(9) + extra, 2 * R(9) + extra], 12, ['match', ['get', 'k'], 2, k2 * R(12) + extra, 2 * R(12) + extra], 16, ['match', ['get', 'k'], 2, k2 * R(16) + extra, 2 * R(16) + extra]];
    const cr = extra => ['interpolate', ['linear'], ['zoom'], 9, R(9) + extra, 12, R(12) + extra, 16, R(16) + extra];
    add({ id: `stcl${z}`, type: 'line', source: `st${z}`, filter: ['!=', ['get', 'k'], 0], layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': C.stCase, 'line-width': rExpr(2.6, .55), 'line-opacity': stationOpacity(active) } });
    add({ id: `stcc${z}`, type: 'circle', source: `st${z}`, filter: ['==', ['get', 'k'], 0],
      paint: { 'circle-color': C.stCase, 'circle-radius': cr(1.3), 'circle-opacity': stationOpacity(active) } });
    add({ id: `stfl${z}`, type: 'line', source: `st${z}`, filter: ['!=', ['get', 'k'], 0], layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': stationFill(C), 'line-width': rExpr(0, .55), 'line-opacity': stationOpacity(active) } });
    add({ id: `stfc${z}`, type: 'circle', source: `st${z}`, filter: ['==', ['get', 'k'], 0],
      paint: { 'circle-color': stationFill(C), 'circle-radius': cr(0), 'circle-opacity': stationOpacity(active) } });
    // keep station layers on top of every zoom level's rails
    for (const zz of ZOOMS) for (const id of [`stcl${zz}`, `stcc${zz}`, `stfl${zz}`, `stfc${zz}`]) if (map.getLayer(id)) map.moveLayer(id);
  }

  function restyle() {
    if (!map || !map.getLayer('land')) return;
    const C = mapColors(), active = state.origin >= 0;
    map.setPaintProperty('bg', 'background-color', C.sea);
    map.setPaintProperty('land', 'fill-color', C.land);
    map.setPaintProperty('muni', 'line-color', C.muni);
    map.setPaintProperty('pref', 'line-color', C.pref);
    map.setPaintProperty('walk1', 'circle-color', C.w1);
    map.setPaintProperty('walk2', 'circle-color', C.w2);
    map.setPaintProperty('walk3', 'circle-color', C.w3);
    for (const z of ZOOMS) {
      if (!map.getLayer(`rail${z}`)) continue;
      map.setPaintProperty(`halo${z}`, 'line-color', C.land);
      map.setPaintProperty(`halo${z}`, 'line-opacity', ['case', ['boolean', ['feature-state', 'r'], false], active ? 1 : 0, 0]);
      map.setPaintProperty(`rail${z}`, 'line-color', ['get', C.dark ? 'cd' : 'cl']);
      map.setPaintProperty(`rail${z}`, 'line-opacity', railOpacity(active));
      map.setPaintProperty(`path${z}`, 'line-color', ['get', C.dark ? 'cd' : 'cl']);
      map.setPaintProperty(`pathcase${z}`, 'line-color', C.stCase);
      for (const id of [`stcl${z}`, `stcc${z}`]) { map.setPaintProperty(id, id.startsWith('stcl') ? 'line-color' : 'circle-color', C.stCase); }
      map.setPaintProperty(`stfl${z}`, 'line-color', stationFill(C));
      map.setPaintProperty(`stfc${z}`, 'circle-color', stationFill(C));
      for (const id of [`stcl${z}`, `stfl${z}`]) map.setPaintProperty(id, 'line-opacity', stationOpacity(active));
      for (const id of [`stcc${z}`, `stfc${z}`]) map.setPaintProperty(id, 'circle-opacity', stationOpacity(active));
    }
    drawLabelsSoon();
  }

  // Push the query result into feature-state, touching only what changed.
  function applyStates(all) {
    if (!map) return;
    const secNow = new Map(), grpNow = new Map();
    for (const [k, t] of ridden) secNow.set(k, 1);
    const B = state.budget;
    if (groupMin) groupMin.forEach((m, g) => { if (m >= 0) grpNow.set(g, g === state.origin ? 'o' : (g === state.dest ? 's' : Math.min(1, m / B))); });
    const loaded = ZOOMS.filter(z => map.getSource(`rail${z}`));
    const setAll = (src, id, st) => { for (const z of loaded) map.setFeatureState({ source: `${src}${z}`, id }, st); };
    for (const [k] of prevSec) if (!secNow.has(k)) setAll('rail', k, { r: false });
    for (const [k] of secNow) if (all || !prevSec.has(k)) setAll('rail', k, { r: true });
    for (const [g, v] of prevGrp) if (!grpNow.has(g)) setAll('st', g, { f: -1, o: false, s: false });
    for (const [g, v] of grpNow) if (all || prevGrp.get(g) !== v) setAll('st', g, { f: typeof v === 'number' ? v : 0, o: v === 'o', s: v === 's' });
    prevSec = secNow; prevGrp = grpNow;
  }

  // ------------------------------------------------------------ labels (canvas overlay)
  const canvas = $('#labels'), ctx = canvas.getContext('2d');
  let labelQueued = false, hits = [];
  const widthCache = new Map();
  function measure(text, font) {
    const k = font + '|' + text;
    let w = widthCache.get(k);
    if (w === undefined) { ctx.font = font; w = ctx.measureText(text).width; widthCache.set(k, w); }
    return w;
  }
  function drawLabelsSoon() { if (!labelQueued) { labelQueued = true; requestAnimationFrame(drawLabels); } }
  function resizeCanvas() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = canvas.clientWidth * dpr; canvas.height = canvas.clientHeight * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawLabelsSoon();
  }
  function variant(z) { let v = 13; for (const zz of ZOOMS) if (geo[zz] && z >= ZRANGE[zz][0]) v = zz; return v; }

  function drawLabels() {
    labelQueued = false;
    if (!map || !groupInfo.length) return;
    const W = canvas.clientWidth, H = canvas.clientHeight;
    ctx.clearRect(0, 0, W, H);
    const z = map.getZoom(), v = variant(z), A = anchors[v];
    const active = state.origin >= 0 && groupMin;
    const r = z < 9 ? 1.2 : z >= 16 ? 8 : (() => { const a = Math.floor(z), b = a + 1; return stR(a) + (stR(b) - stR(a)) * (z - a); })();
    const ink = tok('--map-label'), halo = tok('--map-halo'), place = tok('--map-place');
    const F_STA = tok('--f-sta'), F_NUM = tok('--f-num');
    const placed = [];
    const pr = $('#panel').getBoundingClientRect();
    if (innerWidth >= 760) placed.push([pr.left - 6, pr.top - 6, pr.width + 12, pr.height + 12]);
    const side = $('#side');
    if (!side.hidden) { const sr = side.getBoundingClientRect(); placed.push([sr.left - 6, sr.top - 6, sr.width + 12, sr.height + 12]); }
    const markers = [];
    const hit = (arr, x, y, w, h) => { for (const p of arr) if (x < p[0] + p[2] && x + w > p[0] && y < p[1] + p[3] && y + h > p[1]) return true; return false; };
    const free = (x, y, w, h, strict = true) => !(x < 2 || y < 2 || x + w > W - 2 || y + h > H - 2) && !hit(placed, x, y, w, h) && !(strict && hit(markers, x, y, w, h));
    const jobs = [];
    hits = [];
    const bounds = map.getBounds(), pad = .02;
    const inView = (lon, lat) => lon > bounds.getWest() - pad && lon < bounds.getEast() + pad && lat > bounds.getSouth() - pad && lat < bounds.getNorth() + pad;

    const rankOf = new Map(far.map((g, i) => [g, i + 1]));
    const cands = [];
    for (let g = 0; g < groupInfo.length; g++) {
      const lon = A[g * 2], lat = A[g * 2 + 1];
      if (!(lon === lon) || !inView(lon, lat)) continue;
      const p = map.project([lon, lat]);
      const m = active ? groupMin[g] : -1;
      const reached = m >= 0;
      if (!active || reached || z >= 11) hits.push({ g, x: p.x, y: p.y });
      const gi = groupInfo[g];
      let pri, minZ;
      if (g === state.origin) { pri = 1e6; minZ = 0; }
      else if (g === state.dest) { pri = 9e5; minZ = 0; }
      else if (rankOf.has(g)) { pri = 8e5 - rankOf.get(g); minZ = 0; }
      else {
        minZ = gi.imp >= 5 ? 10.2 : gi.imp >= 3 ? 11.2 : gi.imp === 2 ? 12.1 : 12.9;
        if (active && reached) minZ -= .6;
        if (active && !reached) minZ += .5;
        pri = gi.imp * 10 + (reached ? 5 : 0);
      }
      if (z < minZ) continue;
      cands.push({ g, x: p.x, y: p.y, pri, m, rank: rankOf.get(g) || 0 });
    }
    cands.sort((a, b) => b.pri - a.pri);
    // station markers occupy space too (so labels don't cover them)
    for (const c of cands) markers.push([c.x - r, c.y - r, r * 2, r * 2]);
    for (const c of cands) {
      const isO = c.g === state.origin, isD = c.g === state.dest;
      const size = isO ? 16 : isD || c.rank ? 13.5 : groupInfo[c.g].imp >= 4 ? 13 : 12;
      const font = `${isO || isD || c.rank || groupInfo[c.g].imp >= 3 ? 700 : 400} ${size}px ${F_STA}`;
      const name = groupName(c.g);
      const nw_ = measure(name, font);
      const showMin = active && c.m > 0 && !isO;
      const mfont = `600 ${size + 1}px ${F_NUM}`;
      const mtxt = showMin ? String(c.m) : '';
      const mw = showMin ? measure(mtxt, mfont) + 4 : 0;
      const badge = c.rank ? size + 4 : 0;
      const w = badge + nw_ + mw, h = size + 4, d = r + 4;
      const opts = [[c.x + d, c.y - h / 2], [c.x - d - w, c.y - h / 2], [c.x - w / 2, c.y - d - h], [c.x - w / 2, c.y + d]];
      let at = null;
      for (const o of opts) if (free(o[0], o[1], w, h)) { at = o; break; }
      // the labels that answer the question may sit over other stations' dots
      if (!at && c.pri >= 7e5) for (const o of opts) if (free(o[0], o[1], w, h, false)) { at = o; break; }
      if (!at) continue;
      placed.push([at[0] - 2, at[1] - 1, w + 4, h + 2]);
      jobs.push({ ...c, at, font, name, nw: nw_, mfont, mtxt, badge, size, h, isO, isD });
    }
    // municipality names, faint, only where space remains
    if (z > 9.3 && z < 13.2) {
      const pf = `400 ${z < 11 ? 11 : 12}px ${tok('--f-ui')}`;
      const minArea = z < 10 ? 300 : z < 11 ? 60 : z < 12 ? 15 : 0;
      for (const lb of base.labels) {
        if (lb.area < minArea) break;
        if (!inView(lb.c[0], lb.c[1])) continue;
        const p = map.project(lb.c), w = measure(lb.name, pf);
        const x = p.x - w / 2, y = p.y - 7;
        if (!free(x, y, w, 14)) continue;
        placed.push([x - 6, y - 4, w + 12, 22]);
        jobs.push({ place: true, at: [x, y], font: pf, name: lb.name });
      }
    }
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const j of jobs.reverse()) {
      if (j.place) {
        ctx.font = j.font; ctx.fillStyle = place; ctx.globalAlpha = .9;
        ctx.fillText(j.name, j.at[0], j.at[1] + 7); ctx.globalAlpha = 1; continue;
      }
      let x = j.at[0]; const cy = j.at[1] + j.h / 2;
      if (j.badge) {
        const rr = j.size / 2 + 1;
        ctx.beginPath(); ctx.arc(x + rr, cy, rr, 0, Math.PI * 2);
        const bc = rampAt(j.m / state.budget);
        ctx.fillStyle = bc; ctx.fill();
        ctx.lineWidth = 1.5; ctx.strokeStyle = halo; ctx.stroke();
        ctx.font = `700 ${j.size - 1}px ${F_NUM}`; ctx.fillStyle = inkOn(bc); ctx.textAlign = 'center';
        ctx.fillText(String(j.rank), x + rr, cy + .5); ctx.textAlign = 'left';
        x += j.badge;
      }
      ctx.font = j.font;
      ctx.lineWidth = j.isO ? 4.5 : 3.2; ctx.strokeStyle = halo;
      ctx.strokeText(j.name, x, cy); ctx.fillStyle = ink; ctx.fillText(j.name, x, cy);
      if (j.mtxt) {
        const mx = x + j.nw + 4;
        ctx.font = j.mfont; ctx.lineWidth = 3.2; ctx.strokeStyle = halo; ctx.strokeText(j.mtxt, mx, cy);
        ctx.fillStyle = mixForText(rampAt(j.m / state.budget)); ctx.fillText(j.mtxt, mx, cy);
      }
    }
  }
  // ramp colours are light at the start; darken them for text on light maps
  function mixForText(c) { return isDark() ? c : mix(c, '#000000', .28); }

  // ------------------------------------------------------------ query
  function railFilter() {
    if (state.ops === 'all') return null;
    return Uint8Array.from(net.railways, r => state.ops === 'jr' ? (r.op.startsWith('JR-') ? 1 : 0) : (r.op === 'TokyoMetro' || r.op === 'Toei' ? 1 : 0));
  }

  let queued = false;
  function runSoon() { if (!queued) { queued = true; requestAnimationFrame(() => { queued = false; run(); }); } }
  function run() {
    if (state.origin < 0) return;
    result = nw.query({ group: state.origin, cal: state.cal, time: state.time, budget: state.budget, cats: state.cats, xfer: state.xfer, railAllowed: railFilter() });
    const G = groupInfo.length;
    groupMin = new Int16Array(G).fill(-1); groupBest = new Int32Array(G).fill(-1);
    for (let s = 0; s < nw.S; s++) {
      const m = result.minutes(s);
      if (m === null) continue;
      const g = nw.stGroup[s];
      if (groupMin[g] < 0 || m < groupMin[g]) { groupMin[g] = m; groupBest[g] = s; }
    }
    ridden = result.ridden();
    // farthest reachable, by straight-line distance
    const oc = groupInfo[state.origin].c;
    const list = [];
    for (let g = 0; g < G; g++) if (groupMin[g] >= 0 && g !== state.origin && groupInfo[g].c) list.push([g, haversine(oc, groupInfo[g].c)]);
    list.sort((a, b) => b[1] - a[1]);
    far = list.slice(0, 10).map(x => x[0]);
    const lines = new Set(); for (const k of ridden.keys()) lines.add(net.railways[Math.floor(k / 512)].op + net.railways[Math.floor(k / 512)].ja);
    renderResults(list, lines.size);
    updateWalk();
    updateSens();
    if (state.dest >= 0 && groupMin[state.dest] < 0) state.dest = -1;
    applyStates(false);
    if (state.dest >= 0) showJourney(state.dest, false); else { setPath([]); if (!$('#journey').hidden) closeJourney(); }
    updatePopup();
    drawLabelsSoon();
  }

  // ------------------------------------------------------------ departure sensitivity
  // For each minute in a one-hour window around the chosen time: how far can
  // you get? Computed in small chunks so the controls stay responsive.
  const sens = { key: '', t0: -1, data: [], gen: 0, hover: -1 };
  function sensKey() { return [state.origin, state.cal, state.budget, state.cats.join(), state.xfer, state.ops].join('|'); }
  function updateSens() {
    const key = sensKey();
    if (key === sens.key && state.time >= sens.t0 + 5 && state.time <= sens.t0 + 54) { drawSens(); return; }
    sens.key = key;
    sens.t0 = Math.max(240, Math.min(1440, Math.floor((state.time - 20) / 5) * 5));
    sens.data = new Array(60).fill(null);
    const gen = ++sens.gen;
    const oc = groupInfo[state.origin].c;
    const dist = new Float32Array(nw.S);
    for (let s = 0; s < nw.S; s++) dist[s] = nw.coord[s] ? haversine(oc, nw.coord[s]) : 0;
    const rails = railFilter();
    let i = 0;
    const step = () => {
      if (gen !== sens.gen) return;
      const end = Math.min(60, i + 6);
      for (; i < end; i++) {
        const r = nw.query({ group: state.origin, cal: state.cal, time: sens.t0 + i, budget: state.budget, cats: state.cats, xfer: state.xfer, railAllowed: rails });
        let best = 0, bs = -1;
        const seen = new Uint8Array(groupInfo.length); let n = 0;
        for (let s = 0; s < nw.S; s++) {
          if (r.arrive[s] === INF) continue;
          const g = nw.stGroup[s];
          if (!seen[g] && g !== state.origin) { seen[g] = 1; n++; }
          if (dist[s] > best) { best = dist[s]; bs = s; }
        }
        sens.data[i] = { km: best / 1000, s: bs, n };
      }
      drawSens();
      if (i < 60) setTimeout(step, 0);
    };
    setTimeout(step, 30);
    drawSens();
  }
  function drawSens() {
    const svg = $('#sensSvg'), W = svg.clientWidth || 340, H = 46;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const vals = sens.data.filter(Boolean).map(d => d.km);
    const max = Math.max(5, Math.ceil(Math.max(0, ...vals) / 5) * 5);
    const bw = W / 60, top = 4, base = H - 1;
    let out = `<line class="axis" x1="0" x2="${W}" y1="${base + .5}" y2="${base + .5}"/>`;
    sens.data.forEach((d, i) => {
      if (!d) return;
      const h = Math.max(1, (base - top) * d.km / max);
      const x = i * bw + 1, w = Math.max(1, bw - 2), y = base - h, r = Math.min(1.5, w / 2);
      const cls = sens.t0 + i === state.time ? 'b on' : i === sens.hover ? 'b hov' : 'b';
      out += `<path class="${cls}" d="M${x} ${base}V${y + r}Q${x} ${y} ${x + r} ${y}H${x + w - r}Q${x + w} ${y} ${x + w} ${y + r}V${base}Z"/>`;
    });
    svg.innerHTML = out;
    const done = sens.data.every(Boolean);
    $('#sensMax').textContent = done ? `纵轴 0–${max} km` : '计算中…';
    $('#sensTicks').innerHTML = [0, 15, 30, 45].map(i => `<span style="left:${(i + .5) / 60 * 100}%">${hhmm(sens.t0 + i)}</span>`).join('');
    if (sens.hover >= 0 && sens.data[sens.hover]) {
      const d = sens.data[sens.hover], tip = $('#sensTip');
      tip.textContent = `${hhmm(sens.t0 + sens.hover)} 出发 · 最远 ${d.s >= 0 ? groupName(nw.stGroup[d.s]) : '—'} ${d.km.toFixed(1)} km · ${d.n} 站`;
      tip.style.left = `${Math.max(22, Math.min(78, (sens.hover + .5) / 60 * 100))}%`;
      tip.hidden = false;
    } else $('#sensTip').hidden = true;
  }
  function initSens() {
    const svg = $('#sensSvg');
    const idx = e => { const r = svg.getBoundingClientRect(); return Math.max(0, Math.min(59, Math.floor((e.clientX - r.left) / r.width * 60))); };
    svg.addEventListener('pointermove', e => { sens.hover = idx(e); drawSens(); });
    svg.addEventListener('pointerleave', () => { sens.hover = -1; drawSens(); });
    svg.addEventListener('click', e => { state.time = sens.t0 + idx(e); renderWhen(); run(); });
    addEventListener('resize', drawSens);
  }

  function updateWalk() {
    const feats = [];
    if (state.walk && groupMin) {
      const B = state.budget;
      groupMin.forEach((m, g) => {
        if (m < 0 || !groupInfo[g].c) return;
        const r3 = Math.min(B - m, WALK_CAP) * WALK;
        const r2 = Math.min(B * 2 / 3 - m, WALK_CAP) * WALK;
        const r1 = Math.min(B / 3 - m, WALK_CAP) * WALK;
        if (r3 <= 0) return;
        feats.push({ type: 'Feature', properties: { r3, r2: Math.max(0, r2), r1: Math.max(0, r1) }, geometry: { type: 'Point', coordinates: groupInfo[g].c } });
      });
    }
    map.getSource('walk').setData({ type: 'FeatureCollection', features: feats });
  }

  // ------------------------------------------------------------ journey on the map
  function setPath(keys) {
    for (const z of ZOOMS) {
      const src = map.getSource(`path${z}`);
      if (!src) continue;
      const feats = [];
      for (const k of keys) for (const p of sectionIndex[z].get(k) || []) {
        const r = net.railways[Math.floor(k / 512)];
        feats.push({ type: 'Feature', properties: { cl: lineColor(r.color, false), cd: lineColor(r.color, true) }, geometry: { type: 'LineString', coordinates: p.coords } });
      }
      src.setData({ type: 'FeatureCollection', features: feats });
    }
  }

  function journeyKeys(j) {
    const keys = [];
    for (const leg of j.legs) {
      if (leg.kind !== 'ride') continue;
      for (let i = 0; i + 1 < leg.stops.length; i++) {
        const a = leg.stops[i], b = leg.stops[i + 1];
        if (a.trip !== b.trip && nw.tripRail[a.trip] !== nw.tripRail[b.trip]) continue;
        const ri = nw.tripRail[b.trip];
        const la = a.trip === b.trip ? a.local : net.railways[ri].stations.indexOf(a.s);
        if (la < 0) continue;
        for (const k of nw.sections(ri, la, b.local)) keys.push(ri * 512 + k);
      }
    }
    return keys;
  }

  // ------------------------------------------------------------ UI
  function initUI() {
    window.tokyoReach = { map, state, groupInfo: () => groupInfo, anchors };
    resizeCanvas();
    addEventListener('resize', resizeCanvas);
    map.on('render', drawLabelsSoon);
    map.on('resize', resizeCanvas);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', restyle);
    new MutationObserver(restyle).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    if (document.fonts) document.fonts.ready.then(() => { widthCache.clear(); drawLabelsSoon(); });

    // map clicks → nearest station
    const nearest = (pt, maxd) => {
      let best = -1, bd = maxd * maxd;
      for (const h of hits) { const dx = h.x - pt.x, dy = h.y - pt.y, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = h.g; } }
      return best;
    };
    const stationLayers = () => ZOOMS.flatMap(z => [`stcl${z}`, `stcc${z}`]).filter(id => map.getLayer(id));
    const pickAt = (pt, tol) => {
      const f = map.queryRenderedFeatures([[pt.x - tol, pt.y - tol], [pt.x + tol, pt.y + tol]], { layers: stationLayers() });
      if (f.length) {
        let best = -1, bd = Infinity;
        for (const x of f) { const g = x.id; const a = anchors[variant(map.getZoom())]; const p = map.project([a[g * 2], a[g * 2 + 1]]); const d = (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2; if (d < bd) { bd = d; best = g; } }
        if (best >= 0) return best;
      }
      return nearest(pt, tol + 8);
    };
    map.on('click', e => {
      const g = pickAt(e.point, e.originalEvent && e.originalEvent.pointerType === 'touch' ? 14 : 6);
      if (g < 0) { closePopup(); return; }
      openPopup(g);
    });
    map.on('mousemove', e => { document.body.classList.toggle('hover-station', pickAt(e.point, 5) >= 0); });
    $('#zin').onclick = () => map.zoomIn(); $('#zout').onclick = () => map.zoomOut();

    // search
    const q = $('#q'), sug = $('#suggest');
    let hits_ = [], sel = 0;
    const renderSug = () => {
      if (!hits_.length) { sug.hidden = true; return; }
      sug.innerHTML = hits_.map((g, i) => {
        const gi = groupInfo[g];
        const ops = [...new Set(gi.lines.map(r => net.railways[r].op))].map(opName).join(' · ');
        return `<li role="option" data-g="${g}" aria-selected="${i === sel}"><span class="n">${esc(groupName(g))}<small>${esc(state.lang === 'en' ? net.stations[gi.stations[0]].ja : net.stations[gi.stations[0]].en)}</small></span>
          <span class="dots">${gi.lines.slice(0, 12).map(r => `<i class="dot" style="background:${lineColor(net.railways[r].color, isDark())}"></i>`).join('')}</span>
          <span class="ops">${esc(ops)}</span></li>`;
      }).join('');
      sug.hidden = false;
    };
    const search = () => {
      const t = q.value.trim().toLowerCase().replace(/[\s\-ー・]/g, '');
      if (!t) { hits_ = []; renderSug(); return; }
      const scored = [];
      groupInfo.forEach((gi, g) => {
        let best = 0;
        for (const n of gi.names) {
          const nn = n.toLowerCase().replace(/[\s\-ー・]/g, '');
          if (nn === t) best = Math.max(best, 3); else if (nn.startsWith(t)) best = Math.max(best, 2); else if (nn.includes(t)) best = Math.max(best, 1);
        }
        if (best) scored.push([g, best * 100 + gi.imp]);
      });
      scored.sort((a, b) => b[1] - a[1]);
      hits_ = scored.slice(0, 8).map(x => x[0]); sel = 0; renderSug();
    };
    q.addEventListener('input', search);
    q.addEventListener('focus', () => { if (q.value) search(); });
    q.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { sel = Math.min(hits_.length - 1, sel + 1); renderSug(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { sel = Math.max(0, sel - 1); renderSug(); e.preventDefault(); }
      else if (e.key === 'Enter' && hits_.length) { pick(hits_[sel]); }
      else if (e.key === 'Escape') { sug.hidden = true; q.blur(); }
    });
    sug.addEventListener('pointerdown', e => { const li = e.target.closest('li'); if (li) { e.preventDefault(); pick(+li.dataset.g); } });
    q.addEventListener('blur', () => setTimeout(() => { sug.hidden = true; }, 120));
    const pick = g => { q.value = ''; hits_ = []; sug.hidden = true; q.blur(); setOrigin(g, true); };

    // day type
    $('#cal').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.cal = +b.dataset.v; renderWhen(); runSoon(); });
    // time
    const tr = $('#timeRange');
    tr.addEventListener('input', () => { state.time = +tr.value; renderWhen(); runSoon(); });
    $('#tminus').onclick = () => { state.time = Math.max(240, state.time - 5); renderWhen(); runSoon(); };
    $('#tplus').onclick = () => { state.time = Math.min(1500, state.time + 5); renderWhen(); runSoon(); };
    $('#tnow').onclick = () => { const n = tokyoNow(); state.time = Math.max(240, Math.min(1500, n.minutes)); state.cal = n.cal; renderWhen(); runSoon(); };
    // budget
    const br = $('#budgetRange');
    br.addEventListener('input', () => { state.budget = +br.value; renderBudget(); runSoon(); savePrefs(); });
    $('#presets').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.budget = +b.dataset.v; renderBudget(); runSoon(); savePrefs(); });
    // types
    $('#types').addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b) return;
      const i = +b.dataset.i; const next = state.cats.slice(); next[i] = !next[i];
      if (!next.some(Boolean)) return;
      state.cats = next; renderTypes(); runSoon(); savePrefs();
    });
    // advanced
    $('#xfer').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.xfer = +b.dataset.v; renderMore(); runSoon(); savePrefs(); });
    $('#ops').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.ops = b.dataset.v; renderMore(); runSoon(); savePrefs(); });
    $('#lang').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; state.lang = b.dataset.v; widthCache.clear(); renderAll(); run(); savePrefs(); });
    $('#walk').onclick = () => { state.walk = !state.walk; renderMore(); updateWalk(); savePrefs(); };

    // results list
    $('#far').addEventListener('click', e => { const li = e.target.closest('li[data-g]'); if (li) selectDest(+li.dataset.g, true); });
    $('#far').addEventListener('keydown', e => { const li = e.target.closest('li[data-g]'); if (li && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); selectDest(+li.dataset.g, true); } });
    $('#back').onclick = () => { state.dest = -1; closeJourney(); applyStates(false); setPath([]); drawLabelsSoon(); };
    initSheet();
    initSens();
    placeResults();
    addEventListener('resize', () => { placeResults(); drawSens(); });
    renderAll();
  }

  const WIDE = 1180;
  function placeResults() {
    const wide = innerWidth >= WIDE;
    const side = $('#side'), target = wide ? $('#sideScroll') : $('#panel .scroll');
    const res = $('#results'), jour = $('#journey');
    if (res.parentElement !== target) {
      if (wide) { target.append(res, jour); }
      else { const credit = $('#panel .credit'); target.insertBefore(res, credit); target.insertBefore(jour, credit); }
    }
    side.hidden = !wide;
  }
  function renderAll() { renderOrigin(); renderWhen(); renderBudget(); renderTypes(); renderMore(); }

  function setOrigin(g, fly) {
    state.origin = g; state.dest = -1;
    closePopup(); closeJourney();
    renderOrigin(); renderWhen(); renderBudget(); renderTypes(); renderMore();
    restyle();
    run();
    savePrefs();
    placeOriginPin();
    fitReach(fly ? 700 : 0);
  }
  function mapPadding() {
    const m = innerWidth < 760;
    return m ? { top: 40, bottom: 120, left: 24, right: 24 } : { top: 50, bottom: 50, left: parseFloat(tok('--panel-w')) + 60, right: innerWidth >= WIDE ? 336 + 60 : 70 };
  }
  // Frame the reachable area (ignoring the farthest few percent) beside the panel.
  function fitReach(duration) {
    if (!groupMin) return;
    const oc = groupInfo[state.origin].c;
    const pts = [];
    groupMin.forEach((m, g) => { if (m >= 0 && groupInfo[g].c) pts.push(groupInfo[g].c); });
    if (pts.length < 2) { map.easeTo({ center: oc, zoom: 12, duration, padding: mapPadding() }); return; }
    const xs = pts.map(p => p[0]).sort((a, b) => a - b), ys = pts.map(p => p[1]).sort((a, b) => a - b);
    const q = (arr, f) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(f * (arr.length - 1))))];
    const b = new maplibregl.LngLatBounds([Math.min(q(xs, .02), oc[0]), Math.min(q(ys, .02), oc[1])], [Math.max(q(xs, .98), oc[0]), Math.max(q(ys, .98), oc[1])]);
    map.fitBounds(b, { padding: mapPadding(), maxZoom: 13, duration });
  }

  let originMarker = null;
  function placeOriginPin() {
    const c = groupInfo[state.origin].c;
    if (!originMarker) {
      const el = document.createElement('div'); el.className = 'pin'; el.innerHTML = '<b></b><i></i>';
      originMarker = new maplibregl.Marker({ element: el, anchor: 'center' });
    }
    originMarker.setLngLat(c).addTo(map);
  }

  function lineChips(g, max = 14) {
    const gi = groupInfo[g];
    return gi.lines.slice(0, max).map(r => `<span class="lchip"><i style="background:${net.railways[r].color}"></i>${esc(railName(r))}</span>`).join('') + (gi.lines.length > max ? `<span class="lchip">+${gi.lines.length - max}</span>` : '');
  }
  function renderOrigin() {
    const g = state.origin, el = $('#originCard');
    if (g < 0) { el.innerHTML = ''; return; }
    const s0 = groupInfo[g].stations[0], st = net.stations[s0];
    const cols = groupInfo[g].lines.map(r => net.railways[r].color);
    el.innerHTML = `<div class="sign" aria-label="出发站">
      <div class="stripes">${cols.map(c => `<i style="background:${c}"></i>`).join('')}</div>
      <div class="body"><div class="ja">${esc(st.ja)}</div><div class="en">${esc(st.en)}</div>${st.zh !== st.ja ? `<div class="zh">${esc(st.zh)}</div>` : ''}</div>
      <div class="rail">${lineChips(g)}</div></div>`;
  }
  function renderWhen() {
    for (const b of $('#cal').children) b.setAttribute('aria-pressed', String(+b.dataset.v === state.cal));
    $('#timeVal').textContent = hhmm(state.time);
    $('#nextday').hidden = state.time < 1440;
    $('#timeRange').value = state.time;
  }
  function renderBudget() {
    $('#budgetVal').innerHTML = `${state.budget}<small>分钟</small>`;
    $('#budgetRange').value = state.budget;
    for (const b of $('#presets').children) b.setAttribute('aria-pressed', String(+b.dataset.v === state.budget));
    const B = state.budget;
    $('#rampTicks').innerHTML = [0, .25, .5, .75, 1].map(f => `<span style="left:${f * 100}%;transform:translateX(${f === 0 ? '0' : f === 1 ? '-100%' : '-50%'})">${Math.round(B * f)}′</span>`).join('');
  }
  function renderTypes() { [...$('#types').children].forEach((b, i) => b.setAttribute('aria-pressed', String(state.cats[i]))); }
  function renderMore() {
    for (const b of $('#xfer').children) b.setAttribute('aria-pressed', String(+b.dataset.v === state.xfer));
    for (const b of $('#ops').children) b.setAttribute('aria-pressed', String(b.dataset.v === state.ops));
    for (const b of $('#lang').children) b.setAttribute('aria-pressed', String(b.dataset.v === state.lang));
    $('#walk').setAttribute('aria-checked', String(state.walk));
  }

  function renderPeek(list) {
    const cal = { 1: '工作日', 2: '周六', 4: '周日' }[state.cal];
    $('#pkName').textContent = state.origin >= 0 ? groupName(state.origin) : '—';
    $('#pkWhen').textContent = `${cal} ${hhmm(state.time)} · ${state.budget}′`;
    const top = list && list[0];
    $('#pkStat').textContent = list ? `可到 ${list.length} 站${top ? ` · 最远 ${groupName(top[0])} ${(top[1] / 1000).toFixed(1)} km` : ''}` : '';
  }
  function renderResults(list, nLines) {
    renderPeek(list);
    const n = list.length;
    const top = list[0];
    $('#summary').innerHTML = `
      <div class="stat"><b>${n}</b><span>可到达车站</span></div>
      <div class="stat"><b>${top ? (top[1] / 1000).toFixed(1) : '0'}<small>km</small></b><span>${top ? esc(groupName(top[0])) : '—'}</span></div>
      <div class="stat"><b>${nLines}</b><span>乘坐线路</span></div>`;
    $('#farTitle').innerHTML = `最远的车站 <em>按直线距离</em>`;
    if (!n) { $('#far').innerHTML = `<li class="empty" style="display:block;cursor:default">这个时段 ${state.budget} 分钟内坐不上车。试试放宽车型或调整出发时间。</li>`; return; }
    $('#far').innerHTML = list.slice(0, 10).map(([g, d], i) => {
      const m = groupMin[g], s = groupBest[g];
      const j = result.journey(s);
      const rides = j ? j.legs.filter(l => l.kind === 'ride') : [];
      const cols = [...new Set(rides.map(l => net.railways[nw.tripRail[l.trips[0]]].color))];
      const via = rides.length > 1 ? `换乘 ${rides.length - 1} 次` : '直达';
      return `<li data-g="${g}" tabindex="0" aria-current="${g === state.dest}"><span class="rk">${i + 1}</span>
        <span class="nm"><b>${esc(groupName(g))}</b><span>${cols.map(c => `<i class="dot" style="background:${c}"></i>`).join('')}${via}</span></span>
        <span class="mins" style="background:${rampAt(m / state.budget)};color:${inkOn(rampAt(m / state.budget))}">${m}′</span><span class="km">${(d / 1000).toFixed(1)}<small> km</small></span></li>`;
    }).join('');
  }

  // ------------------------------------------------------------ popup
  let popMarker = null, popGroup = -1;
  function openPopup(g) {
    popGroup = g;
    if (!popMarker) {
      const el = document.createElement('div'); el.className = 'pop';
      el.addEventListener('click', e => {
        const b = e.target.closest('button'); if (!b) return;
        if (b.dataset.a === 'origin') setOrigin(popGroup, false);
        if (b.dataset.a === 'route') selectDest(popGroup, false);
      });
      popMarker = new maplibregl.Marker({ element: el, anchor: 'bottom', offset: [0, -12] });
    }
    updatePopup();
    const c = [anchors[variant(map.getZoom())][g * 2], anchors[variant(map.getZoom())][g * 2 + 1]];
    popMarker.setLngLat(c).addTo(map);
  }
  function updatePopup() {
    if (!popMarker || popGroup < 0) return;
    const g = popGroup, el = popMarker.getElement();
    const m = groupMin ? groupMin[g] : -1;
    let sub, btns;
    if (g === state.origin) { sub = `出发站 · ${hhmm(state.time)}`; btns = ''; }
    else if (m >= 0) {
      const j = result.journey(groupBest[g]);
      const n = j ? j.legs.filter(l => l.kind === 'ride').length : 0;
      sub = `${hhmm(state.time + m)} 到达 · ${n > 1 ? `换乘 ${n - 1} 次` : '直达'}`;
      btns = `<button data-a="route" class="primary">看路线</button><button data-a="origin">设为出发站</button>`;
    } else { sub = `${state.budget} 分钟内到不了`; btns = `<button data-a="origin" class="primary">设为出发站</button>`; }
    el.innerHTML = `<div class="t"><b>${esc(groupName(g))}</b>${m > 0 ? `<span class="mins" style="background:${rampAt(m / state.budget)};color:${inkOn(rampAt(m / state.budget))}">${m}′</span>` : ''}</div>
      <div class="sub">${sub}</div>${btns ? `<div class="btns">${btns}</div>` : ''}`;
  }
  function closePopup() { if (popMarker) popMarker.remove(); popGroup = -1; }

  // ------------------------------------------------------------ journey panel
  function selectDest(g, fly) {
    closePopup();
    state.dest = g;
    applyStates(false);
    showJourney(g, fly);
    drawLabelsSoon();
    if (innerWidth < 760) setSheet('half');
  }
  function terminalOf(trip) {
    let t = trip, guard = 0;
    while (nw.nextStart[t + 1] > nw.nextStart[t] && guard++ < 12) t = nw.nextTo[nw.nextStart[t]];
    return nw.stopStation[nw.tripStart[t + 1] - 1];
  }
  function showJourney(g, fly) {
    const s = groupBest[g];
    const j = result.journey(s);
    if (!j) return;
    setPath(journeyKeys(j));
    const B = state.budget, m = groupMin[g];
    const rows = [];
    const legs = j.legs;
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      if (leg.kind === 'walk') continue;
      const prev = legs[i - 1], prevRide = legs.slice(0, i).reverse().find(l => l.kind === 'ride');
      if (!prevRide) rows.push(`<div class="stop"><time>${hhmm(leg.dep)}</time><i class="node"></i><span class="sn">${esc(stName(leg.from))}</span></div>`);
      else {
        const walked = prev && prev.kind === 'walk';
        const same = stName(prevRide.to) === stName(leg.from);
        const gap = leg.dep - prevRide.arr;
        rows.push(`<div class="walk"><span></span><i class="bar"></i><span>${walked && !same ? `步行至 ${esc(stName(leg.from))} · ` : '换乘 · '}等候共 ${gap} 分钟</span></div>`);
        rows.push(`<div class="stop"><time>${hhmm(leg.dep)}</time><i class="node"></i><span class="sn">${esc(stName(leg.from))}</span></div>`);
      }
      const rails = []; for (const t of leg.trips) { const ri = nw.tripRail[t]; if (!rails.includes(ri)) rails.push(ri); }
      const t0 = leg.trips[0], cat = net.types[nw.tripType[t0]].cat;
      const types = [...new Set(leg.trips.map(t => typeName(nw.tripType[t])))];
      const color = lineColor(net.railways[rails[0]].color, isDark());
      const nStops = leg.stops.length - 1;
      rows.push(`<div class="ride"><span></span><i class="bar" style="background:linear-gradient(${rails.map(r => lineColor(net.railways[r].color, isDark())).join(',')}${rails.length === 1 ? ',' + color : ''})"></i>
        <div class="info"><div><b>${rails.map(r => esc(railName(r))).join(' → ')}</b>${types.map(t => `<span class="tt${cat === 2 ? ' paid' : ''}">${esc(t)}</span>`).join('')}</div>
        <div>往 ${esc(stName(terminalOf(leg.trips[leg.trips.length - 1])))} 方向 · ${nStops} 站 · ${leg.arr - leg.dep} 分钟${rails.length > 1 ? ' · 直通运行，不用下车' : ''}${cat === 2 ? ' · 需特急券' : ''}</div></div></div>`);
      rows.push(`<div class="stop"><time>${hhmm(leg.arr)}</time><i class="node"></i><span class="sn">${esc(stName(leg.to))}</span></div>`);
    }
    const last = legs[legs.length - 1];
    if (last && last.kind === 'walk' && stName(last.to) !== stName(last.from)) rows.push(`<div class="walk"><span></span><i class="bar"></i><span>步行至 ${esc(stName(last.to))}</span></div>`);
    $('#journeyBody').innerHTML = `<div class="head"><b>${esc(stName(groupInfo[state.origin].stations[0]))} → ${esc(groupName(g))}</b><span class="mins" style="background:${rampAt(m / B)};color:${inkOn(rampAt(m / B))}">${m}′</span></div>
      <div class="trip">${rows.join('')}</div>
      <div class="actions"><button class="textbtn" id="jOrigin">从 ${esc(groupName(g))} 出发</button></div>`;
    $('#jOrigin').onclick = () => setOrigin(g, true);
    $('#results').hidden = true; $('#journey').hidden = false;
    const sc = $('#journey').closest('.scroll');
    if (sc) sc.scrollTo({ top: $('#journey').getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 8, behavior: 'smooth' });
    for (const li of $('#far').children) li.setAttribute('aria-current', String(+li.dataset.g === g));
    if (fly && groupInfo[g].c) {
      const b = new maplibregl.LngLatBounds(groupInfo[state.origin].c, groupInfo[state.origin].c);
      b.extend(groupInfo[g].c);
      const mobile = innerWidth < 760;
      const pad = mobile ? { top: 60, bottom: innerHeight * .5 + 20, left: 40, right: 40 } : { ...mapPadding(), top: 80, bottom: 80 };
      map.fitBounds(b, { padding: pad, maxZoom: 13, duration: 700 });
    }
  }
  function closeJourney() { $('#journey').hidden = true; $('#results').hidden = false; }

  // ------------------------------------------------------------ bottom sheet (phones)
  let sheetState = 'peek';
  function setSheet(s) {
    sheetState = s;
    const panel = $('#panel'), h = panel.getBoundingClientRect().height;
    const visible = s === 'peek' ? 96 : s === 'half' ? innerHeight * .5 : h;
    panel.style.setProperty('--sheet-y', `${Math.max(0, h - visible)}px`);
  }
  function initSheet() {
    const panel = $('#panel');
    const mq = matchMedia('(max-width: 760px)');
    const apply = () => { if (mq.matches) setSheet(sheetState); else panel.style.removeProperty('--sheet-y'); };
    mq.addEventListener('change', apply); addEventListener('resize', apply); apply();
    let startY = 0, startT = 0, dragging = false;
    const grab = e => {
      if (!mq.matches) return;
      dragging = true; startY = e.clientY; panel.classList.add('dragging');
      startT = parseFloat(getComputedStyle(panel).getPropertyValue('--sheet-y')) || 0;
      e.currentTarget.setPointerCapture(e.pointerId);
    };
    const move = e => { if (!dragging) return; const y = Math.max(0, startT + e.clientY - startY); panel.style.setProperty('--sheet-y', `${y}px`); };
    const drop = e => {
      if (!dragging) return; dragging = false; panel.classList.remove('dragging');
      const dy = e.clientY - startY;
      if (Math.abs(dy) < 6) { setSheet(sheetState === 'peek' ? 'half' : sheetState === 'half' ? 'full' : 'peek'); return; }
      const order = ['full', 'half', 'peek'];
      let i = order.indexOf(sheetState) + (dy > 0 ? 1 : -1);
      if (Math.abs(dy) > innerHeight * .35) i += dy > 0 ? 1 : -1;
      setSheet(order[Math.max(0, Math.min(2, i))]);
    };
    for (const el of [$('.handle'), $('#peek')]) { el.addEventListener('pointerdown', grab); el.addEventListener('pointermove', move); el.addEventListener('pointerup', drop); el.addEventListener('pointercancel', drop); }
    $('#q').addEventListener('focus', () => { if (mq.matches) setSheet('full'); });
  }

  boot().catch(err => {
    console.error(err);
    status.textContent = `数据加载失败：${err.message}。刷新页面重试。`;
    $('#loading .meter').hidden = true;
  });
})();
