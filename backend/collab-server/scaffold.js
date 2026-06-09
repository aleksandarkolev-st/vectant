const fs = require('fs');
const path = require('path');

/**
 * Write scaffold files into `cwd`, ONLY when the target does not already exist.
 * Every path must be relative and resolve inside `cwd` (no traversal/absolute) —
 * otherwise we throw `path_escape`. Returns { written, skipped } (relative paths).
 *
 * @param {string} cwd
 * @param {{path:string, contents:string}[]} files
 */
function applyScaffoldFiles(cwd, files) {
  const root = path.resolve(cwd);
  const written = [];
  const skipped = [];
  for (const file of Array.isArray(files) ? files : []) {
    const rel = String(file?.path || '');
    if (!rel || path.isAbsolute(rel) || rel.split(/[\\/]+/).some((s) => s === '..')) {
      throw new Error('path_escape');
    }
    const target = path.resolve(root, rel);
    if (target !== root && !target.startsWith(root + path.sep)) {
      throw new Error('path_escape');
    }
    if (fs.existsSync(target)) {
      skipped.push(rel);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, String(file.contents ?? ''), 'utf8');
    written.push(rel);
  }
  return { written, skipped };
}

module.exports = { applyScaffoldFiles };
