'use strict';

/**
 * Git clean/smudge entry point for Vectant's passive instruction projections.
 *
 * The command is deliberately data-driven.  Git's local filter configuration
 * passes a private state file which contains the canonical, already-rendered
 * instruction block for one active workspace.  No agent name or instruction
 * payload is embedded in this executable.
 */

const fs = require('fs');

const BEGIN = Buffer.from('<!-- Vectant_MANAGED_INSTRUCTIONS_BEGIN', 'utf8');
const END = Buffer.from('<!-- Vectant_MANAGED_INSTRUCTIONS_END -->', 'utf8');

function indexOf(buffer, needle, start = 0) {
  return buffer.indexOf(needle, start);
}

/**
 * Remove every complete Vectant managed block while preserving all user bytes.
 * The separator immediately before a managed block is Vectant-owned only when
 * it exactly matches the separator stored with the canonical block.
 */
function stripManagedInstructionBlocks(input, separator = '\n\n') {
  let remaining = Buffer.isBuffer(input) ? Buffer.from(input) : Buffer.from(String(input), 'utf8');
  const separatorBytes = Buffer.from(separator, 'utf8');
  const chunks = [];
  let cursor = 0;

  while (cursor < remaining.length) {
    const begin = indexOf(remaining, BEGIN, cursor);
    if (begin < 0) break;
    const endStart = indexOf(remaining, END, begin + BEGIN.length);
    if (endStart < 0) {
      // A malformed marker is user-controlled/ambiguous content.  Preserve it.
      break;
    }

    let userEnd = begin;
    if (
      separatorBytes.length > 0
      && begin >= separatorBytes.length
      && remaining.subarray(begin - separatorBytes.length, begin).equals(separatorBytes)
    ) {
      userEnd = begin - separatorBytes.length;
    }
    chunks.push(remaining.subarray(cursor, userEnd));
    cursor = endStart + END.length;
  }

  chunks.push(remaining.subarray(cursor));
  return Buffer.concat(chunks);
}

function appendCanonicalInstructionBlock(input, block, separator = '\n\n') {
  const userBytes = stripManagedInstructionBlocks(input, separator);
  const blockBytes = Buffer.from(String(block || ''), 'utf8');
  if (!blockBytes.length) return userBytes;
  if (!userBytes.length) return blockBytes;
  return Buffer.concat([userBytes, Buffer.from(separator, 'utf8'), blockBytes]);
}

function parseArguments(argv) {
  const mode = argv.includes('--clean') ? 'clean' : argv.includes('--smudge') ? 'smudge' : null;
  const stateIndex = argv.indexOf('--state');
  const statePath = stateIndex >= 0 ? argv[stateIndex + 1] : null;
  if (!mode || !statePath) {
    throw new Error('workspace_instruction_git_filter_requires_mode_and_state');
  }
  return { mode, statePath };
}

function readState(statePath) {
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!state || typeof state.block !== 'string' || !state.block.includes(BEGIN.toString('utf8')) || !state.block.includes(END.toString('utf8'))) {
    throw new Error('workspace_instruction_git_filter_invalid_state');
  }
  return {
    block: state.block,
    separator: typeof state.separator === 'string' ? state.separator : '\n\n',
  };
}

async function main() {
  const { mode, statePath } = parseArguments(process.argv.slice(2));
  const state = readState(statePath);
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const input = Buffer.concat(chunks);
  const output = mode === 'clean'
    ? stripManagedInstructionBlocks(input, state.separator)
    : appendCanonicalInstructionBlock(input, state.block, state.separator);
  process.stdout.write(output);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`Vectant instruction Git filter failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  BEGIN,
  END,
  appendCanonicalInstructionBlock,
  parseArguments,
  stripManagedInstructionBlocks,
};
