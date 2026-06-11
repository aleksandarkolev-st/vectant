import collabSessionService from '@/services/collabSessionService';

export const USER_ID_STORAGE_KEY = 'synthi-user-id';

export function hashRuntimeScopePart(value) {
    const text = String(value || 'unknown');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
}

export function scopedRuntimePart(prefix, value) {
    return `${prefix}-${hashRuntimeScopePart(value)}`;
}

function browserStoredUserId() {
    if (typeof window === 'undefined' || !window.localStorage) return null;
    return window.localStorage.getItem(USER_ID_STORAGE_KEY) || null;
}

export function getWorkspaceRuntimeIdentity(slug, { userId = null } = {}) {
    if (!slug) {
        return {
            runtimeScope: '',
            runtimeKind: 'legacy',
            filesystemUserId: userId || browserStoredUserId() || '',
            actorUserId: userId || browserStoredUserId() || '',
        };
    }

    const workspacePart = scopedRuntimePart('ws', slug);
    const collabSessionId = collabSessionService?.isActive ? collabSessionService.sessionId : null;
    if (collabSessionId) {
        const actorUserId = userId || browserStoredUserId() || collabSessionService?.effectiveUserId || 'guest';
        return {
            runtimeScope: `${workspacePart}-collab-${hashRuntimeScopePart(collabSessionId)}`,
            runtimeKind: 'collab',
            filesystemUserId: collabSessionService?.effectiveUserId || actorUserId,
            actorUserId,
            collabSessionId,
        };
    }

    const effectiveUserId =
        userId ||
        collabSessionService?.effectiveUserId ||
        browserStoredUserId() ||
        'guest';
    return {
        runtimeScope: `${workspacePart}-user-${hashRuntimeScopePart(effectiveUserId)}`,
        runtimeKind: 'private',
        filesystemUserId: effectiveUserId,
        actorUserId: effectiveUserId,
    };
}

export function buildWorkspaceRuntimeScope(slug, { userId = null } = {}) {
    return getWorkspaceRuntimeIdentity(slug, { userId }).runtimeScope;
}
