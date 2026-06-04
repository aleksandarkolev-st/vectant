export function positiveIntegerFromEnv(env, name, defaultValue) {
  if (!Number.isInteger(defaultValue) || defaultValue < 1) {
    throw new Error(`invalid default for ${name}: expected a positive integer`);
  }
  const raw = env?.[name];
  if (raw === undefined || String(raw).trim() === '') {
    return defaultValue;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

export function booleanFromEnv(env, name, defaultValue = false) {
  if (typeof defaultValue !== 'boolean') {
    throw new Error(`invalid default for ${name}: expected a boolean`);
  }
  const raw = env?.[name];
  if (raw === undefined || String(raw).trim() === '') {
    return defaultValue;
  }
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error(`${name} must be a boolean`);
}
