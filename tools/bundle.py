"""Assemble the single-page app.

public/index.html   full HTML document (open locally or host anywhere)
build/artifact.html the same page without the <html>/<head>/<body> skeleton,
                    for publishing as a claude.ai artifact
Data files are fetched at runtime from ./data/*.bin (gzip payloads).
"""
import base64
import glob
import os

ROOT = os.path.join(os.path.dirname(__file__), '..')
SRC = os.path.join(ROOT, 'src')
MAPLIBRE = 'https://cdn.jsdelivr.net/npm/maplibre-gl@5.24.0/dist/maplibre-gl.js'
FONTS = ('https://fonts.googleapis.com/css2?family=BIZ+UDPGothic:wght@400;700'
         '&family=Barlow+Condensed:wght@500;600;700&family=Noto+Sans+SC:wght@400;500;700&display=swap')


def read(name):
    with open(os.path.join(SRC, name), encoding='utf-8') as f:
        return f.read()


def main():
    head = (
        '<title>Tokyo Reach</title>\n'
        '<meta name="description" content="东京圈铁路等时圈：选一个车站和出发时间，看看在给定分钟内最远能坐到哪里。">\n'
        '<link rel="preconnect" href="https://fonts.googleapis.com">\n'
        '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n'
        f'<link rel="stylesheet" href="{FONTS}">\n'
        f'<style>\n{read("style.css")}\n</style>\n'
    )
    body = (
        read('body.html') +
        f'<script src="{MAPLIBRE}"></script>\n'
        f'<script>\n{read("engine.js")}\n</script>\n'
        f'<script>\n{read("app.js")}\n</script>\n'
    )
    os.makedirs(os.path.join(ROOT, 'build', 'data'), exist_ok=True)
    with open(os.path.join(ROOT, 'build', 'artifact.html'), 'w', encoding='utf-8') as f:
        f.write(head + "<script>window.TR_DATA_EXT = '.txt';</script>\n" + body)
    # the artifact host serves text, not raw binary: ship base64 copies
    for fn in glob.glob(os.path.join(ROOT, 'public', 'data', '*.bin')):
        name = os.path.splitext(os.path.basename(fn))[0]
        with open(fn, 'rb') as f, open(os.path.join(ROOT, 'build', 'data', name + '.txt'), 'w') as g:
            g.write(base64.b64encode(f.read()).decode())
    with open(os.path.join(ROOT, 'public', 'index.html'), 'w', encoding='utf-8') as f:
        f.write('<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n'
                '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
                + head + '</head>\n<body>\n' + body + '</body>\n</html>\n')
    print('built public/index.html and build/artifact.html')


if __name__ == '__main__':
    main()
