// Mobile runtime state primitives. Local standby mode uses these until a
// worker-backed stream takes over.

export const EMULATOR_STATES = Object.freeze({
  OFF: 'OFF',
  BOOTING: 'BOOTING',
  IDLE: 'IDLE',
  NO_APP: 'NO_APP',
  STREAMING: 'STREAMING',
  ERROR: 'ERROR',
});

export function isValidEmulatorState(state) {
  return Object.values(EMULATOR_STATES).includes(state);
}

export function getInitialEmulatorState() {
  return EMULATOR_STATES.OFF;
}

/**
 * Power button rules (per spec):
 * - OFF -> BOOTING
 * - IDLE -> OFF
 * - BOOTING -> (no direct transition; it completes via timeout)
 */
export function nextStateOnPower(current) {
  switch (current) {
    case EMULATOR_STATES.OFF:
      return EMULATOR_STATES.BOOTING;
    case EMULATOR_STATES.IDLE:
      return EMULATOR_STATES.OFF;
    default:
      return current;
  }
}

export function nextStateOnHome(current) {
  if (current === EMULATOR_STATES.OFF) return current;
  return EMULATOR_STATES.IDLE;
}
