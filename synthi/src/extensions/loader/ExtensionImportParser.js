const EXTENSION_ID_RE = /^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$/i;

function normalizeId(value) {
  return String(value || '').trim();
}

function isValidExtensionId(value) {
  return EXTENSION_ID_RE.test(value);
}

function stripLineComment(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) return '';
  return trimmed
    .replace(/\s+#.*$/, '')
    .replace(/\s+\/\/.*$/, '')
    .trim();
}

function collectJsonIds(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== 'object') return [];

  const keys = ['extensions', 'recommendations', 'unwantedRecommendations'];
  const values = [];
  for (const key of keys) {
    if (Array.isArray(parsed[key])) values.push(...parsed[key]);
  }
  return values;
}

function coerceCandidate(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  return value.id || value.extensionId || value.identifier || value.name || '';
}

/**
 * Parse exported VS Code-compatible extension lists.
 *
 * Supported inputs:
 * - Plain text, one extension ID per line, as from `code --list-extensions`
 * - JSON arrays of IDs
 * - VS Code .vscode/extensions.json recommendations objects
 *
 * @param {string} content
 * @param {{ installedIds?: Iterable<string> }} options
 * @returns {{ ids: string[], alreadyInstalled: string[], invalid: string[] }}
 */
export function parseExtensionImportList(content, options = {}) {
  const installedSet = new Set(
    Array.from(options.installedIds || []).map((id) => String(id).toLowerCase())
  );

  const text = String(content || '').trim();
  if (!text) return { ids: [], alreadyInstalled: [], invalid: [] };

  let candidates;
  try {
    candidates = collectJsonIds(JSON.parse(text));
  } catch (_) {
    candidates = text
      .split(/\r?\n/)
      .map(stripLineComment)
      .filter(Boolean);
  }

  const seen = new Set();
  const ids = [];
  const alreadyInstalled = [];
  const invalid = [];

  for (const raw of candidates) {
    const id = normalizeId(coerceCandidate(raw));
    if (!id) continue;

    const key = id.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    if (!isValidExtensionId(id)) {
      invalid.push(id);
      continue;
    }

    if (installedSet.has(key)) {
      alreadyInstalled.push(id);
      continue;
    }

    ids.push(id);
  }

  return { ids, alreadyInstalled, invalid };
}

export function splitExtensionId(extensionId) {
  const id = normalizeId(extensionId);
  const dot = id.indexOf('.');
  if (dot <= 0 || dot === id.length - 1) return null;
  return {
    namespace: id.slice(0, dot),
    name: id.slice(dot + 1),
  };
}
