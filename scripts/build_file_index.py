"""Build a complete file-by-file index of the vectant-ade repo for the Obsidian vault.

Walks every tracked-ish file (skips .git/node_modules/dist/build/data volumes),
extracts real descriptors from actual source (first docstring/comment/heading),
and emits one markdown index per top-level area into docs/file-index/.
Deterministic and re-runnable; no invented descriptions - when nothing can be
extracted the descriptor is 'binary or generated artifact'.
"""
import os
import re
import datetime
import collections

REPO = r"C:\Users\polek\Desktop\hermes-abuse\vectant-ade"
OUT = os.path.join(REPO, "docs", "file-index")
SKIP_DIRS = {'.git', 'node_modules', 'dist', '.next', 'build', 'data',
             '.playwright-mcp', '.scratch-playwright'}
TEXT_EXTS = {'.js', '.jsx', '.ts', '.tsx', '.mjs', '.py', '.rs', '.md', '.json',
             '.yaml', '.yml', '.toml', '.sql', '.sh', '.ps1', '.proto', '.css',
             '.html', '.txt', '.lock'}

AREA_OF = {
    'synthi': 'synthi-frontend', 'backend': 'backend-services',
    'ai-backend': 'ai-backend', 'mcp': 'mcp-server', 'packages': 'packages',
    'extensions': 'extensions-and-root', 'docs': 'docs-and-meta',
    'k8s': 'infra-config', 'ops': 'infra-config', 'cloudrun': 'infra-config',
    'e2e': 'tests-tooling', 'tests': 'tests-tooling', 'probe': 'tests-tooling',
    'scripts': 'tests-tooling', 'tasks': 'tests-tooling',
}


def extract_descriptor(path, ext):
    """Pull a real descriptor from source: first comment block / docstring /
    json description / yaml comment. Never invent."""
    try:
        with open(path, encoding='utf-8', errors='replace') as fh:
            head = [next(fh, '') for _ in range(30)]
    except OSError:
        return None
    text = ''.join(head)

    if ext == '.json':
        m = re.search(r'"description"\s*:\s*"([^"]{10,160})"', text)
        if m:
            return m.group(1)
        try:
            name = os.path.basename(path)
            return f'JSON data ({name})'
        except Exception:
            pass

    # python docstring
    if ext == '.py':
        m = re.search(r'"""(.+?)"""', text, re.S)
        if m:
            line = m.group(1).strip().splitlines()[0]
            if len(line) > 8:
                return line[:150]

    # comment lines (# or // or /*) at top
    for line in head[:12]:
        s = line.strip()
        for pre in ('#', '//', '*', '/*'):
            if s.startswith(pre):
                body = s.lstrip(pre).strip()
                if len(body) > 12 and not body.startswith(('!', '-*-')) \
                   and not set(body) <= {'-', '=', '─', '_'}:
                    return body[:150]

    # fallbacks: exported symbol names / top-level declarations give a real hint
    if ext in {'.js', '.mjs', '.ts', '.tsx'}:
        m = re.search(r'export\s+(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)', text)
        if not m:
            m = re.search(r'export\s+(?:const|class)\s+([A-Za-z_$][\w$]*)', text)
        if not m:
            m = re.search(r'module\.exports\s*=\s*\{?\s*([A-Za-z_$][\w$]*)', text)
        if not m:
            m = re.search(r'(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(', text)
        if not m:
            m = re.search(r'class\s+([A-Z][\w$]*)', text)
        if m:
            return f'defines `{m.group(1)}`'

    if ext == '.py':
        m = re.search(r'^(?:class|def)\s+([A-Za-z_]\w*)', text, re.M)
        if m:
            return f'defines `{m.group(1)}`'
        m = re.search(r'^from\s+([\w.]+)\s+import|^import\s+([\w.]+)', text, re.M)
        if m:
            mod = m.group(1) or m.group(2)
            return f'imports {mod}'

    if ext == '.rs':
        m = re.search(r'^(?:pub\s+)?(?:async\s+)?fn\s+([a-z_]\w*)', text, re.M)
        if not m:
            m = re.search(r'^(?:pub\s+)?struct\s+([A-Z]\w*)', text, re.M)
        if not m:
            m = re.search(r'^(?:pub\s+)?(?:trait|enum)\s+([A-Z]\w*)', text, re.M)
        if not m:
            m = re.search(r'^mod\s+([a-z_]\w*)', text, re.M)
        if m:
            return f'defines `{m.group(1)}`'

    if ext == '.tsx' or ext == '.jsx':
        m = re.search(r'export default function\s+([A-Za-z_$][\w$]*)', text)
        if m:
            return f'renders `{m.group(1)}`'

    if ext in {'.css', '.html'}:
        return f'{ext[1:]} asset'

    if ext == '.sql':
        m = re.search(r'--\s*(.{12,150})', text)
        if m:
            return m.group(1).strip()

    if ext == '.proto':
        m = re.search(r'package\s+([\w.]+)', text)
        if m:
            return f'protobuf package {m.group(1)}'

    if ext == '.yaml' or ext == '.yml':
        m = re.search(r'^(?:kind|name):\s*(\S+)\s*$|^kind:\s*(\S+)', text, re.M)
        if m:
            kind = m.group(1) or m.group(2)
            nm = re.search(r'^\s*name:\s*(\S+)', text, re.M)
            return f'{kind}' + (f' "{nm.group(1)}"' if nm else '')

    # last resort: first non-trivial code line as a content hint
    for line in head:
        s = line.strip()
        if len(s) > 25 and not s.startswith(('#', '//', '*', '/*', '<!--', '"""')) \
           and not set(s) <= {'-', '=', '─', '_'}:
            return s[:140]

    # truly nothing: name-derived, still factual
    base = os.path.basename(path)
    return f'{ext[1:] if ext else "file"} file: {base}'

    # markdown first heading or bold lead
    if ext == '.md':
        for line in head:
            if line.startswith('# '):
                return line[2:].strip()[:150]
        m = re.search(r'\*\*(.{15,150}?)\*\*', text)
        if m:
            return m.group(1)
    return None


def classify(path, ext):
    name = os.path.basename(path).lower()
    d = path.lower()
    if 'test' in name or '/__tests__/' in d.replace('\\', '/') or name.endswith('.test.js'):
        return 'test'
    # source-adjacent text formats that carry meaning
    if ext in {'.cpp', '.h', '.c', '.hpp', '.go', '.java', '.hip', '.cu',
               '.cjs', '.cmd', '.gitignore', '.gitattributes', '.dockerignore'}:
        return 'source/config'
    if name in {'dockerfile', 'dockerfile.migrate', 'makefile', '.env.example',
                '.mcp.json', 'cargo.lock'} or name.startswith('dockerfile'):
        return 'source/config'
    if ext == '' and not name.startswith('.'):
        # extensionless: Dockerfile-like or data
        try:
            with open(os.path.join(REPO, path), encoding='utf-8', errors='replace') as fh:
                first = fh.readline()
            if any(k in first for k in ('FROM ', 'const ', 'import ', '#!', 'package ')):
                return 'source/config'
        except OSError:
            pass
        return 'asset'
    if ext in {'.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp'}:
        return 'image'
    if ext in TEXT_EXTS:
        return 'source/config'
    return 'asset'


def main():
    os.makedirs(OUT, exist_ok=True)
    areas = collections.defaultdict(list)
    counts = collections.Counter()
    for dirpath, dirnames, filenames in os.walk(REPO):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        rel_dir = os.path.relpath(dirpath, REPO)
        top = '(root)' if rel_dir == '.' else rel_dir.split(os.sep)[0]
        area = AREA_OF.get(top, 'extensions-and-root' if top.startswith('.') else 'docs-and-meta')
        for f in filenames:
            full = os.path.join(dirpath, f)
            rel = os.path.relpath(full, REPO).replace('\\', '/')
            ext = os.path.splitext(f)[1].lower()
            kind = classify(rel.replace('\\', '/'), ext)
            desc = None
            if kind == 'test':
                # test files are source too - try to describe them
                desc = extract_descriptor(full, ext)
                if not desc:
                    desc = 'test suite/module'
            elif kind == 'source/config':
                desc = extract_descriptor(full, ext)
            size = 0
            try:
                size = os.path.getsize(full)
            except OSError:
                pass
            areas[area].append((rel, kind, desc, size))
            counts[(area, kind)] += 1

    stamp = datetime.date.today().isoformat()
    total = sum(len(v) for v in areas.values())
    for area, rows in sorted(areas.items()):
        rows.sort()
        out_path = os.path.join(OUT, f"{area}.index.md")
        with open(out_path, 'w', encoding='utf-8') as out:
            out.write(f"---\narea: {area}\ngenerated: {stamp}\nfiles: {len(rows)}\n---\n\n")
            out.write(f"# File Index — {area} ({len(rows)} files)\n\n")
            by_kind = collections.Counter(k for _, k, _, _ in rows)
            out.write("Kinds: " + ", ".join(f"{k}: {v}" for k, v in sorted(by_kind.items())) + "\n\n")
            cur_kind = None
            for rel, kind, desc, size in rows:
                if kind != cur_kind:
                    cur_kind = kind
                    out.write(f"\n## {kind}\n\n")
                    out.write("| File | Bytes | Descriptor |\n|---|---|---|\n" if kind == 'source/config'
                              else "| File | Bytes | Note |\n|---|---|---|\n")
                note = desc if desc else ('binary or generated artifact' if kind != 'source/config'
                                          else '(no descriptor extracted)')
                kb = f"{size//1024:,}" if size >= 1024 else f"{size}"
                out.write(f"| `{rel}` | {kb} | {note.replace('|', '/')} |\n")
    print(f"wrote {len(areas)} index files covering {total} files -> {OUT}")
    for (area, kind), n in sorted(counts.items()):
        print(f"  {area:24s} {kind:14s} {n}")
    print(f"TOTAL FILES INDEXED: {total}")


if __name__ == '__main__':
    main()
