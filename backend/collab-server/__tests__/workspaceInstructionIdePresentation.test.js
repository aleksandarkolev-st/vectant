'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildVectantBlock,
  extractVectantBlocks,
  stripVectantBlock,
} = require('../workspaceInstructionProjection');
const {
  PROJECTION_OWNERSHIP,
} = require('../workspaceInstructionProjectionConfig');
const {
  classifyInstructionProjectionForIde,
  filterInstructionProjectionsFromIdeTree,
  mergeInstructionProjectionWriteFromIde,
  readInstructionProjectionForIde,
} = require('../workspaceInstructionIdePresentation');

function canonicalInstructions(overrides = {}) {
  return {
    workspaceId: 'workspace_ide_presentation',
    version: 3,
    hash: 'presentation-hash',
    content: 'Use the Vectant workspace environment.',
    ...overrides,
  };
}

function metadata(projections) {
  return { workspaceId: 'workspace_ide_presentation', projections };
}

test('the IDE tree hides only known synthetic-only passive instruction projections', () => {
  const originalEntries = [
    { path: 'AGENTS.md', size: 100 },
    { path: 'CLAUDE.md', size: 200 },
    { path: 'GEMINI.md', size: 300 },
    { path: 'README.md', size: 400 },
  ];
  const result = filterInstructionProjectionsFromIdeTree(originalEntries, {
    projectionMetadata: metadata({
      'AGENTS.md': { ownership: PROJECTION_OWNERSHIP.SYNTHETIC_ONLY },
      'CLAUDE.md': { ownership: PROJECTION_OWNERSHIP.EXISTING_USER_FILE },
      // Missing state is deliberately visible during conservative recovery.
    }),
  });

  assert.deepEqual(result.map(({ path }) => path), ['CLAUDE.md', 'GEMINI.md', 'README.md']);
  assert.equal(originalEntries.length, 4);
  assert.equal(classifyInstructionProjectionForIde({
    path: 'README.md',
    projectionMetadata: metadata({ 'README.md': { ownership: PROJECTION_OWNERSHIP.SYNTHETIC_ONLY } }),
  }).hideFromExplorer, false);
});

test('classifyInstructionProjectionForIde treats an external (skipped) projection as a plain file', () => {
  const c = classifyInstructionProjectionForIde({
    path: 'CLAUDE.md',
    projectionMetadata: { projections: { 'CLAUDE.md': { external: true } } },
  });
  assert.equal(c.isInstructionProjection, false);
  assert.equal(c.hideFromExplorer, false);
  assert.equal(c.externalProjection, true);
});

test('a supplied classifier can identify synthetic ownership but cannot hide an unregistered user file', () => {
  const classifier = ({ path }) => path === 'GEMINI.md'
    ? { ownership: PROJECTION_OWNERSHIP.SYNTHETIC_ONLY }
    : { ownership: PROJECTION_OWNERSHIP.SYNTHETIC_ONLY };

  assert.equal(classifyInstructionProjectionForIde({
    path: 'GEMINI.md',
    classifyProjection: classifier,
  }).hideFromExplorer, true);
  assert.equal(classifyInstructionProjectionForIde({
    path: 'docs/AGENTS.md',
    classifyProjection: classifier,
  }).hideFromExplorer, false);
});

test('IDE reads strip complete Vectant blocks only from registered projection paths', () => {
  const block = buildVectantBlock(canonicalInstructions());
  const terminalContent = `Use pnpm.\n\n${block}`;

  const instructionRead = readInstructionProjectionForIde({
    path: 'AGENTS.md',
    physicalContent: terminalContent,
  });
  assert.equal(instructionRead.content, 'Use pnpm.\n\n');
  assert.equal(instructionRead.isInstructionProjection, true);

  const ordinaryRead = readInstructionProjectionForIde({
    path: 'notes.md',
    physicalContent: terminalContent,
  });
  assert.equal(ordinaryRead.content, terminalContent);
  assert.equal(ordinaryRead.isInstructionProjection, false);
});

test('IDE writes restore exactly one canonical managed block without sending it through the UI', () => {
  const staleBlock = buildVectantBlock(canonicalInstructions({ version: 1, hash: 'stale', content: 'Old instructions.' }));
  const result = mergeInstructionProjectionWriteFromIde({
    path: 'CLAUDE.md',
    userContent: `Use Python 3.13.\n\n${staleBlock}`,
    canonicalInstructions: canonicalInstructions(),
    projectionMetadata: metadata({
      'CLAUDE.md': { ownership: PROJECTION_OWNERSHIP.SYNTHETIC_ONLY },
    }),
  });

  assert.equal(result.mergedManagedBlock, true);
  assert.equal(result.syntheticOnly, true);
  assert.equal(stripVectantBlock(result.content), 'Use Python 3.13.\n\n');
  assert.equal(extractVectantBlocks(result.content).length, 1);
  assert.match(result.content, /version: 3/);
});

test('IDE writes preserve CRLF user content and ordinary files pass through without canonical instructions', () => {
  const projected = mergeInstructionProjectionWriteFromIde({
    path: 'GEMINI.md',
    userContent: 'Use Windows line endings.\r\n',
    canonicalInstructions: canonicalInstructions(),
  });
  assert.equal(stripVectantBlock(projected.content), 'Use Windows line endings.\r\n');
  assert.equal(projected.content.includes('\r\n'), true);

  const ordinary = mergeInstructionProjectionWriteFromIde({
    path: 'src/index.js',
    userContent: 'export default 1;\n',
  });
  assert.deepEqual(ordinary, {
    path: 'src/index.js',
    isInstructionProjection: false,
    ownership: null,
    syntheticOnly: false,
    hideFromExplorer: false,
    externalProjection: false,
    content: 'export default 1;\n',
    mergedManagedBlock: false,
  });
});

test('projection writes require a canonical managed block instead of silently dropping it', () => {
  assert.throws(() => mergeInstructionProjectionWriteFromIde({
    path: 'AGENTS.md',
    userContent: 'User instructions.',
  }), /canonical_block_required/);
});
