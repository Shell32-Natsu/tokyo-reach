"""Build network, timetable and line-geometry files from Mini Tokyo 3D.

Input : a checkout of github.com/nagix/mini-tokyo-3d whose feature build has
        run (build/data/features.json.gz; see tools/README.md).
Output: public/data/net.bin         railways, stations, groups, train types
        public/data/tt.bin          every trip, compact binary
        public/data/geo13..16.bin   railway sections + snapped station points
                                     for four display zoom levels

        public/data/source.json     which Mini Tokyo 3D snapshot this came from

Usage : python3 tools/build_data.py <mini-tokyo-3d dir>
        python3 tools/build_data.py --key <mini-tokyo-3d dir>   print the input key only

If the new timetable has far fewer trips than the one it replaces, the build
stops without writing anything (set ALLOW_SHRINK=1 to accept it anyway).
"""
import glob
import gzip
import hashlib
import json
import math
import os
import subprocess
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(__file__))
from common import Writer  # noqa: E402

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'data')
ZOOMS = [13, 14, 15, 16]

# Everything in the Mini Tokyo 3D checkout that our output depends on. A
# change anywhere else upstream (rendering code, translations) needs no rebuild.
INPUTS = [
    'data/train-timetables', 'data/railways.json', 'data/stations.json',
    'data/station-groups.json', 'data/coordinates.json', 'data/train-types.json',
    'data/rail-directions.json', 'src/loader',
]
SHRINK_LIMIT = 0.85


def git(mt3d, *args):
    return subprocess.run(['git', '-C', mt3d, *args], check=True, capture_output=True, text=True).stdout.strip()


def source_info(mt3d):
    """Identify the upstream snapshot by the git hashes of the inputs we use."""
    trees = [git(mt3d, 'rev-parse', f'HEAD:{p}') for p in INPUTS]
    key = hashlib.sha1('\n'.join(trees).encode()).hexdigest()[:16]
    commit = git(mt3d, 'rev-parse', 'HEAD')
    # date of the last upstream commit that touched the inputs (needs history;
    # in a shallow clone this falls back to the checked-out commit's date)
    date = git(mt3d, 'log', '-1', '--format=%cs', 'HEAD', '--', *INPUTS) or git(mt3d, 'log', '-1', '--format=%cs')
    return {'key': key, 'commit': commit, 'date': date}


def previous_trip_count():
    path = os.path.join(OUT, 'tt.bin')
    if not os.path.exists(path):
        return 0
    with open(path, 'rb') as f:
        b = gzip.decompress(f.read())
    if b[:4] != b'TRIP':
        return 0
    v, shift, p = 0, 0, 4
    while True:
        x = b[p]
        v |= (x & 0x7F) << shift
        p += 1
        shift += 7
        if not x & 0x80:
            return v

# Operator display names (ja, zh-Hans, en)
OPERATORS = {
    'JR-East': ('JR東日本', 'JR东日本', 'JR East'),
    'JR-Central': ('JR東海', 'JR东海', 'JR Central'),
    'TokyoMetro': ('東京メトロ', '东京地铁', 'Tokyo Metro'),
    'Toei': ('都営', '都营', 'Toei'),
    'Tokyu': ('東急', '东急', 'Tokyu'),
    'Odakyu': ('小田急', '小田急', 'Odakyu'),
    'Keio': ('京王', '京王', 'Keio'),
    'Seibu': ('西武', '西武', 'Seibu'),
    'Tobu': ('東武', '东武', 'Tobu'),
    'Keikyu': ('京急', '京急', 'Keikyu'),
    'Keisei': ('京成', '京成', 'Keisei'),
    'Sotetsu': ('相鉄', '相铁', 'Sotetsu'),
    'YokohamaMunicipal': ('横浜市営', '横滨市营', 'Yokohama Subway'),
    'KantoRailway': ('関東鉄道', '关东铁道', 'Kanto Railway'),
    'IzuHakone': ('伊豆箱根', '伊豆箱根', 'Izuhakone'),
    'ChibaMonorail': ('千葉モノレール', '千叶单轨', 'Chiba Monorail'),
    'TWR': ('りんかい線', '临海线', 'TWR'),
    'Hokuso': ('北総', '北总', 'Hokuso'),
    'Shibayama': ('芝山鉄道', '芝山铁道', 'Shibayama'),
    'OdakyuHakone': ('箱根登山', '箱根登山', 'Hakone Tozan'),
    'Minatomirai': ('みなとみらい線', '港未来线', 'Minatomirai'),
    'SaitamaRailway': ('埼玉高速', '埼玉高速', 'Saitama Railway'),
    'MIR': ('つくばエクスプレス', '筑波快线', 'Tsukuba Express'),
    'ToyoRapid': ('東葉高速', '东叶高速', 'Toyo Rapid'),
    'Ryutetsu': ('流鉄', '流铁', 'Ryutetsu'),
    'Kominato': ('小湊鐵道', '小凑铁道', 'Kominato'),
    'Isumi': ('いすみ鉄道', '夷隅铁道', 'Isumi'),
    'Choshi': ('銚子電鉄', '铫子电铁', 'Choshi'),
    'KashimaRinkai': ('鹿島臨海', '鹿岛临海', 'Kashima Rinkai'),
    'Hitachinaka': ('ひたちなか海浜', '常陆那珂海滨', 'Hitachinaka'),
    'Moka': ('真岡鐵道', '真冈铁道', 'Moka'),
    'UtsunomiyaLightRail': ('宇都宮ライトレール', '宇都宫轻轨', 'Utsunomiya LRT'),
    'Enoden': ('江ノ電', '江之电', 'Enoden'),
    'Izukyu': ('伊豆急', '伊豆急', 'Izukyu'),
    'Fujikyu': ('富士山麓電気鉄道', '富士山麓电气铁道', 'Fujikyu'),
    'Chichibu': ('秩父鉄道', '秩父铁道', 'Chichibu'),
    'Jomo': ('上毛電鉄', '上毛电铁', 'Jomo'),
    'Joshin': ('上信電鉄', '上信电铁', 'Joshin'),
    'WataraseKeikoku': ('わたらせ渓谷', '渡良濑溪谷', 'Watarase Keikoku'),
    'Yurikamome': ('ゆりかもめ', '百合海鸥', 'Yurikamome'),
    'YokohamaSeaside': ('シーサイドライン', '海滨线', 'Seaside Line'),
    'SaitamaTransit': ('ニューシャトル', '新穿梭', 'New Shuttle'),
    'Yamaman': ('山万', '山万', 'Yamaman'),
    'TokyoMonorail': ('東京モノレール', '东京单轨', 'Tokyo Monorail'),
    'TamaMonorail': ('多摩モノレール', '多摩单轨', 'Tama Monorail'),
    'ShonanMonorail': ('湘南モノレール', '湘南单轨', 'Shonan Monorail'),
}

# Trains that need a limited-express / reserved-seat ticket on top of the fare.
PAID_TYPES = {
    'JR-East.LimitedExpress', 'JR-Central.LimitedExpress', 'Odakyu.LimitedExpress',
    'OdakyuHakone.LimitedExpress', 'TokyoMetro.LimitedExpress', 'Tobu.LimitedExpress',
    'Seibu.LimitedExpress', 'Fujikyu.LimitedExpress', 'Izukyu.LimitedExpress',
    'IzuHakone.LimitedExpress', 'Keisei.Skyliner', 'Keisei.Morningliner', 'Keisei.Eveningliner',
    'Keikyu.MorningWing', 'Keikyu.EveningWing', 'Keio.KeioLiner', 'Tobu.TJ-Liner',
    'Tobu.TH-LINER', 'TokyoMetro.TH-LINER', 'Seibu.S-TRAIN', 'TokyoMetro.S-TRAIN',
    'Minatomirai.S-TRAIN', 'Tokyu.S-TRAIN', 'Seibu.HaijimaLiner', 'Tobu.SL-Taiju',
    'Moka.SL-Moka', 'Chichibu.Express',
}
LOCAL_SUFFIX = ('.Local',)

CAL_BITS = {'Weekday': 1, 'Saturday': 2, 'Holiday': 4, 'SaturdayHoliday': 6}


def load(path):
    with open(path) as f:
        return json.load(f)


def hav(a, b):
    """Great-circle distance in km, same radius turf uses."""
    R = 6371.0088
    la1, la2 = math.radians(a[1]), math.radians(b[1])
    dla, dlo = la2 - la1, math.radians(b[0] - a[0])
    h = math.sin(dla / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin(dlo / 2) ** 2
    return 2 * R * math.asin(math.sqrt(min(1, h)))


def along(coords, dist):
    """Point at distance `dist` km along a polyline (turf.along semantics)."""
    travelled = 0
    for i in range(len(coords) - 1):
        seg = hav(coords[i], coords[i + 1])
        if travelled + seg >= dist and seg > 0:
            f = (dist - travelled) / seg
            return [coords[i][0] + (coords[i + 1][0] - coords[i][0]) * f,
                    coords[i][1] + (coords[i + 1][1] - coords[i][1]) * f]
        travelled += seg
    return coords[-1][:2]


def minutes(hhmm):
    h, m = int(hhmm[:2]), int(hhmm[3:5])
    t = h * 60 + m
    return t + 1440 if h < 3 else t


def main(mt3d):
    source = source_info(mt3d)
    D = os.path.join(mt3d, 'data')
    railways = load(os.path.join(D, 'railways.json'))
    stations = load(os.path.join(D, 'stations.json'))
    groups_raw = load(os.path.join(D, 'station-groups.json'))
    ttypes = load(os.path.join(D, 'train-types.json'))
    rdirs = load(os.path.join(D, 'rail-directions.json'))

    r_index = {r['id']: i for i, r in enumerate(railways)}
    s_index = {s['id']: i for i, s in enumerate(stations)}
    st_by_id = {s['id']: s for s in stations}

    # ---- train types: category 0 local, 1 rapid/express (no surcharge), 2 paid
    type_index = {t['id']: i for i, t in enumerate(ttypes)}
    types_out = []
    for t in ttypes:
        tid = t['id']
        cat = 2 if tid in PAID_TYPES else (0 if tid.endswith(LOCAL_SUFFIX) else 1)
        types_out.append({'id': tid, 'ja': t['title'].get('ja'), 'zh': t['title'].get('zh-Hans'),
                          'en': t['title'].get('en'), 'cat': cat})

    # ---- groups: every station belongs to exactly one group of sub-groups
    group_of = {}
    groups = []
    for g in groups_raw:
        subs = [[s_index[s] for s in sub if s in s_index] for sub in g]
        subs = [s for s in subs if s]
        if not subs:
            continue
        gi = len(groups)
        groups.append(subs)
        for si, sub in enumerate(subs):
            for s in sub:
                group_of[s] = (gi, si)
    for i, s in enumerate(stations):
        if i not in group_of:
            group_of[i] = (len(groups), 0)
            groups.append([[i]])

    # ---- timetables
    trips = []
    for fn in sorted(glob.glob(os.path.join(D, 'train-timetables', '*.json'))):
        for t in load(fn):
            parts = t['id'].split('.')
            cal = next((CAL_BITS[p] for p in reversed(parts) if p in CAL_BITS), 0)
            if not cal:
                continue
            trips.append((t, cal))
    trip_index = {t['id']: i for i, (t, _) in enumerate(trips)}

    old = previous_trip_count()
    if old and len(trips) < old * SHRINK_LIMIT and os.environ.get('ALLOW_SHRINK') != '1':
        sys.exit(f'Refusing to build: {len(trips)} trips vs {old} before '
                 f'(more than {100 - SHRINK_LIMIT * 100:.0f}% fewer). '
                 'Check the upstream data, or rerun with ALLOW_SHRINK=1.')

    w = Writer()
    w.buf += b'TRIP'
    w.uvar(len(trips))
    dir_index = {d['id']: i for i, d in enumerate(rdirs)}
    n_stops = 0
    for t, cal in trips:
        r = railways[r_index[t['r']]]
        local = {sid: i for i, sid in enumerate(r['stations'])}
        w.uvar(r_index[t['r']])
        w.uvar(type_index.get(t.get('y'), 0))
        w.uvar(cal | (dir_index.get(t.get('d'), 0) << 3))
        tt = t['tt']
        w.uvar(len(tt))
        prev = None
        times = []
        for s in tt:
            a = minutes(s['a']) if 'a' in s else None
            d = minutes(s['d']) if 'd' in s else None
            a = a if a is not None else d
            d = d if d is not None else a
            if prev is not None:
                while a < prev:
                    a += 1440
                while d < a:
                    d += 1440
            prev = d
            times.append((a, d))
        w.uvar(times[0][0])
        last = times[0][0]
        for i, s in enumerate(tt):
            li = local[s['s']]
            a, d = times[i]
            w.uvar(li)
            w.uvar(a - last)
            w.uvar(d - a)
            last = d
            n_stops += 1
    # through-service links: continue on the same train without changing
    links = []
    for i, (t, _) in enumerate(trips):
        for n in t.get('nt') or []:
            j = trip_index.get(n)
            if j is not None:
                links.append((i, j))
    w.uvar(len(links))
    for i, j in links:
        w.uvar(i)
        w.uvar(j)
    size = w.save(os.path.join(OUT, 'tt.bin'))
    print(f'tt.bin.gz: {len(trips)} trips, {n_stops} stops, {len(links)} links, {size/1e6:.2f} MB')

    # ---- geometry per zoom
    fc = json.load(gzip.open(os.path.join(mt3d, 'build', 'data', 'features.json.gz')))
    feats = fc['features']
    for z in ZOOMS:
        full = {}
        sections = defaultdict(list)
        for f in feats:
            p = f['properties']
            if p.get('zoom') != z or p.get('type') not in (0, 2):
                continue
            if 'section' in p:
                rid, k = p['section'].rsplit('.', 1)
                if rid in r_index:
                    sections[(r_index[rid], int(k))].append((p['type'], f['geometry']['coordinates']))
            elif p['id'].rsplit('.', 1)[0] in r_index:
                full[r_index[p['id'].rsplit('.', 1)[0]]] = f
        w = Writer()
        w.buf += b'GEO1'
        keys = sorted(sections)
        w.uvar(len(keys))
        for (ri, k) in keys:
            pieces = sections[(ri, k)]
            w.uvar(ri)
            w.uvar(k)
            w.uvar(len(pieces))
            for typ, coords in pieces:
                w.uvar(1 if typ == 2 else 0)
                w.line(coords)
        # stations snapped onto this zoom's line geometry
        snapped = [None] * len(stations)
        for ri, f in full.items():
            coords = f['geometry']['coordinates']
            offs = f['properties'].get('station-offsets') or []
            for sid, off in zip(railways[ri]['stations'], offs):
                i = s_index[sid]
                if snapped[i] is None:
                    snapped[i] = along(coords, off)
        w.uvar(len(stations))
        for i, s in enumerate(stations):
            c = snapped[i] or s.get('coord') or [0, 0]
            w.line([c])
        size = w.save(os.path.join(OUT, f'geo{z}.bin'))
        print(f'geo{z}.bin.gz: {len(keys)} sections, {size/1e6:.2f} MB')

    # ---- network description
    def op_of(rid):
        return rid.split('.')[0]

    net = {
        'source': {'date': source['date'], 'commit': source['commit'][:7]},
        'operators': {k: list(v) for k, v in OPERATORS.items()},
        'railways': [{
            'id': r['id'], 'op': op_of(r['id']),
            'ja': r['title'].get('ja'), 'zh': r['title'].get('zh-Hans'), 'en': r['title'].get('en'),
            'color': r.get('color', '#888888'),
            'stations': [s_index[s] for s in r['stations']],
            'asc': r.get('ascending'), 'desc': r.get('descending'),
        } for r in railways],
        'stations': [{
            'id': s['id'],
            'r': r_index.get(s.get('railway') or s['id'].rsplit('.', 1)[0], -1),
            'ja': s['title'].get('ja'), 'zh': s['title'].get('zh-Hans'), 'en': s['title'].get('en'),
            'c': [round(s['coord'][0], 5), round(s['coord'][1], 5)] if 'coord' in s else None,
            'g': group_of[i][0], 'sg': group_of[i][1],
            'alt': 1 if s.get('alternate') else 0,
        } for i, s in enumerate(stations)],
        'groups': groups,
        'types': types_out,
        'dirs': [{'id': d['id'], 'ja': d['title'].get('ja'), 'zh': d['title'].get('zh-Hans'),
                  'en': d['title'].get('en')} for d in rdirs],
    }
    with open(os.path.join(OUT, 'net.json'), 'w') as f:
        json.dump(net, f, ensure_ascii=False, separators=(',', ':'))
    with open(os.path.join(OUT, 'net.json'), 'rb') as f:
        raw = f.read()
    with open(os.path.join(OUT, 'net.bin'), 'wb') as f:
        f.write(gzip.compress(raw, 9, mtime=0))
    os.remove(os.path.join(OUT, 'net.json'))
    print(f'net.json.gz: {len(raw)/1e3:.0f} kB raw, {len(groups)} groups')

    # written last, so it only exists for a build that finished
    with open(os.path.join(OUT, 'source.json'), 'w') as f:
        json.dump({**source, 'trips': len(trips), 'stops': n_stops,
                   'railways': len(railways), 'stations': len(stations)}, f, indent=2)
        f.write('\n')
    print(f"source: Mini Tokyo 3D {source['commit'][:7]} ({source['date']}), key {source['key']}")


if __name__ == '__main__':
    if sys.argv[1] == '--key':
        print(source_info(sys.argv[2])['key'])
    else:
        main(sys.argv[1])
