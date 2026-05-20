function decodeWorkspaceFileText(file) {
  if (!file || typeof file.content !== 'string') return null;
  if (file.encoding !== 'base64') return file.content;

  try {
    if (typeof atob === 'function') return atob(file.content);
  } catch (_) {
    return null;
  }

  return null;
}

export function getWorkspaceDependencyInstallPlan(files) {
  if (!Array.isArray(files)) return null;

  const packageFile = files.find((file) => {
    const normalizedPath = String(file?.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    return normalizedPath.endsWith('package.json');
  });
  if (!packageFile) return null;

  const text = decodeWorkspaceFileText(packageFile);
  if (typeof text !== 'string') return null;

  try {
    const parsed = JSON.parse(text);
    const hasDeps = ['dependencies', 'devDependencies', 'optionalDependencies'].some((key) => {
      const deps = parsed?.[key];
      return deps && typeof deps === 'object' && Object.keys(deps).length > 0;
    });
    if (!hasDeps) return null;

    const normalizedPath = String(packageFile.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const dir = normalizedPath.includes('/')
      ? normalizedPath.slice(0, normalizedPath.lastIndexOf('/'))
      : '';

    return {
      command: dir ? `cd "${dir}" ; npm install` : 'npm install',
      label: 'npm install',
    };
  } catch (_) {
    return null;
  }
}