import { NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import jwt from 'jsonwebtoken';
import { requireRuntimeWorkspaceAccess } from '@/lib/workspaceAccess';

function hashRuntimeScopePart(value) {
  const text = String(value || 'unknown');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function scopedRuntimePart(prefix, value) {
  return `${prefix}-${hashRuntimeScopePart(value)}`;
}

function normalizeScopes(value) {
  const raw = Array.isArray(value) ? value.join(',') : String(value || '');
  const scopes = raw
    .split(/[,\s]+/)
    .map((scope) => scope.trim())
    .filter(Boolean);
  return scopes.length ? [...new Set(scopes)] : ['collab:terminal'];
}

function runtimeIdentityFor({ workspaceSlug, workspaceUserId, collabSessionId }) {
  const workspacePart = scopedRuntimePart('ws', workspaceSlug);
  if (collabSessionId) {
    return {
      runtimeScope: `${workspacePart}-collab-${hashRuntimeScopePart(collabSessionId)}`,
      filesystemUserId: scopedRuntimePart('collab', collabSessionId),
      collabSessionId,
    };
  }
  return {
    runtimeScope: `${workspacePart}-user-${hashRuntimeScopePart(workspaceUserId)}`,
    filesystemUserId: workspaceUserId,
    collabSessionId: null,
  };
}

export async function GET(req) {
  try {
    const authSecret = process.env.AUTH_SECRET || process.env.NEXTAUTH_SECRET;
    if (!authSecret) {
      return NextResponse.json({ error: 'Auth secret is not configured' }, { status: 500 });
    }
    const token = await getToken({ req, secret: authSecret });
    if (!token) return NextResponse.json({ error: 'Not authenticated' }, { status: 401 });

    const subject = token.userId || token.sub || token.email || token.name || 'authenticated-user';
    const url = new URL(req.url);
    const workspaceSlug = String(url.searchParams.get('workspaceSlug') || url.searchParams.get('workspace') || '').trim();
    const scopes = normalizeScopes(url.searchParams.get('scopes') || url.searchParams.get('scope'));

    if (workspaceSlug) {
      const access = await requireRuntimeWorkspaceAccess(workspaceSlug);
      if (!access.ok) {
        return NextResponse.json({ error: access.error }, { status: access.status });
      }
      const workspaceUserId = access.session?.user?.id || access.email || String(subject);
      const collabSessionId = String(url.searchParams.get('collabSessionId') || '').trim();
      const runtimeIdentity = runtimeIdentityFor({ workspaceSlug, workspaceUserId, collabSessionId });
      const signed = jwt.sign(
        {
          sub: String(subject),
          typ: 'collab-gateway',
          workspaceSlug,
          scopes,
          actorUserId: String(subject),
          workspaceUserId: String(workspaceUserId),
          filesystemUserId: runtimeIdentity.filesystemUserId,
          runtimeScope: runtimeIdentity.runtimeScope,
          ...(runtimeIdentity.collabSessionId ? { collabSessionId: runtimeIdentity.collabSessionId } : {}),
        },
        authSecret,
        { expiresIn: '5m', audience: 'synthi-gateway' }
      );
      return NextResponse.json({
        token: signed,
        expiresIn: 300,
        workspaceSlug,
        scopes,
        runtimeScope: runtimeIdentity.runtimeScope,
        filesystemUserId: runtimeIdentity.filesystemUserId,
      });
    }

    const signed = jwt.sign(
      { sub: String(subject), typ: 'gateway' },
      authSecret,
      { expiresIn: '15m', audience: 'synthi-gateway' }
    );
    return NextResponse.json({ token: signed });
  } catch (e) {
    console.error('Failed to create signed token', e?.message || e);
    return NextResponse.json({ error: 'Failed to create token' }, { status: 500 });
  }
}
