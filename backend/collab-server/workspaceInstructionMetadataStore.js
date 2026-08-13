'use strict';

/**
 * Private, workspace-scoped canonical storage for passive instruction
 * projections.  The physical AGENTS.md / CLAUDE.md / GEMINI.md files are
 * intentionally never authoritative: this store is the single source used to
 * rebuild each managed block.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { ATOMIC_AGENT_PROTOCOL } = require('./workspaceAgentProtocol');
const {
  canonicalWorkspaceInstructionsFromMetadata,
} = require('./workspaceInstructionProjectionConfig');

const STORE_VERSION = 1;
const MAX_INSTRUCTION_BYTES = 16 * 1024;

function storeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function normalizeWorkspaceId(workspaceId) {
  const normalized = String(workspaceId || '').trim();
  if (!normalized || /[\\/\0\r\n]/.test(normalized)) {
    throw storeError('workspace_instruction_metadata_invalid_workspace_id');
  }
  return normalized;
}

function filenameForWorkspace(workspaceId) {
  return `${crypto.createHash('sha256').update(normalizeWorkspaceId(workspaceId), 'utf8').digest('hex')}.json`;
}

function normalizeContent(content) {
  if (typeof content !== 'string') {
    throw storeError('workspace_instruction_metadata_content_required');
  }
  if (!content.trim()) {
    throw storeError('workspace_instruction_metadata_content_required');
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_INSTRUCTION_BYTES) {
    throw storeError('workspace_instruction_metadata_content_too_large');
  }
  return content;
}

function normalizeVersion(version) {
  const parsed = Number(version);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw storeError('workspace_instruction_metadata_invalid_version');
  }
  return parsed;
}

async function lstatOrNull(fsApi, target) {
  try {
    return await fsApi.lstat(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureSafeDirectory(fsApi, directory) {
  const current = await lstatOrNull(fsApi, directory);
  if (current) {
    if (current.isSymbolicLink() || !current.isDirectory()) {
      throw storeError('workspace_instruction_metadata_store_directory_unsafe');
    }
    return;
  }
  await fsApi.mkdir(directory, { recursive: true, mode: 0o700 });
  const created = await lstatOrNull(fsApi, directory);
  if (!created || created.isSymbolicLink() || !created.isDirectory()) {
    throw storeError('workspace_instruction_metadata_store_directory_unsafe');
  }
}

async function writeAtomically(fsApi, target, value) {
  const existing = await lstatOrNull(fsApi, target);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw storeError('workspace_instruction_metadata_store_file_unsafe');
  }
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`,
  );
  let handle;
  try {
    handle = await fsApi.open(temporary, 'wx', 0o600);
    await handle.writeFile(value, 'utf8');
    try { await handle.sync(); } catch (_) { /* unsupported filesystem */ }
  } finally {
    if (handle) await handle.close();
  }
  try {
    await fsApi.rename(temporary, target);
  } catch (error) {
    await fsApi.unlink(temporary).catch(() => {});
    throw error;
  }
}

function decodeRecord(raw, workspaceId) {
  if (!raw || typeof raw !== 'object' || raw.schemaVersion !== STORE_VERSION) {
    return null;
  }
  if (raw.workspaceId !== workspaceId) return null;
  try {
    return {
      workspaceId,
      content: normalizeContent(raw.content),
      version: normalizeVersion(raw.version),
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    };
  } catch (_) {
    return null;
  }
}

/**
 * The directory must be Vectant-private and durable (outside the repository
 * checkout).  Callers use `WORKSPACE_INSTRUCTION_METADATA_DIR` to point it at
 * persistent service storage in production.
 */
function createWorkspaceInstructionMetadataStore({
  directory = process.env.WORKSPACE_INSTRUCTION_METADATA_DIR || path.join(__dirname, '.workspace-instruction-metadata'),
  fsApi = fs.promises,
  defaultContent = ATOMIC_AGENT_PROTOCOL,
  clock = () => new Date().toISOString(),
} = {}) {
  const root = path.resolve(String(directory || ''));
  if (!root || root === path.parse(root).root) {
    throw storeError('workspace_instruction_metadata_store_directory_required');
  }

  function recordPath(workspaceId) {
    return path.join(root, filenameForWorkspace(workspaceId));
  }

  async function readRecord(workspaceId) {
    const id = normalizeWorkspaceId(workspaceId);
    const target = recordPath(id);
    const stat = await lstatOrNull(fsApi, target);
    if (!stat) return null;
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw storeError('workspace_instruction_metadata_store_file_unsafe');
    }
    try {
      return decodeRecord(JSON.parse(await fsApi.readFile(target, 'utf8')), id);
    } catch (error) {
      if (error instanceof SyntaxError) return null;
      throw error;
    }
  }

  return Object.freeze({
    directory: root,
    async get(workspaceId) {
      const id = normalizeWorkspaceId(workspaceId);
      const record = await readRecord(id);
      return canonicalWorkspaceInstructionsFromMetadata({
        id,
        workspaceInstructions: record || { content: defaultContent, version: 1 },
      });
    },
    async set(workspaceId, { content, version = null } = {}) {
      const id = normalizeWorkspaceId(workspaceId);
      const nextContent = normalizeContent(content);
      const current = await readRecord(id);
      const nextVersion = version == null
        ? (current && current.content === nextContent ? current.version : (current?.version || 0) + 1)
        : normalizeVersion(version);
      const record = {
        schemaVersion: STORE_VERSION,
        workspaceId: id,
        content: nextContent,
        version: nextVersion,
        updatedAt: clock(),
      };
      await ensureSafeDirectory(fsApi, root);
      await writeAtomically(fsApi, recordPath(id), `${JSON.stringify(record)}\n`);
      return canonicalWorkspaceInstructionsFromMetadata({ id, workspaceInstructions: record });
    },
  });
}

module.exports = {
  MAX_INSTRUCTION_BYTES,
  STORE_VERSION,
  createWorkspaceInstructionMetadataStore,
  filenameForWorkspace,
};
