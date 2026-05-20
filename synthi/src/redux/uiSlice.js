// src/redux/uiSlice.js
import { createSlice } from '@reduxjs/toolkit';

const initialUiActionState = {
    mode: 'none', // 'create-file', 'create-folder', 'rename'
    target: null, // target item for rename/parent for create
    name: '', // current name in the input
};

export const initialUiState = {
    showTerminal: false,
    showEmulatorPreview: false,
    treeOnRight: false,
    autoSaveEnabled: true,
    autoCompletionEnabled: true,
    gpuModeEnabled: true,
    // ULTRAPLAN Phase 8: Bring Your Own Runner mode. When true, the
    // next AI split preserves any existing host_runner.cpp on disk
    // that starts with the `// SYNTHI_USER_RUNNER` sentinel instead
    // of regenerating the runner. See HMR_AGNOSTIC_ULTRAPLAN.md §5.2
    // (Mitigation 2B). Default OFF — only opt-in power users need it.
    bringYourOwnRunnerEnabled: false,
    uiActionState: initialUiActionState,
    expandedFolders: [],
    // Collaboration presence settings
    showAnonymousPresence: true,
    presenceGranularity: 'line', // options: 'line' | 'file' | 'workspace'
    // Cursor position for status bar
    cursorPosition: { lineNumber: 1, column: 1 },
    // ── Sidebar auto-collapse ────────────────────────────────────────
    // When the cursor leaves a sidebar tab group for `delay` ms, the
    // group collapses to a 0-width slot. Hover re-expands. This is a
    // pure UI affordance — the underlying docking-wm layout is not
    // mutated, so the group's size is restored when the user returns.
    sidebarAutoCollapseEnabled: true,
    sidebarAutoCollapseDelay: 2500,
    // Panel types pinned open against auto-collapse. Indexed by panelType
    // (e.g. 'chat', 'explorer'). When a sidebar group's active tab is in
    // this set, the auto-collapse hook leaves the group expanded.
    pinnedSidebarPanelTypes: [],
};

const uiSlice = createSlice({
    name: 'ui',
    initialState: initialUiState,
    reducers: {
        // Layout Reducers
        toggleTerminal: (state) => {
            state.showTerminal = !state.showTerminal;
        },
        setShowTerminal: (state, action) => {
            state.showTerminal = !!action.payload;
        },
        toggleEmulatorPreview: (state) => {
            state.showEmulatorPreview = !state.showEmulatorPreview;
        },
        setEmulatorPreviewVisible: (state, action) => {
            state.showEmulatorPreview = !!action.payload;
        },
        setTreeOrientation: (state) => {
            state.treeOnRight = !state.treeOnRight;
        },
        toggleAutoSave: (state) => {
            state.autoSaveEnabled = !state.autoSaveEnabled;
        },
        toggleAutoCompletion: (state) => {
            state.autoCompletionEnabled = !state.autoCompletionEnabled;
        },
        setGpuModeEnabled: (state, action) => {
            state.gpuModeEnabled = !!action.payload;
        },
        toggleGpuMode: (state) => {
            state.gpuModeEnabled = !state.gpuModeEnabled;
        },
        // ULTRAPLAN Phase 8
        toggleBringYourOwnRunner: (state) => {
            state.bringYourOwnRunnerEnabled = !state.bringYourOwnRunnerEnabled;
        },
        toggleFolderExpansion: (state, action) => {
            const path = action.payload;
            if (!state.expandedFolders) state.expandedFolders = [];
            if (state.expandedFolders.includes(path)) {
                state.expandedFolders = state.expandedFolders.filter(p => p !== path);
            } else {
                state.expandedFolders.push(path);
            }
        },
        setExpandedFolders: (state, action) => {
            state.expandedFolders = action.payload;
        },
        hydrateUi: (state, action) => {
            return { ...state, ...action.payload };
        },
        toggleShowAnonymousPresence: (state) => {
            state.showAnonymousPresence = !state.showAnonymousPresence;
        },
        setPresenceGranularity: (state, action) => {
            state.presenceGranularity = action.payload;
        },
        setCursorPosition: (state, action) => {
            state.cursorPosition = action.payload;
        },
        toggleSidebarAutoCollapse: (state) => {
            state.sidebarAutoCollapseEnabled = !state.sidebarAutoCollapseEnabled;
        },
        setSidebarAutoCollapseDelay: (state, action) => {
            const v = Number(action.payload);
            if (Number.isFinite(v) && v >= 500 && v <= 10000) {
                state.sidebarAutoCollapseDelay = v;
            }
        },
        toggleSidebarPanelPin: (state, action) => {
            const panelType = action.payload;
            if (!panelType) return;
            if (!Array.isArray(state.pinnedSidebarPanelTypes)) {
                state.pinnedSidebarPanelTypes = [];
            }
            const idx = state.pinnedSidebarPanelTypes.indexOf(panelType);
            if (idx === -1) {
                state.pinnedSidebarPanelTypes.push(panelType);
            } else {
                state.pinnedSidebarPanelTypes.splice(idx, 1);
            }
        },
        setSidebarPanelPinned: (state, action) => {
            const { panelType, pinned } = action.payload || {};
            if (!panelType) return;
            if (!Array.isArray(state.pinnedSidebarPanelTypes)) {
                state.pinnedSidebarPanelTypes = [];
            }
            const idx = state.pinnedSidebarPanelTypes.indexOf(panelType);
            if (pinned && idx === -1) {
                state.pinnedSidebarPanelTypes.push(panelType);
            } else if (!pinned && idx !== -1) {
                state.pinnedSidebarPanelTypes.splice(idx, 1);
            }
        },
        
        // UI Action State Machine Reducers
        startCreate: (state, action) => {
            const { type, target } = action.payload; // type: 'file' or 'folder'
            state.uiActionState = {
                mode: `create-${type}`,
                target: target,
                name: '',
            };
        },
        startRename: (state, action) => {
            const target = action.payload;
            state.uiActionState = {
                mode: 'rename',
                target: target,
                name: target.name,
            };
        },
        setUiActionName: (state, action) => {
            state.uiActionState.name = action.payload;
        },
        cancelUiAction: (state) => {
            state.uiActionState = initialUiActionState;
        },
    },
});

export const {
    toggleTerminal,
    setShowTerminal,
    toggleEmulatorPreview,
    setEmulatorPreviewVisible,
    setTreeOrientation,
    toggleAutoSave,
    toggleAutoCompletion,
    setGpuModeEnabled,
    toggleGpuMode,
    toggleBringYourOwnRunner,
    startCreate,
    startRename,
    setUiActionName,
    cancelUiAction,
    toggleShowAnonymousPresence,
    setPresenceGranularity,
    setCursorPosition,
    hydrateUi,
    toggleFolderExpansion,
    setExpandedFolders,
    toggleSidebarAutoCollapse,
    setSidebarAutoCollapseDelay,
    toggleSidebarPanelPin,
    setSidebarPanelPinned,
} = uiSlice.actions;

// Selectors
export const selectShowTerminal = (state) => state.ui.showTerminal;
export const selectShowEmulatorPreview = (state) => state.ui.showEmulatorPreview;
export const selectTreeOnRight = (state) => state.ui.treeOnRight;
export const selectAutoSaveEnabled = (state) => state.ui.autoSaveEnabled;
export const selectAutoCompletionEnabled = (state) => state.ui.autoCompletionEnabled;
export const selectGpuModeEnabled = (state) => state.ui.gpuModeEnabled !== false;
export const selectBringYourOwnRunnerEnabled = (state) => state.ui.bringYourOwnRunnerEnabled;
export const selectUiActionState = (state) => state.ui.uiActionState;
export const selectExpandedFolders = (state) => state.ui.expandedFolders || [];
export const selectShowAnonymousPresence = (state) => state.ui.showAnonymousPresence;
export const selectPresenceGranularity = (state) => state.ui.presenceGranularity;
export const selectCursorPosition = (state) => state.ui.cursorPosition;
export const selectSidebarAutoCollapseEnabled = (state) => state.ui.sidebarAutoCollapseEnabled ?? true;
export const selectSidebarAutoCollapseDelay = (state) => state.ui.sidebarAutoCollapseDelay ?? 2500;
export const selectPinnedSidebarPanelTypes = (state) => state.ui.pinnedSidebarPanelTypes ?? [];
export const selectIsSidebarPanelPinned = (panelType) => (state) =>
    (state.ui.pinnedSidebarPanelTypes ?? []).includes(panelType);

export default uiSlice.reducer;
