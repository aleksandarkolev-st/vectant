/**
 * shadowContinuousProducer.js — Synthi Genome bridge (master plan §14)
 *
 * Registers a global fs-change listener and forwards each batch to the
 * ai-engine's /shadow_continuous/notify endpoint. The ai-engine watcher
 * does the 800ms debounce + pass→fail regression replay; this module
 * is just the producer hop.
 *
 * Honours per-process kill-switches:
 *   - SHADOW_CONTINUOUS_ENABLED=0 disables the bridge entirely.
 *   - AI_ENGINE_URL / CODE_INTEL_URL chooses the target.
 *
 * No retries / no queue: continuous shadow is best-effort. A 5xx or
 * connect failure just drops that batch — the next save fires another
 * notify.
 */

'use strict';

const fsWatcher = require('./fsWatcherService');

const AI_ENGINE_BASE =
    process.env.AI_ENGINE_URL ||
    process.env.CODE_INTEL_URL ||
    'http://localhost:8000';

const ENABLED = (process.env.SHADOW_CONTINUOUS_ENABLED ?? '1') !== '0';

const NOTIFY_TIMEOUT_MS = 1500;

// Skip "kind: bulk" overflow batches outright — those represent a
// thousand-event flush (npm install, git checkout) where regression
// replay would either time-out or burn the daily cap. Continuous
// shadow is for human edits, not toolchain noise.
function shouldForward(events) {
    if (!Array.isArray(events) || events.length === 0) return false;
    if (events.length === 1 && events[0]?.kind === 'bulk') return false;
    return true;
}

function pickPaths(events) {
    const paths = [];
    for (const e of events) {
        if (!e || typeof e.path !== 'string') continue;
        if (e.kind === 'bulk') continue;
        // Drop nothing-here events — only forward actual file paths.
        if (!e.path || e.path === '/' || e.path.startsWith('.git/')) continue;
        paths.push(e.path);
    }
    // Cap forwarded paths so we don't ship a 1000-element body when
    // the dedup misses an edge case.
    return paths.slice(0, 32);
}

async function notifyAiEngine(slug, paths) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), NOTIFY_TIMEOUT_MS);
    try {
        await fetch(`${AI_ENGINE_BASE}/shadow_continuous/notify`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ workspace_path: slug, paths }),
            signal: controller.signal,
        });
    } catch (err) {
        // Swallow — best-effort path.
        if (err?.name !== 'AbortError') {
            console.debug('[ShadowContinuous] notify failed:', err.message);
        }
    } finally {
        clearTimeout(timer);
    }
}

let unsubscribe = null;

function start() {
    if (!ENABLED) {
        console.log('[ShadowContinuous] disabled by SHADOW_CONTINUOUS_ENABLED=0');
        return;
    }
    if (unsubscribe) return;
    unsubscribe = fsWatcher.registerChangeListener(({ slug, events }) => {
        if (!slug || !shouldForward(events)) return;
        const paths = pickPaths(events);
        if (paths.length === 0) return;
        // Fire and forget — never block the fs-change pipeline.
        notifyAiEngine(slug, paths).catch(() => {});
    });
    console.log('[ShadowContinuous] producer wired to', AI_ENGINE_BASE);
}

function stop() {
    if (typeof unsubscribe === 'function') {
        unsubscribe();
        unsubscribe = null;
    }
}

module.exports = { start, stop };
