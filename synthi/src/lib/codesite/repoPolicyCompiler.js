import fs from 'fs';
import path from 'path';
import { digest, normalizePath } from './policy';
import { getCodeSiteRuntimeConfig } from './runtimeConfig';

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
const OPENAPI_METHODS = new Set(['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace']);
const EXPORT_CONDITION_PRIORITY = ['types', 'import', 'module', 'require', 'node', 'browser', 'default'];
export const REPO_POLICY_COMPILER_VERSION = '2026-07-01.1';

export function discoverRepoPolicySignals(options = {}) {
  const config = getCodeSiteRuntimeConfig();
  const repoRoot = detectRepoRoot(options.root || process.env.SYNTHI_CODESITE_REPO_ROOT || process.cwd());
  const maxFiles = Number(options.maxFiles || config.repoScanMaxFiles);
  const files = listRepoFiles(repoRoot, { maxFiles });
  const truncated = files.length >= maxFiles;
  const fileSet = new Set(files);
  const codeowners = discoverCodeowners(repoRoot, fileSet);
  const openapi = discoverOpenApiContracts(repoRoot, files);
  const prisma = discoverPrisma(files);
  const packageExports = discoverPackageExports(repoRoot, files);
  const deployment = files.filter(isDeploymentFile).map((file) => ({ path: file }));
  const generatedClients = files.filter((file) => /(^|\/)(generated|client|clients)\//i.test(file)).map((file) => ({ path: file }));
  const packageIndex = buildPackageImportIndex(packageExports, fileSet);
  const { importEdges, testOwnership } = discoverImportAndTestGraph(repoRoot, files, fileSet, packageIndex);
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
    compilerVersion: REPO_POLICY_COMPILER_VERSION,
    maxFiles,
    fileCount: files.length,
    truncated,
  };
  return {
    ...signals,
    digest: digest({
      compilerVersion: REPO_POLICY_COMPILER_VERSION,
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
      maxFiles,
      truncated,
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

function discoverOpenApiContracts(root, files) {
  return files.filter(isOpenApiFile).map((file) => {
    const text = readTextIfExists(path.join(root, file), 800000) || '';
    const operations = parseOpenApiOperations(text, file);
    const contractPaths = [...new Set(operations.map((operation) => operation.path).filter(Boolean))];
    return {
      path: file,
      contractPaths,
      routePatterns: contractRoutePatterns(contractPaths),
      operations,
    };
  });
}

function parseOpenApiOperations(text, file) {
  if (!text) return [];
  if (/\.json$/i.test(file)) {
    try {
      const parsed = JSON.parse(text);
      return Object.entries(parsed?.paths || {}).flatMap(([contractPath, methods]) =>
        Object.entries(methods || {})
          .filter(([method]) => OPENAPI_METHODS.has(String(method).toLowerCase()))
          .map(([method, operation]) => ({
            path: contractPath,
            method: String(method).toUpperCase(),
            operationId: operation?.operationId || null,
          })));
    } catch (_) {
      return [];
    }
  }

  const operations = [];
  let currentPath = null;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const pathMatch = line.match(/^ {2}(['"]?\/[^:'"]+['"]?):\s*$/);
    if (pathMatch) {
      currentPath = pathMatch[1].replace(/^['"]|['"]$/g, '');
      continue;
    }
    const methodMatch = line.match(/^ {4}(get|put|post|delete|patch|options|head|trace):\s*$/i);
    if (currentPath && methodMatch) {
      operations.push({
        path: currentPath,
        method: methodMatch[1].toUpperCase(),
        operationId: null,
      });
    }
  }
  return operations;
}

function contractRoutePatterns(contractPaths) {
  const patterns = [];
  for (const contractPath of contractPaths) {
    const normalized = String(contractPath || '')
      .replace(/[{}]/g, '')
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
    if (!normalized) continue;
    patterns.push(
      `api/${normalized}/**`,
      `app/api/${normalized}/**`,
      `src/app/api/${normalized}/**`,
      `pages/api/${normalized}/**`,
    );
  }
  return [...new Set(patterns)];
}

function discoverPackageExports(root, files) {
  return files
    .filter((file) => file.endsWith('package.json'))
    .map((file) => {
      const manifest = readJsonIfExists(path.join(root, file));
      if (!manifest) return null;
      const rootDir = path.dirname(file) === '.' ? '' : path.dirname(file);
      const exportMap = packageExportMapFromManifest(manifest, rootDir);
      const exports = [...new Set(Object.values(exportMap).flat())];
      const hasPublicSurface = exports.length > 0 || manifest.main || manifest.module || manifest.types;
      if (!hasPublicSurface || rootDir === '') return null;
      return {
        packageName: manifest.name || rootDir,
        root: rootDir,
        exports,
        exportMap,
      };
    })
    .filter(Boolean);
}

function buildPackageImportIndex(packageExports, fileSet) {
  const index = new Map();
  for (const entry of packageExports) {
    if (!entry?.packageName || !entry.root) continue;
    index.set(entry.packageName, {
      ...entry,
      candidates: packageImportCandidates(entry, fileSet),
    });
  }
  return index;
}

function packageImportCandidates(entry, fileSet) {
  const explicit = [...new Set(entry.exports || [])].filter((candidate) => candidate && !candidate.includes('*'));
  const root = entry.root.replace(/\/+$/, '');
  const fallback = [
    `${root}/src/index.ts`,
    `${root}/src/index.tsx`,
    `${root}/index.ts`,
    `${root}/index.tsx`,
    `${root}/index.js`,
    `${root}/index.jsx`,
  ].filter((candidate) => fileSet.has(candidate));
  return [...new Set([...explicit, ...fallback])];
}

function packageExportMapFromManifest(manifest, rootDir) {
  const out = {};
  collectExportMapEntries(manifest.exports, out, '.');
  for (const key of ['main', 'module', 'types', 'typings']) {
    if (manifest[key]) addPackageExportTarget(out, '.', manifest[key]);
  }
  return Object.fromEntries(Object.entries(out)
    .map(([key, values]) => [key, [...new Set(values
      .map((value) => normalizeRepoPath(path.join(rootDir, String(value).replace(/^\.\//, ''))))
      .filter(Boolean))]])
    .filter(([, values]) => values.length > 0)
    .sort(([left], [right]) => left.localeCompare(right)));
}

function collectExportMapEntries(value, out, key = '.') {
  if (!value) return;
  if (typeof value === 'string') {
    addPackageExportTarget(out, key, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectExportMapEntries(item, out, key);
    return;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value);
    const hasSubpathKeys = entries.some(([entryKey]) => String(entryKey).startsWith('.'));
    if (hasSubpathKeys) {
      for (const [entryKey, child] of entries) {
        if (String(entryKey).startsWith('.')) collectExportMapEntries(child, out, normalizeExportKey(entryKey));
      }
      return;
    }
    for (const [, child] of orderedExportConditionEntries(entries)) collectExportMapEntries(child, out, key);
  }
}

function orderedExportConditionEntries(entries) {
  return [...entries].sort(([left], [right]) => {
    const leftIndex = EXPORT_CONDITION_PRIORITY.indexOf(left);
    const rightIndex = EXPORT_CONDITION_PRIORITY.indexOf(right);
    if (leftIndex !== -1 || rightIndex !== -1) {
      return (leftIndex === -1 ? EXPORT_CONDITION_PRIORITY.length : leftIndex)
        - (rightIndex === -1 ? EXPORT_CONDITION_PRIORITY.length : rightIndex);
    }
    return left.localeCompare(right);
  });
}

function normalizeExportKey(key) {
  const value = String(key || '.').replace(/\\/g, '/').trim();
  if (!value || value === '.') return '.';
  return value.startsWith('./') ? value : `./${value.replace(/^\/+/, '')}`;
}

function addPackageExportTarget(out, key, value) {
  if (typeof value !== 'string' || !value.trim()) return;
  const exportKey = normalizeExportKey(key);
  out[exportKey] ||= [];
  out[exportKey].push(value);
}

function discoverImportAndTestGraph(root, files, fileSet, packageIndex) {
  const sourceFiles = files.filter((file) => SOURCE_EXTENSIONS.has(path.extname(file)));
  const importEdges = [];
  const testOwnership = [];
  for (const file of sourceFiles) {
    const text = readTextIfExists(path.join(root, file), 300000);
    if (!text) continue;
    const imports = parseImports(text)
      .map((specifier) => resolveImportPath(file, specifier, fileSet, packageIndex))
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

function resolveImportPath(fromFile, specifier, fileSet, packageIndex = new Map()) {
  if (!specifier) return null;
  if (!specifier.startsWith('.')) return resolvePackageImport(specifier, packageIndex, fileSet);
  const base = normalizeRepoPath(path.join(path.dirname(fromFile), specifier));
  if (!base) return null;
  return resolveCandidateFile(base, fileSet) || base;
}

function resolvePackageImport(specifier, packageIndex, fileSet) {
  const match = [...packageIndex.keys()]
    .filter((packageName) => specifier === packageName || specifier.startsWith(`${packageName}/`))
    .sort((left, right) => right.length - left.length)[0];
  if (!match) return null;
  const entry = packageIndex.get(match);
  const subpath = specifier === match ? '' : specifier.slice(match.length + 1);
  if (!subpath) return resolvePackageExportEntry(entry, '.', fileSet) || entry.candidates[0] || entry.root;
  const exportTarget = resolvePackageExportEntry(entry, `./${subpath}`, fileSet);
  if (exportTarget) return exportTarget;
  const root = entry.root.replace(/\/+$/, '');
  const directCandidates = [
    `${root}/${subpath}`,
    `${root}/src/${subpath}`,
    ...entry.candidates.filter((candidate) => candidate.endsWith(`/${subpath}`)),
  ];
  return directCandidates.map((candidate) => resolveCandidateFile(candidate, fileSet))
    .find(Boolean) || null;
}

function resolvePackageExportEntry(entry, exportKey, fileSet) {
  const exportMap = entry?.exportMap || { '.': entry?.exports || [] };
  const normalizedKey = normalizeExportKey(exportKey);
  const exactMatch = resolveExportTargets(asExportTargets(exportMap[normalizedKey]), fileSet);
  if (exactMatch) return exactMatch;

  for (const [patternKey, targets] of Object.entries(exportMap)) {
    if (!patternKey.includes('*')) continue;
    const captures = matchExportPattern(patternKey, normalizedKey);
    if (!captures) continue;
    const candidate = resolveExportTargets(asExportTargets(targets)
      .map((target) => replaceExportWildcards(target, captures)), fileSet);
    if (candidate) return candidate;
  }
  return null;
}

function asExportTargets(value) {
  return Array.isArray(value) ? value : [value].filter(Boolean);
}

function resolveExportTargets(targets, fileSet) {
  for (const target of targets) {
    if (!target || String(target).includes('*')) continue;
    const resolved = resolveCandidateFile(target, fileSet);
    if (resolved) return resolved;
  }
  return null;
}

function matchExportPattern(pattern, key) {
  const patternParts = String(pattern).split('*');
  if (patternParts.length === 1) return null;
  let cursor = 0;
  const captures = [];
  for (let index = 0; index < patternParts.length; index += 1) {
    const part = patternParts[index];
    if (!part) continue;
    const found = key.indexOf(part, cursor);
    if (found === -1 || (index === 0 && found !== 0)) return null;
    if (index > 0) captures.push(key.slice(cursor, found));
    cursor = found + part.length;
  }
  if (patternParts.at(-1) && cursor !== key.length) return null;
  if (!patternParts.at(-1)) captures.push(key.slice(cursor));
  return captures.length ? captures : null;
}

function replaceExportWildcards(target, captures) {
  let index = 0;
  return String(target).replace(/\*/g, () => captures[index++] || captures[0] || '');
}

function resolveCandidateFile(base, fileSet) {
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
  return candidates.find((candidate) => fileSet.has(candidate)) || null;
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
