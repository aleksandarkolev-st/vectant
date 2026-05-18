import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const tempDir = await mkdtemp(path.join(tmpdir(), 'synthi-ai-primitives-'));
const suitePath = path.join(tempDir, 'scripts', 'suite.mjs');

const suite = `
import assert from 'node:assert/strict';
import {
  extractCompletion,
  sanitizeCompletion,
  truncateToFirstUnit,
  lastCompletePrefix,
} from '../src/lib/completion.js';
import {
  parseBlock,
  validateBlock,
  applyBlock,
  findIndentTolerantMatch,
  NEP_BLOCK_KIND,
  REJECT_REASONS,
} from '../src/lib/nextEdit.js';
import { pushNepEdit, bufferBytes, NEP_BUFFER_BYTES } from '../src/utils/nepRecentEdits.js';
import {
  recordAiReplaySample,
  aiReplaySnapshot,
  clearAiReplaySamples,
} from '../src/lib/aiReplayHarness.js';
import {
  canHandleTabIntent,
  resetTabIntentState,
  resolveTabIntentOwner,
  TAB_INTENT_OWNER,
  updateTabIntentState,
} from '../src/app/workspace/[slug]/Editor/tabIntentRouter.js';

assert.equal(
  extractCompletion('<|completion|>return value;<|/completion|>'),
  'return value;',
);
assert.equal(
  sanitizeCompletion('OUTPUT: value + 1;\\n', { prefix: '' }),
  'value + 1;',
);

const blocky = 'if (ready) {\\n  run();\\n}\\nnextSibling();';
assert.equal(
  truncateToFirstUnit(blocky, { prefix: 'function main() {\\n  ' }),
  'if (ready) {\\n  run();\\n}',
);
assert.equal(
  lastCompletePrefix('if (ready) {\\n  run();\\n  pending'),
  'if (ready) {\\n  run();',
);

const rawBlock = [
  'src/a.js',
  '<<<<<<< SEARCH',
  'const oldName = 1;',
  '=======',
  'const newName = 1;',
  '>>>>>>> REPLACE',
].join('\\n');
const parsed = parseBlock(rawBlock);
assert.equal(parsed.ok, true);
assert.equal(parsed.block.kind, NEP_BLOCK_KIND.SEARCH);
assert.deepEqual(
  validateBlock(parsed.block, (p) => p === 'src/a.js' ? 'const oldName = 1;\\n' : null),
  { ok: true, path: 'src/a.js', matches: 1 },
);
assert.equal(
  applyBlock(parsed.block, () => 'const oldName = 1;\\n'),
  'const newName = 1;\\n',
);

const ambiguous = validateBlock(parsed.block, () => 'const oldName = 1;\\nconst oldName = 1;\\n');
assert.equal(ambiguous.ok, false);
assert.equal(ambiguous.reason, REJECT_REASONS.AMBIGUOUS);

const indent = findIndentTolerantMatch('    callThing();\\n', 'callThing();');
assert.equal(indent.ok, true);
assert.equal(indent.fileText, '    callThing();');

const allBlock = parseBlock([
  'src/a.js',
  '<<<<<<< SEARCH ALL',
  'oldName',
  '=======',
  'newName',
  '>>>>>>> REPLACE',
].join('\\n')).block;
const allValidation = validateBlock(allBlock, () => 'oldName();\\noldName();\\n');
assert.equal(allValidation.ok, false);
assert.equal(allValidation.reason, REJECT_REASONS.PHASE2_REQUIRED);
assert.equal(allValidation.matches, 2);

let buf = [];
for (let i = 0; i < 20; i++) {
  buf = pushNepEdit(buf, {
    path: 'src/a.js',
    snippet: '@@ src/a.js L1-1 @@\\n+ ' + 'x'.repeat(1200),
    searchText: 'oldName',
    replaceText: 'newName',
  });
}
assert.ok(bufferBytes(buf) <= NEP_BUFFER_BYTES);
assert.equal(buf.at(-1).searchText, 'oldName');
assert.equal(buf.at(-1).replaceText, 'newName');

clearAiReplaySamples();
recordAiReplaySample({
  feature: 'autocomplete',
  phase: 'request',
  requestId: 'req-1',
  payload: { prompt: 'x'.repeat(40_000) },
});
const replay = aiReplaySnapshot({ requestId: 'req-1' });
assert.equal(replay.length, 1);
assert.equal(replay[0].feature, 'autocomplete');
assert.equal(replay[0].phase, 'request');
assert.equal(replay[0].requestId, 'req-1');

resetTabIntentState();
assert.equal(
  resolveTabIntentOwner({ aiCompletionState: 'ready', hasAiSuggestion: true }),
  TAB_INTENT_OWNER.AI_COMPLETION,
);
updateTabIntentState({ hasDiagnosticFix: true, aiCompletionState: 'ready', hasAiSuggestion: true });
assert.equal(resolveTabIntentOwner(), TAB_INTENT_OWNER.DIAGNOSTIC_FIX);
assert.equal(canHandleTabIntent(TAB_INTENT_OWNER.AI_COMPLETION), false);
updateTabIntentState({ nepState: 'armed' });
assert.equal(resolveTabIntentOwner(), TAB_INTENT_OWNER.NEP);
assert.equal(canHandleTabIntent(TAB_INTENT_OWNER.NEP), true);
`;

try {
  await writeFile(path.join(tempDir, 'package.json'), '{"type":"module"}\n');
  await mkdir(path.join(tempDir, 'src', 'lib'), { recursive: true });
  await mkdir(path.join(tempDir, 'src', 'utils'), { recursive: true });
  await mkdir(path.join(tempDir, 'src', 'app', 'workspace', '[slug]', 'Editor'), { recursive: true });
  await mkdir(path.join(tempDir, 'scripts'), { recursive: true });

  for (const rel of [
    'src/lib/completion.js',
    'src/lib/nextEdit.js',
    'src/lib/aiReplayHarness.js',
    'src/utils/nepRecentEdits.js',
    'src/app/workspace/[slug]/Editor/tabIntentRouter.js',
  ]) {
    await writeFile(
      path.join(tempDir, rel),
      await readFile(path.join(root, rel), 'utf8'),
    );
  }
  await writeFile(suitePath, suite);

  await import(pathToFileURL(suitePath).href);
  assert.ok(true);
  console.log('AI primitive tests passed');
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
