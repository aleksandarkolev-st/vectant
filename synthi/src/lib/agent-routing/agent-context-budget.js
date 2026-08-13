/**
 * Bounds inter-agent context before it crosses an execution boundary.
 *
 * The newest agent output is normally the most relevant continuation of an
 * atomic task, so truncation deliberately retains the tail rather than the
 * beginning of a growing pipeline transcript.
 */
export const DEFAULT_AGENT_CONTEXT_CHAR_BUDGET = 8_000;

export function limitAgentContext(value, maxChars = DEFAULT_AGENT_CONTEXT_CHAR_BUDGET) {
    const context = String(value || '');
    const budget = Number.isFinite(maxChars)
        ? Math.max(128, Math.floor(maxChars))
        : DEFAULT_AGENT_CONTEXT_CHAR_BUDGET;

    if (context.length <= budget) return context;

    const marker = '[Earlier agent context omitted]\n';
    if (marker.length >= budget) return context.slice(-budget);
    return `${marker}${context.slice(-(budget - marker.length))}`;
}
