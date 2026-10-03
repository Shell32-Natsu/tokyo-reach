/* Tokyo Reach — data decoding and reachability engine.
 *
 * The engine is a Connection Scan (CSA): every hop of every train between two
 * consecutive stops is one "connection"; scanning them in departure order from
 * the chosen start time gives the earliest arrival at every station, with
 * transfers inside a station group, through-running trains (直通運転) kept as
 * one ride, and train-type filters.
 */
(function (root) {
  'use strict';

  const INF = 0x7fff;

  // ------------------------------------------------------------ decoding
  class Reader {
    constructor(u8) { this.u8 = u8; this.p = 0; }
    tag() { const s = String.fromCharCode(...this.u8.subarray(this.p, this.p + 4)); this.p += 4; return s; }
    uvar() {
      let v = 0, shift = 0, b;
      do { b = this.u8[this.p++]; v += (b & 0x7f) * 2 ** shift; shift += 7; } while (b & 0x80);
      return v;
    }
    svar() { const v = this.uvar(); return v % 2 ? -(v + 1) / 2 : v / 2; }
    line() {
      const n = this.uvar(), out = new Array(n);
      let x = 0, y = 0;
      for (let i = 0; i < n; i++) { x += this.svar(); y += this.svar(); out[i] = [x / 1e5, y / 1e5]; }
      return out;
    }
    str() { const n = this.uvar(); const s = new TextDecoder().decode(this.u8.subarray(this.p, this.p + n)); this.p += n; return s; }
  }

  function decodeBase(u8) {
    const r = new Reader(u8);
    if (r.tag() !== 'BASE') throw new Error('bad base file');
    const polys = () => { const n = r.uvar(), out = []; for (let i = 0; i < n; i++) { const k = r.uvar(), p = []; for (let j = 0; j < k; j++) p.push(r.line()); out.push(p); } return out; };
    const lines = () => { const n = r.uvar(), out = []; for (let i = 0; i < n; i++) out.push(r.line()); return out; };
    const land = polys(), landLo = polys(), pref = lines(), muni = lines();
    const n = r.uvar(), labels = [];
    for (let i = 0; i < n; i++) { const name = r.str(); const [c] = r.line(); labels.push({ name, c, area: r.uvar() }); }
    return { land, landLo, pref, muni, labels };
  }

  function decodeGeo(u8) {
    const r = new Reader(u8);
    if (r.tag() !== 'GEO1') throw new Error('bad geo file');
    const n = r.uvar(), sections = [];
    for (let i = 0; i < n; i++) {
      const ri = r.uvar(), k = r.uvar(), np = r.uvar(), pieces = [];
      for (let j = 0; j < np; j++) { const faint = r.uvar(); pieces.push({ faint, coords: r.line() }); }
      sections.push({ ri, k, pieces });
    }
    const ns = r.uvar(), snapped = new Array(ns);
    for (let i = 0; i < ns; i++) snapped[i] = r.line()[0];
    return { sections, snapped };
  }

  // ------------------------------------------------------------ geometry helpers
  function haversine(a, b) {
    const R = 6371008.8, toR = Math.PI / 180;
    const la1 = a[1] * toR, la2 = b[1] * toR, dla = la2 - la1, dlo = (b[0] - a[0]) * toR;
    const h = Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // ------------------------------------------------------------ network
  class Network {
    constructor(net, ttBytes) {
      this.net = net;
      const S = net.stations.length;
      this.S = S;
      this.coord = net.stations.map(s => s.c);
      this.stGroup = Int32Array.from(net.stations, s => s.g);
      this.stSub = Int32Array.from(net.stations, s => s.sg);
      this.stRail = Int32Array.from(net.stations, s => s.r);
      this.railLoop = net.railways.map(r => r.stations.length > 2 && r.stations[0] === r.stations[r.stations.length - 1]);
      this.typeCat = Uint8Array.from(net.types, t => t.cat);
      this._decodeTrips(ttBytes);
      this._buildTransfers();
      this.calCache = new Map();
    }

    _decodeTrips(u8) {
      const r = new Reader(u8);
      if (r.tag() !== 'TRIP') throw new Error('bad timetable file');
      const T = r.uvar();
      const tripRail = new Uint16Array(T), tripType = new Uint16Array(T), tripCal = new Uint8Array(T), tripDir = new Uint8Array(T);
      const tripStart = new Uint32Array(T + 1);
      // first pass sizes unknown; collect in growable arrays
      let cap = 1 << 21;
      let stSt = new Uint16Array(cap), stLi = new Uint8Array(cap), stArr = new Uint16Array(cap), stDep = new Uint16Array(cap);
      let n = 0;
      const rails = this.net.railways;
      for (let t = 0; t < T; t++) {
        const ri = r.uvar(); tripRail[t] = ri;
        tripType[t] = r.uvar();
        const f = r.uvar(); tripCal[t] = f & 7; tripDir[t] = f >> 3;
        const k = r.uvar();
        let time = r.uvar();
        tripStart[t] = n;
        if (n + k > cap) {
          cap *= 2;
          const g = (A, C) => { const b = new C(cap); b.set(A); return b; };
          stSt = g(stSt, Uint16Array); stLi = g(stLi, Uint8Array); stArr = g(stArr, Uint16Array); stDep = g(stDep, Uint16Array);
        }
        const list = rails[ri].stations;
        for (let i = 0; i < k; i++) {
          const li = r.uvar();
          time += r.uvar(); const a = time;
          time += r.uvar(); const d = time;
          stLi[n] = li; stSt[n] = list[li]; stArr[n] = a; stDep[n] = d; n++;
        }
      }
      tripStart[T] = n;
      const L = r.uvar();
      const linkFrom = new Uint32Array(L), linkTo = new Uint32Array(L);
      for (let i = 0; i < L; i++) { linkFrom[i] = r.uvar(); linkTo[i] = r.uvar(); }
      // CSR of next trips
      const nextStart = new Uint32Array(T + 1);
      for (let i = 0; i < L; i++) nextStart[linkFrom[i] + 1]++;
      for (let t = 0; t < T; t++) nextStart[t + 1] += nextStart[t];
      const nextTo = new Uint32Array(L), fill = nextStart.slice(0, T);
      for (let i = 0; i < L; i++) nextTo[fill[linkFrom[i]]++] = linkTo[i];
      Object.assign(this, {
        T, tripRail, tripType, tripCal, tripDir, tripStart, nextStart, nextTo,
        stopStation: stSt.subarray(0, n), stopLocal: stLi.subarray(0, n), stopArr: stArr.subarray(0, n), stopDep: stDep.subarray(0, n),
      });
    }

    // Walking transfers inside each station group. Minutes, before the
    // user's transfer multiplier.
    _buildTransfers() {
      const groups = this.net.groups;
      const start = new Uint32Array(this.S + 1), lists = [];
      for (let s = 0; s < this.S; s++) {
        const g = groups[this.stGroup[s]], own = this.stSub[s], out = [];
        g.forEach((sub, si) => {
          for (const o of sub) {
            if (o === s) continue;
            const a = this.coord[s], b = this.coord[o];
            const d = a && b ? haversine(a, b) : 150;
            const t = si === own ? Math.max(2, Math.round(d / 70) + 2) : Math.max(4, Math.round(d / 70) + 4);
            out.push([o, Math.min(t, 20)]);
          }
        });
        lists.push(out);
        start[s + 1] = start[s] + out.length;
      }
      this.xferStart = start;
      this.xferTo = new Uint16Array(start[this.S]);
      this.xferMin = new Uint8Array(start[this.S]);
      let k = 0;
      for (const out of lists) for (const [o, t] of out) { this.xferTo[k] = o; this.xferMin[k] = t; k++; }
    }

    // Section indices of railway ri between local station indices a and b
    // (section k joins station k-1 and station k; loop lines wrap around).
    sections(ri, a, b) {
      const idx = [];
      if (!this.railLoop[ri]) {
        const lo = Math.min(a, b), hi = Math.max(a, b);
        for (let k = lo + 1; k <= hi; k++) idx.push(k);
        return idx;
      }
      const n = this.net.railways[ri].stations.length - 1, aa = a % n, bb = b % n;
      const fwd = (bb - aa + n) % n, back = (aa - bb + n) % n;
      if (fwd <= back) for (let j = 1; j <= fwd; j++) idx.push(((aa + j - 1) % n) + 1);
      else for (let j = 0; j < back; j++) idx.push(((aa - j - 1 + n) % n) + 1);
      return idx;
    }

    // Connections for one calendar bit (1 weekday, 2 saturday, 4 holiday),
    // counting-sorted by departure minute.
    calendar(bit) {
      if (this.calCache.has(bit)) return this.calCache.get(bit);
      const { T, tripCal, tripStart, stopDep } = this;
      let n = 0;
      for (let t = 0; t < T; t++) if (tripCal[t] & bit) n += tripStart[t + 1] - tripStart[t] - 1;
      const MAXT = 3000;
      const count = new Uint32Array(MAXT + 1);
      for (let t = 0; t < T; t++) if (tripCal[t] & bit) for (let i = tripStart[t]; i < tripStart[t + 1] - 1; i++) count[Math.min(stopDep[i], MAXT - 1) + 1]++;
      for (let m = 0; m < MAXT; m++) count[m + 1] += count[m];
      const minuteStart = count.slice();
      const connStop = new Uint32Array(n), connTrip = new Uint32Array(n);
      const pos = count.slice(0, MAXT);
      for (let t = 0; t < T; t++) {
        if (!(tripCal[t] & bit)) continue;
        for (let i = tripStart[t]; i < tripStart[t + 1] - 1; i++) {
          const p = pos[Math.min(stopDep[i], MAXT - 1)]++;
          connStop[p] = i; connTrip[p] = t;
        }
      }
      const cal = { n, connStop, connTrip, minuteStart };
      this.calCache.set(bit, cal);
      return cal;
    }

    /* Earliest arrival from a station group.
     * q = { group, cal: 1|2|4, time (min), budget (min), cats: [bool,bool,bool],
     *       xfer: multiplier, ops: Set of operator prefixes to exclude (optional) } */
    query(q) {
      const cal = this.calendar(q.cal);
      const { S, T, stopStation, stopArr, stopDep, tripStart, tripType, typeCat, nextStart, nextTo, xferStart, xferTo, xferMin, tripRail } = this;
      const { connStop, connTrip, minuteStart } = cal;
      const t0 = q.time, tEnd = q.time + q.budget, mult = q.xfer || 1;
      const arrive = new Int16Array(S).fill(INF);
      const ready = new Int16Array(S).fill(INF);
      const arrConn = new Int32Array(S).fill(-1);   // train connection that brought us to s
      const walkFrom = new Int32Array(S).fill(-1);  // if s reached on foot: the station walked from
      const readyVia = new Int8Array(S).fill(-1);   // 0 origin, 1 train, 2 walk
      const readyConn = new Int32Array(S).fill(-1);
      const readyFrom = new Int32Array(S).fill(-1);
      const tripBoard = new Int32Array(T).fill(-1);  // connection index where this ride was boarded
      const tripPrev = new Int32Array(T).fill(-1);   // through-running: previous trip of the same ride
      const allowRail = q.railAllowed || null;
      const cats = q.cats || [true, true, false];

      const origin = [];
      for (const sub of this.net.groups[q.group]) for (const s of sub) origin.push(s);
      for (const s of origin) { arrive[s] = t0; ready[s] = t0; readyVia[s] = 0; }

      const sameStation = Math.max(1, Math.round(1 * mult));
      let c = minuteStart[Math.max(0, Math.min(t0, 2999))];
      const cEnd = minuteStart[Math.max(0, Math.min(tEnd + 1, 3000))];
      let scanned = 0;
      for (; c < cEnd; c++) {
        const t = connTrip[c];
        const i = connStop[c];
        const d = stopDep[i];
        if (d < t0) continue;
        let boarded = tripBoard[t] !== -1;
        if (!boarded) {
          if (!cats[typeCat[tripType[t]]]) continue;
          if (allowRail && !allowRail[tripRail[t]]) continue;
          const s = stopStation[i];
          if (ready[s] > d) continue;
          tripBoard[t] = c; boarded = true;
        }
        scanned++;
        const s2 = stopStation[i + 1], a = stopArr[i + 1];
        if (a <= tEnd) {
          if (a < arrive[s2]) { arrive[s2] = a; arrConn[s2] = c; walkFrom[s2] = -1; }
          if (a + sameStation < ready[s2]) { ready[s2] = a + sameStation; readyVia[s2] = 1; readyConn[s2] = c; }
          for (let k = xferStart[s2]; k < xferStart[s2 + 1]; k++) {
            const o = xferTo[k], ta = a + Math.round(xferMin[k] * mult);
            if (ta > tEnd) continue;
            if (ta < arrive[o]) { arrive[o] = ta; arrConn[o] = c; walkFrom[o] = s2; }
            if (ta < ready[o]) { ready[o] = ta; readyVia[o] = 2; readyConn[o] = c; readyFrom[o] = s2; }
          }
        }
        // end of this trip: the train continues as another trip (直通)
        if (i + 1 === tripStart[t + 1] - 1) {
          for (let k = nextStart[t]; k < nextStart[t + 1]; k++) {
            const n = nextTo[k];
            if (tripBoard[n] === -1 && cats[typeCat[tripType[n]]] && (!allowRail || allowRail[tripRail[n]])) { tripBoard[n] = tripBoard[t]; tripPrev[n] = t; }
          }
        }
      }
      return new Result(this, q, cal, { arrive, ready, arrConn, walkFrom, readyVia, readyConn, readyFrom, tripBoard, tripPrev, origin, scanned });
    }
  }

  // ------------------------------------------------------------ results
  class Result {
    constructor(nw, q, cal, st) { this.nw = nw; this.q = q; this.cal = cal; Object.assign(this, st); }

    reached(s) { return this.arrive[s] !== INF; }
    minutes(s) { return this.arrive[s] === INF ? null : this.arrive[s] - this.q.time; }

    // Legs of the best journey to station s.
    journey(s) {
      const { nw, cal } = this;
      const legs = [];
      if (!this.reached(s)) return null;
      if (this.origin.includes(s)) return { legs, arrive: this.arrive[s] };
      let cur = s, guard = 0;
      // final hop: train arrival (maybe followed by a walk inside the group)
      let conn = this.arrConn[s], walkTo = this.walkFrom[s] >= 0 ? s : -1;
      let alightStation = this.walkFrom[s] >= 0 ? this.walkFrom[s] : s;
      while (conn >= 0 && guard++ < 30) {
        if (walkTo >= 0) legs.unshift({ kind: 'walk', from: alightStation, to: walkTo });
        const trip = cal.connTrip[conn];
        const board = this.tripBoard[trip];
        const leg = this._rideLeg(board, conn);
        legs.unshift(leg);
        const bs = leg.from;
        const via = this.readyVia[bs];
        if (via === 0 || via === -1) break;
        conn = this.readyConn[bs];
        if (via === 2) { walkTo = bs; alightStation = this.readyFrom[bs]; }
        else { walkTo = -1; alightStation = bs; }
      }
      return { legs, arrive: this.arrive[s] };
    }

    _rideLeg(boardConn, alightConn) {
      const { nw, cal } = this;
      const bi = cal.connStop[boardConn], ai = cal.connStop[alightConn] + 1;
      // trips of the ride, first to last
      let t = cal.connTrip[alightConn];
      const trips = [t];
      const bt = cal.connTrip[boardConn];
      while (t !== bt && this.tripPrev[t] >= 0) { t = this.tripPrev[t]; trips.unshift(t); }
      const stops = [];
      trips.forEach((tr, idx) => {
        const from = idx === 0 ? bi : nw.tripStart[tr];
        const to = idx === trips.length - 1 ? ai : nw.tripStart[tr + 1] - 1;
        for (let i = from; i <= to; i++) {
          const prev = stops[stops.length - 1];
          if (prev && idx > 0 && i === from && nw.stopStation[i] === prev.s) continue;
          stops.push({ s: nw.stopStation[i], a: nw.stopArr[i], d: nw.stopDep[i], trip: tr, local: nw.stopLocal[i] });
        }
      });
      return {
        kind: 'ride', trips, stops,
        from: nw.stopStation[bi], dep: nw.stopDep[bi],
        to: nw.stopStation[ai], arr: nw.stopArr[ai],
      };
    }

    // Rail sections actually ridden in the journey tree, with the minute the
    // train reaches the far end: Map key = railway*512 + section index.
    ridden() {
      const { nw, cal } = this;
      const out = new Map();
      const tEnd = this.q.time + this.q.budget;
      const mark = (ri, a, b, dep, arr) => {
        const idx = nw.sections(ri, a, b);
        const m = idx.length;
        idx.forEach((k, j) => {
          const tt = Math.round(dep + (arr - dep) * (j + 1) / m);
          const key = ri * 512 + k;
          const cur = out.get(key);
          if (cur === undefined || tt < cur) out.set(key, tt);
        });
      };
      for (let s = 0; s < nw.S; s++) {
        if (this.arrive[s] === INF || this.walkFrom[s] >= 0) continue;
        const c = this.arrConn[s];
        if (c < 0) continue;
        // walk back along the ride until the boarding connection or an already-marked hop
        const trip = cal.connTrip[c];
        const board = this.tripBoard[trip];
        let ai = cal.connStop[c] + 1;
        let t = trip;
        const bi = cal.connStop[board], bt = cal.connTrip[board];
        let guard = 0;
        while (guard++ < 400) {
          const first = t === bt ? bi : nw.tripStart[t];
          const ri = nw.tripRail[t];
          for (let i = ai - 1; i >= first; i--) {
            mark(ri, nw.stopLocal[i], nw.stopLocal[i + 1], nw.stopDep[i], Math.min(nw.stopArr[i + 1], tEnd));
          }
          if (t === bt || this.tripPrev[t] < 0) break;
          t = this.tripPrev[t];
          ai = nw.tripStart[t + 1] - 1;
        }
      }
      return out;
    }
  }

  // ------------------------------------------------------------ calendar
  // Which timetable runs on a date: 1 weekday, 2 Saturday, 4 Sunday/holiday.
  // Japanese public holidays are computed (current law, valid 2020–2099),
  // plus 12/30–1/3, when railways run their holiday timetables.
  const holidayCache = new Map();
  function japanHolidays(y) {
    if (holidayCache.has(y)) return holidayCache.get(y);
    const day = (m, d) => Date.UTC(y, m - 1, d) / 864e5;   // days since 1970-01-01 (a Thursday)
    const dow = n => (n + 4) % 7;
    const monday = (m, nth) => { const d1 = day(m, 1); return d1 + (8 - dow(d1)) % 7 + (nth - 1) * 7; };
    const k = y - 1980, q = Math.floor(k / 4);
    const base = [day(1, 1), monday(1, 2), day(2, 11), day(2, 23), day(3, Math.floor(20.8431 + 0.242194 * k - q)),
      day(4, 29), day(5, 3), day(5, 4), day(5, 5), monday(7, 3), day(8, 11), monday(9, 3),
      day(9, Math.floor(23.2488 + 0.242194 * k - q)), monday(10, 2), day(11, 3), day(11, 23)].sort((a, b) => a - b);
    const set = new Set(base);
    // 国民の休日: a weekday squeezed between two holidays
    for (const n of base) if (set.has(n + 2) && !set.has(n + 1) && dow(n + 1) !== 0) set.add(n + 1);
    // 振替休日: a holiday on Sunday moves to the next non-holiday
    for (const n of base) if (dow(n) === 0) { let m = n + 1; while (set.has(m)) m++; set.add(m); }
    for (const [m, d] of [[1, 2], [1, 3], [12, 30], [12, 31]]) set.add(day(m, d));
    holidayCache.set(y, set);
    return set;
  }
  function dayType(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    const n = Date.UTC(y, m - 1, d) / 864e5, w = (n + 4) % 7;
    return japanHolidays(y).has(n) || w === 0 ? 4 : w === 6 ? 2 : 1;
  }

  root.Reach = { Reader, decodeBase, decodeGeo, Network, haversine, INF, japanHolidays, dayType };
})(typeof window !== 'undefined' ? window : globalThis);
