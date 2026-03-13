const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const stripTrailingSlash = (value = '') => value.replace(/\/+$/, '');

const toHttpUrl = (value = '') => value.replace(/^ws/i, 'http');

export function resolveCollabHttpUrl() {
    const configured =
        process.env.NEXT_PUBLIC_COLLAB_SERVER_URL ||
        process.env.NEXT_PUBLIC_COLLAB_URL ||
        process.env.NEXT_PUBLIC_YJS_URL;

    if (configured) {
        return stripTrailingSlash(toHttpUrl(configured));
    }

    if (typeof window !== 'undefined' && window.location) {
        const { protocol, hostname } = window.location;
        const scheme = protocol === 'https:' ? 'https:' : 'http:';
        const resolvedHost = hostname || 'localhost';
        const host = LOCAL_HOSTS.has(resolvedHost) ? 'localhost' : resolvedHost;
        return `${scheme}//${host}:1234`;
    }

    return 'http://localhost:1234';
}
