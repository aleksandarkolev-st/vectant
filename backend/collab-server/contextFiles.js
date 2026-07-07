const fs = require('fs');
const path = require('path');

// Curated files that help a model infer how to run a project. Read-only; never
// returns anything outside this allow-list (no arbitrary workspace exfiltration).
const CONTEXT_FILES = [
  'package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml',
  'Dockerfile', 'docker-compose.yml', 'compose.yaml', 'compose.yml',
  '.devcontainer/devcontainer.json', 'devcontainer.json',
  'README.md', 'README',
];

/** Read the present allow-listed context files under cwd → { name: contents }. */
function readContextFiles(cwd) {
  const root = path.resolve(cwd);
  const out = {};
  for (const name of CONTEXT_FILES) {
    const file = path.join(root, name);
    try {
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        out[name] = fs.readFileSync(file, 'utf8').slice(0, 20000);
      }
    } catch {
      // skip unreadable files
    }
  }
  return out;
}

module.exports = { readContextFiles, CONTEXT_FILES };
