#!/usr/bin/env python3
"""Bundle the vendored three.js ES modules into one classic script.

Browsers refuse to import local ES modules on file:// pages, so index.html loads
vendor/three.bundle.js with a plain <script> tag instead. This script rebuilds
that file from vendor/three/ (the untouched npm sources). No dependencies.

    python3 tools/bundle-three.py

Each module becomes a function scope; `import {a as b} from 'x'` turns into a
destructuring of that module's exports, `export {…}` into the return value.
"""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / 'vendor'
SRC = ROOT / 'three'
OUT = ROOT / 'three.bundle.js'
ADDONS = ['EffectComposer', 'RenderPass', 'UnrealBloomPass', 'ShaderPass']  # what index.html uses

IMPORT = re.compile(r"^import\s*\{([^}]*)\}\s*from\s*'([^']+)';[ \t]*$", re.M)
REEXPORT = re.compile(r"^export\s*\{([^}]*)\}\s*from\s*'([^']+)';[ \t]*$", re.M)
EXPORT = re.compile(r"^export\s*\{([^}]*)\};[ \t]*$", re.M)

order, seen = [], {}


def resolve(spec, importer):
    if spec == 'three':
        return SRC / 'build' / 'three.module.js'
    return (importer.parent / spec).resolve()


def pairs(body):
    """'a, b as c' -> [('a','a'), ('b','c')]"""
    out = []
    for part in body.split(','):
        part = part.strip()
        if part:
            names = re.split(r'\s+as\s+', part)
            out.append((names[0], names[-1]))
    return out


def load(path):
    path = path.resolve()
    if path in seen:
        return seen[path]
    mod_id = seen[path] = f'm{len(seen)}'
    code = path.read_text()
    head, exports = [], []

    def on_import(m):
        dep = load(resolve(m.group(2), path))
        head.append('const { %s } = %s;' % (', '.join(a if a == b else f'{a}: {b}' for a, b in pairs(m.group(1))), dep))
        return ''

    def on_reexport(m):
        dep = load(resolve(m.group(2), path))
        exports.extend(f'{b}: {dep}.{a}' for a, b in pairs(m.group(1)))
        return ''

    def on_export(m):
        exports.extend(a if a == b else f'{b}: {a}' for a, b in pairs(m.group(1)))
        return ''

    code = IMPORT.sub(on_import, code)
    code = REEXPORT.sub(on_reexport, code)
    code = EXPORT.sub(on_export, code)
    leftover = re.search(r'^(import|export)\b.*$', code, re.M)
    if leftover:
        raise SystemExit(f'{path.name}: unhandled statement: {leftover.group(0)[:100]}')
    order.append('const %s = (function () {\n%s\n%s\nreturn { %s };\n})();\n' % (mod_id, '\n'.join(head), code, ', '.join(exports)))
    return mod_id


three = load(SRC / 'build' / 'three.module.js')
addons = [load(SRC / 'examples' / 'jsm' / 'postprocessing' / f'{name}.js') for name in ADDONS]
banner = '/* three.js (MIT license, see vendor/LICENSE): core + %s as one classic script. Built by tools/bundle-three.py. */\n' % ', '.join(ADDONS)
OUT.write_text(banner + 'var THREE = (function () {\n"use strict";\n' + ''.join(order)
               + 'return { ...%s, %s };\n})();\n' % (three, ', '.join(f'...{a}' for a in addons)))
print(f'wrote {OUT} ({OUT.stat().st_size / 1e6:.2f} MB, {len(order)} modules)')
