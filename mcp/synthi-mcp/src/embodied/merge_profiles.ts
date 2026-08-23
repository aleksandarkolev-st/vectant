/**
 * Lane0 event-window reduction, generalized (plan Architecture Changes):
 * "lane0 reduction generalizes to embodied event windows with
 * per-substrate merge profiles - tick merging for games, line/command
 * merging for terminals; browser profile remains byte-compatible."
 *
 * A merge profile decides WHICH adjacent events collapse into one window:
 * - tick profile (games): events at the same world tick merge;
 * - command profile (terminals): consecutive outputs for the same command
 *   merge into that command's window;
 * - none: every event is its own window.
 *
 * Pure functions; the core has no substrate names - profiles are supplied.
 */

export interface RawEvent {
  seq: number;
  /** Substrate-defined grouping key (tick number / command id / ...). */
  group?: string | number;
  payload: unknown;
}

export interface EventWindow {
  start_seq: number;
  end_seq: number;
  events: RawEvent[];
  merged: boolean;
}

export interface MergeProfile {
  id: string;
  /** Return a merge key, or null to keep the event standalone. */
  keyOf(event: RawEvent, previous: RawEvent | null): string | number | null;
}

/** Every event standalone (browser byte-compatible default). */
export const noMergeProfile: MergeProfile = {
  id: "none",
  keyOf: () => null,
};

/** Merge events sharing the same group key (e.g. game ticks). */
export const groupMergeProfile: MergeProfile = {
  id: "group",
  keyOf: (event) => event.group ?? null,
};

/**
 * Command merging: an output event (no group) merges FORWARD into the
 * preceding command's window; commands themselves always open windows.
 */
export const commandMergeProfile: MergeProfile = {
  id: "command",
  // An output line (no own group) inherits the previous event's group so it
  // folds into the preceding command's window. Commands (with a group) keep
  // their own key, which opens the window.
  keyOf: (event, previous) => event.group ?? previous?.group ?? null,
};

export function reduceToWindows(
  events: readonly RawEvent[],
  profile: MergeProfile,
): EventWindow[] {
  const windows: EventWindow[] = [];
  let previous: RawEvent | null = null;
  let openKey: string | number | null = null;
  let openKeyClosed = false;

  for (const event of events) {
    // Inheriting profiles (e.g. command merging) resolve the key against
    // the OPEN WINDOW's key when the event has none of its own: an
    // unbroken run of output lines all belongs to the command that opened
    // the window. A null resolved key closes the window.
    const inherited = openKey !== null && !openKeyClosed ? openKey : null;
    const key = profile.keyOf(event, previous) ?? inherited;
    const canMerge =
      key !== null &&
      !openKeyClosed &&
      String(key) === String(openKey) &&
      windows.length > 0;

    if (canMerge) {
      const current = windows[windows.length - 1]!;
      current.events.push(event);
      current.end_seq = event.seq;
      current.merged = true;
    } else {
      windows.push({
        start_seq: event.seq,
        end_seq: event.seq,
        events: [event],
        merged: false,
      });
      openKey = key;
      openKeyClosed = key === null;
    }
    previous = event;
  }

  return windows;
}
