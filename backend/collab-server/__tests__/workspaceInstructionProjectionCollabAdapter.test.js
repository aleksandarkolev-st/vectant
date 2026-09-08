'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildVectantBlock, extractVectantBlock } = require('../workspaceInstructionProjection');
const {
  prepareFileContentForIdeWrite,
  presentFileContentForIde,
  presentFileTreeForIde,
  shouldReconcileInstructionProjection,
} = require('../workspaceInstructionProjectionCollabAdapter');

function projectionResult() {
  return {
    skipped: false,
    canonicalBlock: buildVectantBlock({
      workspaceId: 'collab-workspace',
      version: 3,
      content: 'Use the active Vectant workspace.',
    }),
    projections: [
      { path: 'AGENTS.md', ownership: 'synthetic-only' },
      { path: 'CLAUDE.md', ownership: 'existing-user-file' },
      { path: 'GEMINI.md', ownership: 'synthetic-only' },
    ],
  };
}

test('only IDE file lifecycle actions reconcile passive instruction projections', () => {
  for (const action of ['files', 'files-meta', 'file', 'write-file', 'write-files-batch', 'sync']) {
    assert.equal(shouldReconcileInstructionProjection(action), true);
  }
  for (const action of ['log', 'commit', 'file-content', 'read-file', 'terminal']) {
    assert.equal(shouldReconcileInstructionProjection(action), false);
  }
});

test('hides only synthetic registered documents and strips a managed block from IDE reads', () => {
  const projection = projectionResult();
  assert.deepEqual(
    presentFileTreeForIde([
      { path: 'AGENTS.md' },
      { path: 'CLAUDE.md' },
      { path: 'README.md' },
    ], projection).map((entry) => entry.path),
    ['CLAUDE.md', 'README.md'],
  );
  assert.deepEqual(
    presentFileTreeForIde(['AGENTS.md', 'CLAUDE.md', 'README.md'], projection),
    ['CLAUDE.md', 'README.md'],
  );
  const physical = prepareFileContentForIdeWrite({ path: 'CLAUDE.md', userContent: 'Use pnpm.\n', projectionResult: projection });
  assert.equal(presentFileContentForIde({ path: 'CLAUDE.md', physicalContent: physical, projectionResult: projection }), 'Use pnpm.\n');
  assert.equal(presentFileContentForIde({ path: 'README.md', physicalContent: 'Plain text.', projectionResult: projection }), 'Plain text.');
});

test('merges user text with the current block only for registered projection paths', () => {
  const projection = projectionResult();
  const physical = prepareFileContentForIdeWrite({ path: 'AGENTS.md', userContent: '# My instructions\n', projectionResult: projection });
  assert.equal(extractVectantBlock(physical).version, '3');
  assert.equal(prepareFileContentForIdeWrite({ path: 'README.md', userContent: 'No mutation.', projectionResult: projection }), 'No mutation.');
  assert.equal(prepareFileContentForIdeWrite({ path: 'AGENTS.md', userContent: 'No feature.', projectionResult: { skipped: true } }), 'No feature.');
});

test('prepareFileContentForIdeWrite leaves a skipped (symlinked) projection path unmerged', () => {
  const projection = {
    skipped: false,
    canonicalBlock: buildVectantBlock({ workspaceId: 'w', version: 2, content: 'x' }),
    projections: [
      { path: 'AGENTS.md', ownership: 'existing-user-file' },
      { path: 'CLAUDE.md', skipped: true, reason: 'external-symlink' },
    ],
  };
  // A symlinked CLAUDE.md must never receive the managed block written through it.
  assert.equal(
    prepareFileContentForIdeWrite({ path: 'CLAUDE.md', userContent: 'hi\n', projectionResult: projection }),
    'hi\n',
  );
  // The real projection still merges.
  assert.match(
    prepareFileContentForIdeWrite({ path: 'AGENTS.md', userContent: 'hi\n', projectionResult: projection }),
    /Vectant_MANAGED_INSTRUCTIONS_BEGIN/,
  );
});
