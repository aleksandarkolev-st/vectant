import { createSlice } from '@reduxjs/toolkit';

export const initialPortsState = {
  // Forwardable TCP ports detected inside the workspace runtime container
  // (local/worker hybrid path → /wsport|/port proxy).
  containerPorts: [],
  // Ports detected inside the Sysbox per-workspace runtime pod (Slice 4). Tracked
  // separately because they route through the runtime-scoped proxy
  // (/runtime/<scope>/port/<n>/). Only populated when RUNTIME_BACKEND=sysbox-pod is
  // on (the collab server emits `runtime-ports`); empty otherwise.
  runtimePorts: [],
  runtimeScope: null,
};

const portsSlice = createSlice({
  name: 'ports',
  initialState: initialPortsState,
  reducers: {
    setContainerPorts: (state, action) => {
      state.containerPorts = Array.isArray(action.payload) ? action.payload : [];
    },
    clearContainerPorts: (state) => {
      state.containerPorts = [];
    },
    setRuntimePorts: (state, action) => {
      const payload = action.payload || {};
      state.runtimePorts = Array.isArray(payload.ports) ? payload.ports : [];
      state.runtimeScope = payload.runtimeScope || null;
    },
    clearRuntimePorts: (state) => {
      state.runtimePorts = [];
      state.runtimeScope = null;
    },
  },
});

export const {
  setContainerPorts,
  clearContainerPorts,
  setRuntimePorts,
  clearRuntimePorts,
} = portsSlice.actions;
export default portsSlice.reducer;
