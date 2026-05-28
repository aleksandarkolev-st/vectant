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
