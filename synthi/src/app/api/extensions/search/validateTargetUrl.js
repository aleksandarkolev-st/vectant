export function isAllowedOpenVsxUrl(value) {
  try {
    const parsed = new URL(value);

    return parsed.protocol === 'https:' && parsed.hostname === 'open-vsx.org';
  } catch {
    return false;
  }
}
