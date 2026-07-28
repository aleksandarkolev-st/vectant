export const jupyterFlags = Object.freeze({
  viewer: () => process.env.NEXT_PUBLIC_JUPYTER_NOTEBOOK_VIEWER !== '0',
  // Editing and execution are core notebook capabilities. They are available
  // by default and can be explicitly disabled during a controlled rollout.
  // Execution still requires a registered Jupyter server and user confirmation.
  editing: () => process.env.NEXT_PUBLIC_JUPYTER_NOTEBOOK_EDITING !== '0',
  execution: () => process.env.NEXT_PUBLIC_JUPYTER_AGENT_EXECUTION !== '0',
});
