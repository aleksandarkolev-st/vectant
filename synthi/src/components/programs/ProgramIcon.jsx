'use client';

import { PROGRAM_LOGOS } from './programLogos';

// The lookup key is the slug after the publisher, e.g. "@vectant/dbeaver" → "dbeaver".
function logoKey(packageId) {
  return String(packageId || '').split('/').pop();
}
function shortName(packageId) {
  return logoKey(packageId).split(':').pop() || 'program';
}
// Deterministic hue so a given community program always gets the same monogram colour.
function hueFor(str) {
  let h = 0;
  for (let i = 0; i < str.length; i += 1) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

export default function ProgramIcon({ packageId, size = 32, radius = 9 }) {
  const key = logoKey(packageId);
  const logo = PROGRAM_LOGOS[key];
  const box = { width: `${size}px`, height: `${size}px`, borderRadius: `${radius}px` };

  if (logo) {
    return (
      <span
        data-testid={`program-logo-${key}`}
        className="flex items-center justify-center shrink-0"
        style={{ ...box, background: 'var(--bg-elevated)' }}
      >
        <svg viewBox="0 0 24 24" width={Math.round(size * 0.56)} height={Math.round(size * 0.56)} fill={logo.color} aria-hidden="true">
          <path d={logo.path} />
        </svg>
      </span>
    );
  }

  const name = shortName(packageId);
  const hue = hueFor(name);
  return (
    <span
      data-testid="program-logo-monogram"
      className="flex items-center justify-center shrink-0"
      style={{ ...box, background: `hsl(${hue} 42% 20%)`, color: `hsl(${hue} 70% 76%)`, fontSize: `${Math.round(size * 0.42)}px`, fontWeight: 600 }}
    >
      {name.charAt(0).toUpperCase()}
    </span>
  );
}
