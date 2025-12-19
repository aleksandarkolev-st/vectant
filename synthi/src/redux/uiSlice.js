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
    autoSaveEnabled: false,
    autoCompletionEnabled: true,
    uiActionState: initialUiActionState,
    expandedFolders: [],
    // Collaboration presence settings
    showAnonymousPresence: true,
    presenceGranularity: 'line', // options: 'line' | 'file' | 'workspace'
    // Cursor position for status bar
    cursorPosition: { lineNumber: 1, column: 1 },
};

const uiSlice = createSlice({
    name: 'ui',
    initialState: initialUiState,
    reducers: {
        // Layout Reducers
        toggleTerminal: (state) => {
            state.showTerminal = !state.showTerminal;
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
    toggleEmulatorPreview,
    setEmulatorPreviewVisible,
    setTreeOrientation,
    toggleAutoSave,
    toggleAutoCompletion,
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
} = uiSlice.actions;

// Selectors
export const selectShowTerminal = (state) => state.ui.showTerminal;
export const selectShowEmulatorPreview = (state) => state.ui.showEmulatorPreview;
export const selectTreeOnRight = (state) => state.ui.treeOnRight;
export const selectAutoSaveEnabled = (state) => state.ui.autoSaveEnabled;
export const selectAutoCompletionEnabled = (state) => state.ui.autoCompletionEnabled;
export const selectUiActionState = (state) => state.ui.uiActionState;
export const selectExpandedFolders = (state) => state.ui.expandedFolders || [];
export const selectShowAnonymousPresence = (state) => state.ui.showAnonymousPresence;
export const selectPresenceGranularity = (state) => state.ui.presenceGranularity;
export const selectCursorPosition = (state) => state.ui.cursorPosition;

export default uiSlice.reducer;