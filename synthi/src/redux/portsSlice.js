import { createSlice } from '@reduxjs/toolkit';

export const initialPortsState = {
  // Forwardable TCP ports detected inside the workspace runtime container.
  containerPorts: [],
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
  },
});

export const { setContainerPorts, clearContainerPorts } = portsSlice.actions;
export default portsSlice.reducer;
