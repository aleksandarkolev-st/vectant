import fs from 'fs';
import path from 'path';
import { digest, normalizePath } from './policy';

const SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.cache',
  'coverage',
  'dist',
  'build',
  'node_modules',
]);

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const TEST_PATTERN = /(^|\/)(__tests__|tests?)\/|(\.|-)(test|spec)\.[cm]?[jt]sx?$/i;

export function discoverRepoPolicySignals(options = {}) {
  const repoRoot = detectRepoRoot(options.root || process.env.SYNTHI_CODESITE_REPO_ROOT || process.cwd());
  const maxFiles = Number(options.maxFiles || process.env.SYNTHI_CODESITE_REPO_SCAN_MAX_FILES || 12000);
  const files = listRepoFiles(repoRoot, { maxFiles });
  const fileSet = new Set(files);
  const codeowners = discoverCodeowners(repoRoot, fileSet);
  const openapi = files.filter(isOpenApiFile).map((file) => ({ path: file }));
  const prisma = discoverPrisma(files);
  const packageExports = discoverPackageExports(repoRoot, files);
  const deployment = files.filter(isDeploymentFile).map((file) => ({ path: file }));
  const generatedClients = files.filter((file) => /(^|\/)(generated|client|clients)\//i.test(file)).map((file) => ({ path: file }));
  const { importEdges, testOwnership } = discoverImportAndTestGraph(repoRoot, files, fileSet);
  const pastIncidents = discoverPastIncidents(repoRoot, files);
  const secretPatterns = discoverSecretPatterns(files);
  const signals = {
    repoRoot,
    files,
    codeowners,
    openapi,
    prisma,
    packageExports,
    deployment,
    generatedClients,
    importEdges,
    testOwnership,
    pastIncidents,
    secretPatterns,
    source: 'repo_policy_compiler',
  };
  return {
    ...signals,
    digest: digest({
      files,
      codeowners,
      openapi,
      prisma,
      packageExports,
      deployment,
      generatedClients,
      importEdges,
      testOwnership,
      pastIncidents,
      secretPatterns,
    }),
  };
}

export function detectRepoRoot(start) {
  let current = path.resolve(start || process.cwd());
  while (current && current !== path.dirname(current)) {
    const packageJson = readJsonIfExists(path.join(current, 'package.json'));
    if (fs.existsSync(path.join(current, '.git')) || packageJson?.workspaces || fs.existsSync(path.join(current, 'docker-compose.yml'))) {
      return current;
    }
    current = path.dirname(current);
  }
  return path.resolve(start || process.cwd());
}

function listRepoFiles(root, { maxFiles }) {
  const files = [];
  const stack = [''];
  while (stack.length && files.length < maxFiles) {
    const relDir = stack.pop();
    const absDir = path.join(root, relDir);
    let entries = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = normalizeRepoPath(path.join(relDir, entry.name));
      if (!rel) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(rel);
        continue;
      }
      if (entry.isFile()) files.push(rel);
      if (files.length >= maxFiles) break;
    }
  }
  return files;
}

function discoverCodeowners(root, fileSet) {
  const candidates = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];
  for (const candidate of candidates) {
    if (!fileSet.has(candidate)) continue;
    const text = readTextIfExists(path.join(root, candidate));
    if (!text) continue;
    return text.split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const [pattern, ...owners] = line.split(/\s+/).filter(Boolean);
        return pattern ? { pattern: normalizeCodeownerPattern(pattern), owners } : null;
      })
      .filter(Boolean);
  }
  return [];
}

function discoverPrisma(files) {
  const schemas = files
    .filter((file) => /(^|\/)schema\.prisma$/i.test(file))
    .map((file) => ({ path: file }));
  const migrationDirs = new Set();
  for (const file of files) {
    const match = file.match(/(^|\/)(prisma\/migrations|db\/migrations)(\/|$)/i);
    if (match) migrationDirs.add(file.slice(0, match.index + match[0].length).replace(/\/+$/, ''));
  }
  return {
    schemas,
    migrations: [...migrationDirs].sort().map((dir) => ({ path: dir })),
  };
}

function discoverPackageExports(root, files) {
  return files
    .filter((file) => file.endsWith('package.json'))
    .map((file) => {
      const manifest = readJsonIfExists(path.join(root, file));
      if (!manifest) return null;
      const rootDir = path.dirname(file) === '.' ? '' : path.dirname(file);
      const exports = exportedFilesFromPackageManifest(manifest, rootDir);
      const hasPublicSurface = exports.length > 0 || manifest.main || manifest.module || manifest.types;
      if (!hasPublicSurface || rootDir === '') return null;
      return {
        packageName: manifest.name || rootDir,
        root: rootDir,
        exports,
      };
    })
    .filter(Boolean);
}

function exportedFilesFromPackageManifest(manifest, rootDir) {
  const values = [];
  collectExportValues(manifest.exports, values);
  for (const key of ['main', 'module', 'types', 'typings']) {
    if (manifest[key]) values.push(manifest[key]);
  }
  return [...new Set(values
    .map((value) => normalizeRepoPath(path.join(rootDir, String(value).replace(/^\.\//, ''))))
    .filter(Boolean))];
}

function collectExportValues(value, out) {
  if (!value) return;
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectExportValues(item, out);
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) collectExportValues(item, out);
  }
}

function discoverImportAndTestGraph(root, files, fileSet) {
  const sourceFiles = files.filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)));
  const importEdges = [];
  const testOwnership = [];
  for (const file of sourceFiles) {
    const text = readTextIfExists(path.join(root, file), 300000);
    if (!text) continue;
    const imports = parseImports(text)
      .map((specifier) => resolveImportPath(file, specifier, fileSet))
      .filter(Boolean);
    if (imports.length > 0) {
      const uniqueImports = [...new Set(imports)];
      importEdges.push({ from: file, imports: uniqueImports });
      if (TEST_PATTERN.test(file)) {
        testOwnership.push({ testPath: file, covers: uniqueImports.filter((item) => !TEST_PATTERN.test(item)) });
      }
    }
  }
  return {
    importEdges: importEdges.filter((edge) => edge.imports.length > 0),
    testOwnership: testOwnership.filter((item) => item.covers.length > 0),
  };
}

function parseImports(text) {
  const imports = [];
  const patterns = [
    /\bimport\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+[^'"]*\s+from\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text))) imports.push(match[1]);
  }
  return imports;
}

function resolveImportPath(fromFile, specifier, fileSet) {
  if (!specifier || !specifier.startsWith('.')) return null;
  const base = normalizeRepoPath(path.join(path.dirname(fromFile), specifier));
  if (!base) return null;
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
  ];
  return candidates.find((candidate) => fileSet.has(candidate)) || base;
}

function discoverPastIncidents(root, files) {
  return files
    .filter((file) => /^\.synthi\/codesite\/.+\/(near-misses|incidents)\/.+\.jsonl?$/i.test(file))
    .slice(0, 100)
    .map((file) => {
      const text = readTextIfExists(path.join(root, file), 300000);
      if (!text) return null;
      const parsed = parseIncidentText(text);
      return {
        category: parsed.category || 'near_miss',
        severity: parsed.severity || 'medium',
        affectedPaths: parsed.affectedPaths,
        refs: [file],
      };
    })
    .filter((incident) => incident?.affectedPaths?.length);
}

function parseIncidentText(text) {
  try {
    const parsed = JSON.parse(text);
    return {
      category: parsed.category || parsed.type,
      severity: parsed.severity,
      affectedPaths: parsed.affectedPaths || parsed.affectedZones || parsed.paths || [],
    };
  } catch (_) {
    const affectedPaths = [...text.matchAll(/"((?:[^"\\]|\\.)+\*\*?(?:[^"\\]|\\.)*)"/g)].map((match) => match[1]);
    return { affectedPaths };
  }
}

function discoverSecretPatterns(files) {
  const patterns = ['**/.env', '**/.env.*', 'secrets/**', '**/*.pem', '**/*.key'];
  if (files.some((file) => /(^|\/)vault(\/|$)/i.test(file))) patterns.push('vault/**');
  if (files.some((file) => /(^|\/)credentials?(\/|$)/i.test(file))) patterns.push('credentials/**');
  return patterns;
}

function isOpenApiFile(file) {
  return /(^|\/)(openapi|swagger)(\.[^.\/]+)?\.(ya?ml|json)$/i.test(file)
    || /(^|\/)openapi\/.+\.(ya?ml|json)$/i.test(file);
}

function isDeploymentFile(file) {
  return /^infra\/prod\//i.test(file)
    || /^infra\/production\//i.test(file)
    || /^deploy(ment)?\//i.test(file)
    || /^k8s\//i.test(file)
    || /^helm\//i.test(file)
    || /^terraform\//i.test(file)
    || /^\.github\/workflows\//i.test(file)
    || /^docker-compose(\..+)?\.ya?ml$/i.test(file);
}

function normalizeCodeownerPattern(pattern) {
  const value = String(pattern || '').replace(/^\/+/, '').trim();
  if (!value) return '';
  if (value.endsWith('/')) return `${value}**`;
  return value;
}

function normalizeRepoPath(value) {
  return normalizePath(String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, ''));
}

function readTextIfExists(file, maxBytes = 1000000) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(file, 'utf8');
  } catch (_) {
    return null;
  }
}

function readJsonIfExists(file) {
  const text = readTextIfExists(file);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}
