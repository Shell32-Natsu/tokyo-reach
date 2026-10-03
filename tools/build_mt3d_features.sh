#!/usr/bin/env bash
# Rebuild Mini Tokyo 3D's line geometry (features.json.gz) without network
# lookups other than npm and GitHub. Usage: tools/build_mt3d_features.sh [dir]
set -euo pipefail
DIR="${1:-mini-tokyo-3d}"
[ -d "$DIR" ] || git clone --depth 1 https://github.com/nagix/mini-tokyo-3d.git "$DIR"
cd "$DIR"
if [ -f package-lock.json ]; then npm ci --no-audit --no-fund --ignore-scripts; else npm install --no-audit --no-fund --ignore-scripts; fi
# The station loader fetches Wikipedia thumbnails we don't need; skip that step.
python3 - <<'PY'
p = 'src/loader/stations.js'
s = open(p).read()
if 'stationLists.map(' in s:
    a = s.index('    (await Promise.all(stationLists.map(')
    b = s.index("    saveJSON('build/data/stations.json.gz'")
    open(p, 'w').write(s[:a] + s[b:])
PY
cat > src/loader/features-only.js <<'JS'
import {isMainThread} from 'worker_threads';
import railways from './railways';
import stations from './stations';
import features, {featureWorker} from './features';
async function main() {
    const [railwayLookup, stationLookup] = await Promise.all([railways(), stations()]);
    features(railwayLookup, stationLookup);
}
if (isMainThread) { main(); } else { featureWorker(); }
JS
cat > rollup.features.mjs <<'JS'
import resolve from '@rollup/plugin-node-resolve';
import commonjs from '@rollup/plugin-commonjs';
export default {input: 'src/loader/features-only.js', output: {file: 'dist/features-only.js', format: 'cjs'}, plugins: [resolve(), commonjs()]};
JS
npx rollup -c rollup.features.mjs
mkdir -p build/data
node dist/features-only.js
ls -la build/data/features.json.gz
