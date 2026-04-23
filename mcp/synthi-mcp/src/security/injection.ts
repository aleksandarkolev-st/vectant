/**
 * Injection-heuristic pre-screen. Ultraplan §4.11 proposes a lightweight
 * OCR-driven scan of each frame for canonical prompt-injection phrases.
 * Phase 1 lacks an OCR backend; the fallback is to scan any text arriving
 * via the event log (console events, HMR error messages, log wait-condition
 * matches) for the same patterns. That catches injections that arrive
 * through the build-log DC before we get to OCR.
 *
 * Matches produce `security` events (code: "injection_suspected") with
 * the matched pattern + surrounding context. Phase 1 is detection-only;
 * phase 2 ties it into a sensitive-action interstitial.
 */

export const INJECTION_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "ignore_previous", re: /\b(ignore|disregard)\s+(all\s+)?((the|prior|previous)\s+)?(instructions|system|prompt)/i },
  { label: "system_tag", re: /<\s*(system|\/?\|system\|)\s*>|system:\s*["']?/i },
  { label: "jailbreak_preamble", re: /(you\s+are\s+(now\s+)?(a\s+|the\s+)?(different|new|unfiltered|DAN|developer))/i },
  { label: "new_instructions", re: /new\s+instructions?:|reset\s+(all\s+)?(prior\s+)?instructions/i },
  { label: "chat_role_override", re: /(\|\s*(system|assistant|user)\s*\||<<\s*(system|assistant)\s*>>)/i },
  { label: "pretend_to_be", re: /pretend\s+to\s+be\s+(the\s+)?(admin|root|system|developer)/i },
  { label: "escape_sandbox", re: /(escape|bypass)\s+(the\s+)?(sandbox|restrictions|guardrails)/i },
];

export interface InjectionMatch {
  label: string;
  pattern: string;
  text: string;
  index: number;
}

export function scanForInjection(text: string): InjectionMatch[] {
  const matches: InjectionMatch[] = [];
  for (const p of INJECTION_PATTERNS) {
    const m = p.re.exec(text);
    if (m) {
      matches.push({
        label: p.label,
        pattern: p.re.source,
        text: text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40),
        index: m.index,
      });
    }
  }
  return matches;
}
