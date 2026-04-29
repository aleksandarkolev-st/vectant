export function firstChar(s: string | undefined): string {
  // bug: no null/empty guard
  return s[0].toUpperCase();
}
