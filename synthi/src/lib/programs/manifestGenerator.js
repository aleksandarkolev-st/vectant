/**
 * @fileoverview Server-side client for the ai-engine manifest generator. Mirrors
 * aiReviewer: calls the engine directly over HTTP with the internal token. Returns
 * null on any failure (the caller re-validates + surfaces a clear error) — the
 * generated manifest is never trusted until parseProgramManifest re-checks it.
 */

import { withInternalAiAuth } from '@/lib/internalAiAuth';

const AI_ENGINE_BASE = (process.env.CODE_INTEL_URL || process.env.AI_ENGINE_URL || 'http://localhost:8000').replace(/\/$/, '');

async function defaultClient(payload) {
  const res = await fetch(`${AI_ENGINE_BASE}/programs/generate-manifest`, {
    method: 'POST',
    headers: withInternalAiAuth({ 'content-type': 'application/json' }),
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`generate-manifest ${res.status}`);
  return res.json();
}

/** Ask the ai-engine to draft a manifest from workspace files. null on any failure. */
export async function generateManifestFromContext({ files, workspaceName }, { client = defaultClient } = {}) {
  try {
    const raw = await client({ files: files || {}, workspace_name: workspaceName });
    return raw && raw.manifest && typeof raw.manifest === 'object' ? raw.manifest : null;
  } catch {
    return null;
  }
}
