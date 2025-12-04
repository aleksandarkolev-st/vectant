// src/redux/uiSlice.js
import { createSlice } from '@reduxjs/toolkit';

const initialUiActionState = {
    mode: 'none', // 'create-file', 'create-folder', 'rename'
    target: null, // target item for rename/parent for create
    name: '', // current name in the input
};

export const initialUiState = {
    showTerminal: false,
    treeOnRight: false,
    autoSaveEnabled: false,
    autoCompletionEnabled: true,
    uiActionState: initialUiActionState,
    expandedFolders: [],
};

const uiSlice = createSlice({
    name: 'ui',
    initialState: initialUiState,
    reducers: {
        // Layout Reducers
        toggleTerminal: (state) => {
            state.showTerminal = !state.showTerminal;
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
    setTreeOrientation,
    toggleAutoSave,
    toggleAutoCompletion,
    startCreate,
    startRename,
    setUiActionName,
    cancelUiAction,
    hydrateUi,
    toggleFolderExpansion,
    setExpandedFolders,
} = uiSlice.actions;

// Selectors
export const selectShowTerminal = (state) => state.ui.showTerminal;
export const selectTreeOnRight = (state) => state.ui.treeOnRight;
export const selectAutoSaveEnabled = (state) => state.ui.autoSaveEnabled;
export const selectAutoCompletionEnabled = (state) => state.ui.autoCompletionEnabled;
export const selectUiActionState = (state) => state.ui.uiActionState;
export const selectExpandedFolders = (state) => state.ui.expandedFolders || [];

export default uiSlice.reducer;