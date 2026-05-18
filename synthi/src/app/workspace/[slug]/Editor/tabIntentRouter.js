export const TAB_INTENT_OWNER = Object.freeze({
    NEP: 'nep',
    DIAGNOSTIC_FIX: 'diagnostic-fix',
    AI_COMPLETION: 'ai-completion',
    EDITOR: 'editor',
});

export const TAB_INTENT_EVENT = 'synthi:tab-intent-state';

const NEP_TAB_STATES = new Set(['armed', 'armed-current', 'armed-confirm']);

const DEFAULT_TAB_INTENT_STATE = Object.freeze({
    nepState: 'idle',
    hasDiagnosticFix: false,
    aiCompletionState: 'idle',
    hasAiSuggestion: false,
});

let tabIntentState = { ...DEFAULT_TAB_INTENT_STATE };

const cleanPatch = (patch) => {
    const clean = {};
    for (const [key, value] of Object.entries(patch || {})) {
        if (value !== undefined) clean[key] = value;
    }
    return clean;
};

const publishTabIntentState = () => {
    if (typeof window === 'undefined') return;
    const detail = getTabIntentState();
    window.__synthiTabIntentState = detail;
    try {
        window.dispatchEvent(new CustomEvent(TAB_INTENT_EVENT, { detail }));
    } catch (_) {
        // Debug-only signal; browsers without CustomEvent support can ignore it.
    }
};

export const getTabIntentState = () => ({ ...tabIntentState });

export const resetTabIntentState = () => {
    tabIntentState = { ...DEFAULT_TAB_INTENT_STATE };
    publishTabIntentState();
    return getTabIntentState();
};

export const updateTabIntentState = (patch = {}) => {
    tabIntentState = {
        ...tabIntentState,
        ...cleanPatch(patch),
    };
    publishTabIntentState();
    return getTabIntentState();
};

export const isNepTabState = (nepState) => NEP_TAB_STATES.has(nepState);

export const resolveTabIntentOwner = (override = {}) => {
    const state = {
        ...tabIntentState,
        ...cleanPatch(override),
    };

    if (isNepTabState(state.nepState)) return TAB_INTENT_OWNER.NEP;
    if (state.aiCompletionState === 'ready' && state.hasAiSuggestion) {
        return TAB_INTENT_OWNER.AI_COMPLETION;
    }
    if (state.hasDiagnosticFix) return TAB_INTENT_OWNER.DIAGNOSTIC_FIX;
    return TAB_INTENT_OWNER.EDITOR;
};

export const canHandleTabIntent = (owner, override = {}) => (
    resolveTabIntentOwner(override) === owner
);
