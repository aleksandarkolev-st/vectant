const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const stripTrailingSlash = (value = '') => value.replace(/\/+$/, '');

const toHttpUrl = (value = '') => value.replace(/^ws/i, 'http');
const toWsUrl = (value = '') => value.replace(/^http/i, 'ws');

export function resolveCollabHttpUrl() {
    const configured =
        process.env.NEXT_PUBLIC_COLLAB_SERVER_URL ||
        process.env.NEXT_PUBLIC_COLLAB_URL ||
        process.env.NEXT_PUBLIC_YJS_URL;

    if (configured) {
        return stripTrailingSlash(toHttpUrl(configured));
    }

    if (typeof window !== 'undefined' && window.location) {
        const { origin, hostname } = window.location;
        if (!LOCAL_HOSTS.has(hostname || '')) {
            return `${stripTrailingSlash(origin)}/collab`;
        }
    }

    return 'http://localhost:1234';
}

export function resolveCollabWsUrl() {
    return toWsUrl(resolveCollabHttpUrl());
}
