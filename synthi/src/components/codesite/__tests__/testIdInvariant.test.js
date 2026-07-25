import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The CodeSite redesign splits a 9,000-line component into per-view files. The
 * stated requirement is that every user-facing action survives the split, so
 * test ids are the contract: the set of ids present in the source must remain a
 * superset of the baseline captured before any code moved.
 *
 * Additions are fine. Removals are regressions.
 *
 * Ids are matched in three forms because the shared primitives (IconButton,
 * Section, OperatorPane) take a `testId` prop rather than writing the attribute
 * inline, and some ids are built from template literals:
 *
 *   data-testid="literal"
 *   testId="literal"
 *   data-testid={`codesite-tower-now-${card.key}`}
 *
 * Template interpolations normalize to `*`, so the check tracks the id family
 * rather than the name of whatever variable fills the hole.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPONENT_ROOT = join(HERE, '..');
const BASELINE = join(HERE, '../../../../..', 'tasks/codesite-testid-baseline.txt');

const ID_PATTERN = /(?:data-testid|testId)=(?:"([^"]*)"|\{`([^`]*)`\})/g;

function sourceFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__') continue;
      found.push(...sourceFiles(full));
    } else if (/\.jsx?$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

function normalize(id) {
  return id.replace(/\$\{[^}]*\}/g, '*');
}

export function collectTestIds() {
  const ids = new Set();
  for (const file of sourceFiles(COMPONENT_ROOT)) {
    for (const match of readFileSync(file, 'utf8').matchAll(ID_PATTERN)) {
      ids.add(normalize(match[1] ?? match[2]));
    }
  }
  return ids;
}

describe('CodeSite test id invariant', () => {
  it('retains every test id present at the redesign baseline', () => {
    const baseline = readFileSync(BASELINE, 'utf8')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const present = collectTestIds();

    expect(baseline.length).toBeGreaterThan(0);
    const missing = baseline.filter((id) => !present.has(id));
    expect(missing).toEqual([]);
  });
});
