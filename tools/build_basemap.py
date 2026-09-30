"""Build the basemap (land, prefecture and municipal boundaries, place labels).

Input : municipality polygons from github.com/niiyz/JapanCityGeoJson
        (derived from MLIT 国土数値情報 N03 administrative areas).
Output: public/data/base.bin (gzip)

Usage : python3 tools/build_basemap.py <JapanCityGeoJson dir>
Needs : shapely, mapshaper (npm i -g mapshaper)
"""
import glob
import json
import os
import subprocess
import sys
import tempfile

from shapely.geometry import Polygon, box, mapping, shape
from shapely.geometry.polygon import orient
from shapely.ops import unary_union
from shapely.validation import make_valid

sys.path.insert(0, os.path.dirname(__file__))
from common import Writer  # noqa: E402

PREFS = ['07', '08', '09', '10', '11', '12', '13', '14', '15', '19', '20', '22']
BBOX = (138.35, 34.5, 141.05, 37.2)
OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'data', 'base.bin')


def fix_geometry(g, clip):
    """N03 files sometimes store islands as extra rings of one polygon;
    rebuild every ring as its own polygon and union them."""
    polys = [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
    parts = [make_valid(Polygon(r)) for p in polys for r in p if len(r) >= 4]
    u = unary_union(parts).intersection(clip)
    if u.is_empty:
        return None
    if u.geom_type not in ('Polygon', 'MultiPolygon'):
        u = unary_union([x for x in getattr(u, 'geoms', [u]) if x.geom_type in ('Polygon', 'MultiPolygon')])
    if u.is_empty:
        return None
    return orient(u) if u.geom_type == 'Polygon' else type(u)([orient(x) for x in u.geoms])


def mapshaper(src, dst, *cmds):
    subprocess.run(['mapshaper', src, *cmds, '-o', dst, 'format=geojson', 'precision=0.00001'],
                   check=True, capture_output=True)
    with open(dst) as f:
        return json.load(f)


def geoms(gj):
    return [f['geometry'] for f in gj['features']] if 'features' in gj else gj['geometries']


def write_polys(w, gj):
    polys = []
    for g in geoms(gj):
        if g is None:
            continue
        polys += [g['coordinates']] if g['type'] == 'Polygon' else g['coordinates']
    w.uvar(len(polys))
    for p in polys:
        w.uvar(len(p))
        for ring in p:
            w.line(ring)


def write_lines(w, gj):
    lines = []
    for g in geoms(gj):
        if g is None:
            continue
        lines += [g['coordinates']] if g['type'] == 'LineString' else g['coordinates']
    w.uvar(len(lines))
    for l in lines:
        w.line(l)


def main(src):
    clip = box(*BBOX)
    feats = []
    for pc in PREFS:
        for fn in sorted(glob.glob(os.path.join(src, 'geojson', pc, '*.json'))):
            with open(fn) as f:
                d = json.load(f)
            for x in d['features']:
                p = x['properties']
                g = fix_geometry(x['geometry'], clip)
                if g is None:
                    continue
                name = p.get('N03_004') or p.get('N03_003') or ''
                feats.append({'type': 'Feature', 'geometry': mapping(g),
                              'properties': {'pc': pc, 'name': name, 'code': p.get('N03_007')}})
    tmp = tempfile.mkdtemp()
    raw = os.path.join(tmp, 'muni.json')
    with open(raw, 'w') as f:
        json.dump({'type': 'FeatureCollection', 'features': feats}, f, ensure_ascii=False)

    simp = os.path.join(tmp, 'muni_s.json')
    muni = mapshaper(raw, simp, '-simplify', 'interval=12', 'keep-shapes')
    land = mapshaper(simp, os.path.join(tmp, 'land.json'), '-dissolve2')
    land_lo = mapshaper(raw, os.path.join(tmp, 'land_lo.json'), '-dissolve2', '-simplify', 'interval=150',
                        'keep-shapes', '-filter-slivers', 'min-area=300000m2')
    pref = mapshaper(simp, os.path.join(tmp, 'pref.json'), '-dissolve2', 'pc', '-innerlines')
    mlines = mapshaper(simp, os.path.join(tmp, 'mlines.json'), '-innerlines')

    # Place labels: one point per municipality (wards of designated cities are
    # merged into the city so Yokohama shows once, not 18 times).
    by_name = {}
    for f in muni['features']:
        p = f['properties']
        name = p['name']
        if not name:
            continue
        key = (p['pc'], name)
        by_name.setdefault(key, []).append(shape(f['geometry']))
    labels = []
    for (pc, name), shp in by_name.items():
        u = unary_union(shp)
        pt = u.representative_point()
        # area in km² (rough, equirectangular at 35.7°N)
        area = u.area * 111.32 * 90.4
        labels.append((name, pt.x, pt.y, area))
    labels.sort(key=lambda l: -l[3])

    w = Writer()
    w.buf += b'BASE'
    write_polys(w, land)
    write_polys(w, land_lo)
    write_lines(w, pref)
    write_lines(w, mlines)
    w.uvar(len(labels))
    for name, x, y, area in labels:
        b = name.encode('utf-8')
        w.uvar(len(b))
        w.buf += b
        w.line([(x, y)])
        w.uvar(int(min(area, 100000)))
    n = w.save(OUT)
    print(f'base.bin.gz: {n/1e3:.0f} kB, {len(labels)} labels')


if __name__ == '__main__':
    main(sys.argv[1])
