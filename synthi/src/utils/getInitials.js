/**
 * Returns initials for a display name (e.g. "Jane Doe" → "JD").
 * Falls back to the first 2 characters if the name is a single word,
 * or "?" if the name is empty/undefined.
 *
 * @param {string|undefined} name
 * @returns {string}
 */
export default function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
