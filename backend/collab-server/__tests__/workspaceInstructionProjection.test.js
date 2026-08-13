'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  INSTRUCTION_PROJECTIONS,
  VECTANT_MANAGED_INSTRUCTIONS_BEGIN,
  VECTANT_MANAGED_INSTRUCTIONS_END,
  buildVectantBlock,
  containsUserContent,
  createInstructionProjectionRegistry,
  extractVectantBlock,
  extractVectantBlocks,
  getEnabledInstructionProjections,
  isInstructionProjectionPath,
  mergeVectantBlock,
  normalizeProjectionPath,
  stripVectantBlock,
} = require('../workspaceInstructionProjection');

function instructions(overrides = {}) {
  return {
    workspaceId: 'workspace_123',
    version: 4,
    content: 'Always use the Vectant environment configuration.\nDo not delete Vectant-managed workspace resources.',
    hash: 'abc123',
    ...overrides,
  };
}

test('registry is declarative, validates paths, and has the initial passive conventions', () => {
  assert.deepEqual(INSTRUCTION_PROJECTIONS.map(({ path }) => path), ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md']);
  assert.deepEqual(getEnabledInstructionProjections([
    { path: 'AGENTS.md', enabled: true },
    { path: 'CLAUDE.md', enabled: false },
    { path: 'GEMINI.md', enabled: true },
  ]).map(({ path }) => path), ['AGENTS.md', 'GEMINI.md']);
  assert.equal(isInstructionProjectionPath('CLAUDE.md'), true);
  assert.equal(isInstructionProjectionPath('claude.md'), false);
  assert.equal(isInstructionProjectionPath('../AGENTS.md'), false);
  assert.equal(normalizeProjectionPath('nested\\INSTRUCTIONS.md'), 'nested/INSTRUCTIONS.md');
  assert.throws(() => createInstructionProjectionRegistry([{ path: 'AGENTS.md' }, { path: 'agents.md' }]), /duplicate/);
  assert.throws(() => normalizeProjectionPath('../AGENTS.md'), /invalid/);
  assert.throws(() => normalizeProjectionPath('/AGENTS.md'), /invalid/);
});

test('builds and extracts the canonical block including identity metadata and payload', () => {
  const block = buildVectantBlock(instructions());
  const extracted = extractVectantBlock(block);
  assert.match(block, new RegExp(`^${VECTANT_MANAGED_INSTRUCTIONS_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(block, /Vectant_INSTRUCTION_SET_ID=workspace_123:v4/);
  assert.match(block, /user-content-separator-lines: 0/);
  assert.equal(extracted.workspaceId, 'workspace_123');
  assert.equal(extracted.version, '4');
  assert.equal(extracted.hash, 'abc123');
  assert.equal(extracted.instructionSetId, 'workspace_123:v4');
  assert.equal(extracted.content, instructions().content);
  assert.equal(extracted.raw, block);
  assert.equal(stripVectantBlock(block), '');
});

test('merges an existing AGENTS.md without changing its content and strips it for IDE reads', () => {
  const userContent = 'Use pnpm.\n\nRun tests before committing.';
  const terminalContent = mergeVectantBlock(userContent, buildVectantBlock(instructions()));
  assert.equal(terminalContent, `${userContent}\n\n${buildVectantBlock(instructions({}), { userContentSeparatorLines: 2 })}`);
  assert.equal(stripVectantBlock(terminalContent), userContent);
  assert.equal(containsUserContent(terminalContent), true);
});

test('uses CRLF consistently and restores byte-identical user content', () => {
  const userContent = 'Use pnpm.\r\n\r\nRun tests before committing.\r\n';
  const terminalContent = mergeVectantBlock(userContent, buildVectantBlock(instructions(), { lineEnding: '\r\n' }));
  assert.equal(terminalContent.includes('\n') && !terminalContent.includes('\r\n'), false);
  assert.equal(terminalContent.includes('\r\n'), true);
  assert.equal(stripVectantBlock(terminalContent), userContent);
  assert.equal(extractVectantBlock(terminalContent).lineEnding, '\r\n');
});

test('empty files create only a block and preserve missing trailing newlines in user content', () => {
  const block = buildVectantBlock(instructions());
  assert.equal(mergeVectantBlock('', block), block);
  assert.equal(stripVectantBlock(mergeVectantBlock('no trailing newline', block)), 'no trailing newline');
  assert.equal(containsUserContent(mergeVectantBlock('', block)), false);
  assert.equal(containsUserContent('  \n\t'), false);
});

test('reconciliation is idempotent and collapses duplicate managed blocks', () => {
  const current = buildVectantBlock(instructions({ version: 5, content: 'Current instructions.', hash: 'current' }));
  const stale = buildVectantBlock(instructions({ version: 3, content: 'Stale instructions.', hash: 'stale' }));
  const duplicateContent = mergeVectantBlock('User instructions.', stale);
  const withDuplicate = `${duplicateContent}\n\n${buildVectantBlock(instructions({ version: 2, content: 'Older instructions.', hash: 'older' }), { userContentSeparatorLines: 2 })}`;
  const reconciled = mergeVectantBlock(withDuplicate, current);
  assert.equal(extractVectantBlocks(reconciled).length, 1);
  assert.equal(extractVectantBlock(reconciled).version, '5');
  assert.equal(stripVectantBlock(reconciled), 'User instructions.');
  assert.equal(mergeVectantBlock(reconciled, current), reconciled);
});

test('extracts only complete valid blocks and preserves malformed markers conservatively', () => {
  const complete = buildVectantBlock(instructions());
  const malformedMissingEnd = `${VECTANT_MANAGED_INSTRUCTIONS_BEGIN}\nid: workspace_123\nversion: 4\nhash: abc123\n-->\nuser text`;
  const malformedHeader = `${VECTANT_MANAGED_INSTRUCTIONS_BEGIN}\nid: workspace_123\nversion: 4\nhash: abc123\n${VECTANT_MANAGED_INSTRUCTIONS_END}`;
  const missingMetadata = `${VECTANT_MANAGED_INSTRUCTIONS_BEGIN}\n-->\nnot owned\n${VECTANT_MANAGED_INSTRUCTIONS_END}`;
  for (const source of [malformedMissingEnd, malformedHeader, missingMetadata]) {
    assert.equal(extractVectantBlock(source), null);
    assert.equal(stripVectantBlock(source), source);
    assert.equal(containsUserContent(source), true);
  }
  const malformedThenComplete = `${malformedMissingEnd}\n${complete}`;
  assert.equal(extractVectantBlocks(malformedThenComplete).length, 1);
  assert.equal(stripVectantBlock(malformedThenComplete), `${malformedMissingEnd}\n`);
});

test('merge rejects a block with non-managed content to avoid accidentally projecting user data', () => {
  assert.throws(() => mergeVectantBlock('User instructions.', 'not a managed block'), /managed_block_required/);
  assert.throws(() => buildVectantBlock({ workspaceId: 'workspace\n123', version: 1, content: '' }), /workspace_id/);
});

test('valid blocks embedded in prose are not mistaken for managed sections', () => {
  const block = buildVectantBlock(instructions());
  const embedded = `A quoted snippet: ${block}`;
  assert.equal(extractVectantBlock(embedded), null);
  assert.equal(stripVectantBlock(embedded), embedded);
  assert.equal(containsUserContent(embedded), true);
});

test('a terminal user adding content to a synthetic-only file is detectable', () => {
  const synthetic = buildVectantBlock(instructions());
  const terminalEdited = `# My Claude instructions\n\n${synthetic}`;
  assert.equal(containsUserContent(synthetic), false);
  assert.equal(containsUserContent(terminalEdited), true);
  assert.equal(stripVectantBlock(terminalEdited), '# My Claude instructions\n\n');
});
