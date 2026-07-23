export const jupyterFlags = Object.freeze({
  viewer: () => process.env.NEXT_PUBLIC_JUPYTER_NOTEBOOK_VIEWER !== '0',
  editing: () => process.env.NEXT_PUBLIC_JUPYTER_NOTEBOOK_EDITING === '1',
  execution: () => process.env.NEXT_PUBLIC_JUPYTER_AGENT_EXECUTION === '1',
});
