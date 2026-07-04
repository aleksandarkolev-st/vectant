import { proxyAiEngineRequest } from '@/lib/proxyAiEngine';
import { resolveActor } from '@/lib/integrations/session';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RECORD_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const isPlainObject = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const stringOrNull = (value) => (typeof value === 'string' ? value : null);
const finiteNumberOrZero = (value) => (Number.isFinite(value) ? value : 0);

function buildAllowedProvenancePath(segments) {
  if (!segments.length) return null;
  const [head, ...tail] = segments.map((segment) => String(segment));

  if (head === 'stats' && tail.length === 0) return '/provenance/stats';
  if (head === 'file' && tail.length > 0) {
    return `/provenance/file/${tail.map((segment) => encodeURIComponent(segment)).join('/')}`;
  }
  if (tail.length === 0 && RECORD_ID_RE.test(head)) return `/provenance/${encodeURIComponent(head)}`;
  return null;
}

function redactPromptInfo(info) {
  if (!isPlainObject(info)) return null;
  const contextFiles = Array.isArray(info.context_files) ? info.context_files : [];
  return {
    system_prompt_hash: stringOrNull(info.system_prompt_hash),
    user_prompt_hash: stringOrNull(info.user_prompt_hash),
    user_prompt_preview: null,
    context_files: [],
    context_file_count: contextFiles.length,
    context_size_bytes: finiteNumberOrZero(info.context_size_bytes),
    focus_file: stringOrNull(info.focus_file),
  };
}

function redactRecord(record) {
  if (!isPlainObject(record)) return record;
  return {
    ...record,
    prompt_info: redactPromptInfo(record.prompt_info),
    session_id: null,
    user_id: null,
    metadata: null,
  };
}

function redactProvenancePayload(payload) {
  if (Array.isArray(payload)) return payload.map(redactProvenancePayload);
  if (isPlainObject(payload) && typeof payload.record_id === 'string') return redactRecord(payload);
  return payload;
}

async function forward(request, { params }) {
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });

  const data = await params;
  const segments = Array.isArray(data.path) ? data.path : [];
  const path = buildAllowedProvenancePath(segments);
  if (!path) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  return proxyAiEngineRequest(request, path, { transformJson: redactProvenancePayload });
}

export const GET = forward;
export async function POST() {
  return NextResponse.json({ error: 'method_not_allowed' }, { status: 405, headers: { Allow: 'GET' } });
}
