const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PLAN_VERSION = 1;
const MAX_SCAN_DEPTH = Number(process.env.WORKSPACE_PREP_SCAN_DEPTH) || 8;

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  '.next',
  'dist',
  'build',
  'out',
  '.turbo',
  '.cache',
  '.venv',
  'venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  'target',
  '.gradle',
  '.idea',
  '.vscode',
  '.dart_tool',
  '.synthi',
  '.synthi-backups',
  '.code_intel',
  '.code_intel_backups',
]);

const EMPTY_FINGERPRINT = crypto
  .createHash('sha256')
  .update(`workspace-prep:${PLAN_VERSION}:empty`)
  .digest('hex');

function normalizeRelPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/$/, '');
}

function relJoin(base, name) {
  return base ? `${base}/${name}` : name;
}

function pathDepth(value) {
  const normalized = normalizeRelPath(value);
  if (!normalized) return 0;
  return normalized.split('/').length;
}

function isDescendantPath(child, parent) {
  const normalizedChild = normalizeRelPath(child);
  const normalizedParent = normalizeRelPath(parent);
  if (!normalizedParent || normalizedChild === normalizedParent) return false;
  return normalizedChild.startsWith(`${normalizedParent}/`);
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}

function hasDependencyMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0;
}

function hasNodeWorkspaces(parsedPackageJson) {
  if (!parsedPackageJson || typeof parsedPackageJson !== 'object') return false;
  if (Array.isArray(parsedPackageJson.workspaces) && parsedPackageJson.workspaces.length > 0) return true;
  const packageGroups = parsedPackageJson.workspaces && parsedPackageJson.workspaces.packages;
  return Array.isArray(packageGroups) && packageGroups.length > 0;
}

function hasNodeDependencies(parsedPackageJson) {
  if (!parsedPackageJson || typeof parsedPackageJson !== 'object') return false;
  return [
    parsedPackageJson.dependencies,
    parsedPackageJson.devDependencies,
    parsedPackageJson.optionalDependencies,
  ].some(hasDependencyMap);
}

async function readManifestText(absPath, relPath, manifestTexts) {
  const normalizedRel = normalizeRelPath(relPath);
  if (manifestTexts.has(normalizedRel)) return manifestTexts.get(normalizedRel);
  try {
    const text = await fs.promises.readFile(absPath, 'utf8');
    manifestTexts.set(normalizedRel, text);
    return text;
  } catch (_) {
    return null;
  }
}

async function collectDirectories(repoPath) {
  const directories = [];
  const stack = [{ absPath: repoPath, relPath: '', depth: 0 }];

  while (stack.length) {
    const current = stack.pop();
    let entries;
    try {
      entries = await fs.promises.readdir(current.absPath, { withFileTypes: true });
    } catch (_) {
      continue;
    }

    const fileNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
    directories.push({ ...current, entries, fileNames });

    if (current.depth >= MAX_SCAN_DEPTH) continue;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (SKIP_DIRS.has(entry.name)) continue;
      stack.push({
        absPath: path.join(current.absPath, entry.name),
        relPath: relJoin(current.relPath, entry.name),
        depth: current.depth + 1,
      });
    }
  }

  return directories;
}

async function buildNodeTask(directory, manifestTexts) {
  if (!directory.fileNames.has('package.json')) return null;

  const packageJsonRel = relJoin(directory.relPath, 'package.json');
  const packageJsonText = await readManifestText(path.join(directory.absPath, 'package.json'), packageJsonRel, manifestTexts);
  const parsedPackageJson = safeJsonParse(packageJsonText);

  const packageManagerField = String(parsedPackageJson?.packageManager || '').toLowerCase();
  const hasWorkspaces = hasNodeWorkspaces(parsedPackageJson);
  const hasDependencies = hasNodeDependencies(parsedPackageJson);
  const hasPackageLock = directory.fileNames.has('package-lock.json') || directory.fileNames.has('npm-shrinkwrap.json');
  const hasPnpmLock = directory.fileNames.has('pnpm-lock.yaml');
  const hasYarnLock = directory.fileNames.has('yarn.lock');

  if (!hasWorkspaces && !hasDependencies && !hasPackageLock && !hasPnpmLock && !hasYarnLock) {
    return null;
  }

  let packageManager = 'npm';
  if (hasPnpmLock || packageManagerField.startsWith('pnpm@')) {
    packageManager = 'pnpm';
  } else if (hasYarnLock || packageManagerField.startsWith('yarn@')) {
    packageManager = 'yarn';
  }

  const manifestPaths = [packageJsonRel];
  if (hasPackageLock) {
    if (directory.fileNames.has('package-lock.json')) manifestPaths.push(relJoin(directory.relPath, 'package-lock.json'));
    if (directory.fileNames.has('npm-shrinkwrap.json')) manifestPaths.push(relJoin(directory.relPath, 'npm-shrinkwrap.json'));
  }
  if (hasPnpmLock) manifestPaths.push(relJoin(directory.relPath, 'pnpm-lock.yaml'));
  if (hasYarnLock) manifestPaths.push(relJoin(directory.relPath, 'yarn.lock'));
  if (directory.fileNames.has('.yarnrc.yml')) manifestPaths.push(relJoin(directory.relPath, '.yarnrc.yml'));
  if (directory.fileNames.has('.npmrc')) manifestPaths.push(relJoin(directory.relPath, '.npmrc'));

  for (const manifestPath of manifestPaths.slice(1)) {
    await readManifestText(path.join(directory.absPath, path.basename(manifestPath)), manifestPath, manifestTexts);
  }

  const commandSummary = packageManager === 'pnpm'
    ? (hasPnpmLock ? 'corepack pnpm install --frozen-lockfile' : 'corepack pnpm install')
    : packageManager === 'yarn'
      ? 'corepack yarn install'
      : hasPackageLock
        ? 'npm ci'
        : 'npm install';

  return {
    id: `node:${directory.relPath || '.'}`,
    ecosystem: 'node',
    rootPath: normalizeRelPath(directory.relPath),
    manifestPaths: manifestPaths.map(normalizeRelPath),
    commandSummary,
    timeoutMs: 30 * 60 * 1000,
    packageManager,
    hasWorkspaces,
  };
}

async function buildPythonTask(directory, manifestTexts) {
  const hasRequirements = directory.fileNames.has('requirements.txt');
  const hasPyproject = directory.fileNames.has('pyproject.toml');
  if (!hasRequirements && !hasPyproject) return null;

  const manifestPaths = [];
  if (hasRequirements) {
    const rel = relJoin(directory.relPath, 'requirements.txt');
    manifestPaths.push(rel);
    await readManifestText(path.join(directory.absPath, 'requirements.txt'), rel, manifestTexts);
  }
  if (hasPyproject) {
    const rel = relJoin(directory.relPath, 'pyproject.toml');
    manifestPaths.push(rel);
    await readManifestText(path.join(directory.absPath, 'pyproject.toml'), rel, manifestTexts);
  }
  for (const extraFile of ['poetry.lock', 'uv.lock', 'pdm.lock']) {
    if (!directory.fileNames.has(extraFile)) continue;
    const rel = relJoin(directory.relPath, extraFile);
    manifestPaths.push(rel);
    await readManifestText(path.join(directory.absPath, extraFile), rel, manifestTexts);
  }

  const commandSummary = hasRequirements && hasPyproject
    ? 'python -m venv .venv && pip install -r requirements.txt && pip install -e .'
    : hasRequirements
      ? 'python -m venv .venv && pip install -r requirements.txt'
      : 'python -m venv .venv && pip install -e .';

  return {
    id: `python:${directory.relPath || '.'}`,
    ecosystem: 'python',
    rootPath: normalizeRelPath(directory.relPath),
    manifestPaths: manifestPaths.map(normalizeRelPath),
    commandSummary,
    timeoutMs: 30 * 60 * 1000,
    requirementsFile: hasRequirements ? 'requirements.txt' : null,
    editableInstall: hasPyproject,
  };
}

async function buildRustTask(directory, manifestTexts) {
  if (!directory.fileNames.has('Cargo.toml')) return null;

  const cargoRel = relJoin(directory.relPath, 'Cargo.toml');
  const cargoText = await readManifestText(path.join(directory.absPath, 'Cargo.toml'), cargoRel, manifestTexts);
  const manifestPaths = [cargoRel];
  const hasCargoLock = directory.fileNames.has('Cargo.lock');
  if (hasCargoLock) {
    const lockRel = relJoin(directory.relPath, 'Cargo.lock');
    manifestPaths.push(lockRel);
    await readManifestText(path.join(directory.absPath, 'Cargo.lock'), lockRel, manifestTexts);
  }

  return {
    id: `rust:${directory.relPath || '.'}`,
    ecosystem: 'rust',
    rootPath: normalizeRelPath(directory.relPath),
    manifestPaths: manifestPaths.map(normalizeRelPath),
    commandSummary: hasCargoLock ? 'cargo fetch --locked' : 'cargo fetch',
    timeoutMs: 20 * 60 * 1000,
    hasCargoLock,
    isWorkspaceRoot: /(^|\n)\s*\[workspace\]\s*($|\n)/m.test(cargoText || ''),
  };
}

async function buildMavenTask(directory, manifestTexts) {
  if (!directory.fileNames.has('pom.xml')) return null;

  const manifestPaths = [relJoin(directory.relPath, 'pom.xml')];
  await readManifestText(path.join(directory.absPath, 'pom.xml'), manifestPaths[0], manifestTexts);

  let wrapper = null;
  if (directory.fileNames.has('mvnw')) wrapper = 'mvnw';
  else if (directory.fileNames.has('mvnw.cmd')) wrapper = 'mvnw.cmd';

  if (wrapper) {
    const rel = relJoin(directory.relPath, wrapper);
    manifestPaths.push(rel);
    await readManifestText(path.join(directory.absPath, wrapper), rel, manifestTexts);
  }

  return {
    id: `maven:${directory.relPath || '.'}`,
    ecosystem: 'maven',
    rootPath: normalizeRelPath(directory.relPath),
    manifestPaths: manifestPaths.map(normalizeRelPath),
    commandSummary: `${wrapper || 'mvn'} -q -DskipTests dependency:go-offline`,
    timeoutMs: 30 * 60 * 1000,
    wrapper,
  };
}

async function buildGradleTask(directory, manifestTexts) {
  if (!directory.fileNames.has('build.gradle') && !directory.fileNames.has('build.gradle.kts')) return null;

  const manifestPaths = [];
  for (const fileName of ['build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts']) {
    if (!directory.fileNames.has(fileName)) continue;
    const rel = relJoin(directory.relPath, fileName);
    manifestPaths.push(rel);
    await readManifestText(path.join(directory.absPath, fileName), rel, manifestTexts);
  }

  let wrapper = null;
  if (directory.fileNames.has('gradlew')) wrapper = 'gradlew';
  else if (directory.fileNames.has('gradlew.bat')) wrapper = 'gradlew.bat';

  if (wrapper) {
    const rel = relJoin(directory.relPath, wrapper);
    manifestPaths.push(rel);
    await readManifestText(path.join(directory.absPath, wrapper), rel, manifestTexts);
  }

  return {
    id: `gradle:${directory.relPath || '.'}`,
    ecosystem: 'gradle',
    rootPath: normalizeRelPath(directory.relPath),
    manifestPaths: manifestPaths.map(normalizeRelPath),
    commandSummary: `${wrapper || 'gradle'} --no-daemon dependencies`,
    timeoutMs: 30 * 60 * 1000,
    wrapper,
  };
}

async function buildDartTask(directory, manifestTexts) {
  if (!directory.fileNames.has('pubspec.yaml')) return null;

  const pubspecRel = relJoin(directory.relPath, 'pubspec.yaml');
  const pubspecText = await readManifestText(path.join(directory.absPath, 'pubspec.yaml'), pubspecRel, manifestTexts);
  const manifestPaths = [pubspecRel];
  if (directory.fileNames.has('pubspec.lock')) {
    const lockRel = relJoin(directory.relPath, 'pubspec.lock');
    manifestPaths.push(lockRel);
    await readManifestText(path.join(directory.absPath, 'pubspec.lock'), lockRel, manifestTexts);
  }

  const isFlutter = /(^|\n)\s*flutter:\s*($|\n)/m.test(pubspecText || '') || /sdk:\s*flutter/m.test(pubspecText || '');

  return {
    id: `dart:${directory.relPath || '.'}`,
    ecosystem: 'dart',
    rootPath: normalizeRelPath(directory.relPath),
    manifestPaths: manifestPaths.map(normalizeRelPath),
    commandSummary: isFlutter ? 'flutter pub get' : 'dart pub get',
    timeoutMs: 20 * 60 * 1000,
    isFlutter,
  };
}

function dedupeWorkspaceRoots(tasks, ecosystem, workspaceFlag) {
  const roots = tasks
    .filter((task) => task.ecosystem === ecosystem && task[workspaceFlag])
    .sort((left, right) => pathDepth(left.rootPath) - pathDepth(right.rootPath));

  if (!roots.length) return tasks;

  return tasks.filter((task) => {
    if (task.ecosystem !== ecosystem) return true;
    return !roots.some((root) => root.id !== task.id && isDescendantPath(task.rootPath, root.rootPath));
  });
}

async function computeFingerprint(tasks, manifestTexts) {
  if (!tasks.length) return EMPTY_FINGERPRINT;

  const hash = crypto.createHash('sha256');
  hash.update(`workspace-prep:${PLAN_VERSION}`);

  const sortedTasks = [...tasks].sort((left, right) => left.id.localeCompare(right.id));
  for (const task of sortedTasks) {
    hash.update(task.id);
    hash.update(task.ecosystem);
    hash.update(task.commandSummary);
    for (const manifestPath of [...task.manifestPaths].sort()) {
      hash.update(manifestPath);
      hash.update('\0');
      hash.update(manifestTexts.get(manifestPath) || '');
      hash.update('\0');
    }
  }

  return hash.digest('hex');
}

async function planWorkspacePrep(repoPath) {
  try {
    await fs.promises.access(repoPath);
  } catch (_) {
    return {
      version: PLAN_VERSION,
      fingerprint: EMPTY_FINGERPRINT,
      manifests: [],
      tasks: [],
    };
  }

  const manifestTexts = new Map();
  const directories = await collectDirectories(repoPath);
  const tasks = [];

  for (const directory of directories) {
    const taskCandidates = await Promise.all([
      buildNodeTask(directory, manifestTexts),
      buildPythonTask(directory, manifestTexts),
      buildRustTask(directory, manifestTexts),
      buildMavenTask(directory, manifestTexts),
      buildGradleTask(directory, manifestTexts),
      buildDartTask(directory, manifestTexts),
    ]);
    tasks.push(...taskCandidates.filter(Boolean));
  }

  let plannedTasks = [...tasks];
  plannedTasks = dedupeWorkspaceRoots(plannedTasks, 'node', 'hasWorkspaces');
  plannedTasks = dedupeWorkspaceRoots(plannedTasks, 'rust', 'isWorkspaceRoot');
  plannedTasks.sort((left, right) => {
    const depthDelta = pathDepth(left.rootPath) - pathDepth(right.rootPath);
    if (depthDelta !== 0) return depthDelta;
    return left.id.localeCompare(right.id);
  });

  const manifests = [...new Set(plannedTasks.flatMap((task) => task.manifestPaths))].sort();
  const fingerprint = await computeFingerprint(plannedTasks, manifestTexts);

  return {
    version: PLAN_VERSION,
    fingerprint,
    manifests,
    tasks: plannedTasks,
  };
}

module.exports = {
  PLAN_VERSION,
  planWorkspacePrep,
};
