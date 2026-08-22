/**
 * Secret scrubbing for terminal traces (plan P1 acceptance: zero secrets
 * in stored traces, asserted by tests).
 *
 * Patterns cover the common credential shapes; scrubbing is applied to
 * every string that enters a recorded trace. Replacement preserves shape
 * so diffs still make sense.
 */

const SECRET_PATTERNS: Array<{ id: string; regex: RegExp }> = [
  // env-style assignments; negative lookahead so the redaction marker itself
  // can never re-match (self-consistent scrub is a tested invariant)
  { id: "env_assignment", regex: /\b([A-Z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY)[A-Z_]*)\s*=\s*(?!\s*<redacted[ >])(\S+)/gi },
  { id: "aws_access_key", regex: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: "aws_secret", regex: /\b(?<![A-Za-z0-9/+])[A-Za-z0-9/+]{40}(?![A-Za-z0-9/=])\b/g },
  { id: "bearer", regex: /\b[Bb]earer\s+[A-Za-z0-9\-._~+/]+=*/g },
  { id: "github_pat", regex: /\bgh[pousr]_[A-Za-z0-9]{36,251}\b/g },
  { id: "openai_key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { id: "private_key_block", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { id: "url_credentials", regex: /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/g },
];

export interface ScrubReport {
  text: string;
  /** Scrub hits by pattern id. */
  hits: Record<string, number>;
}

export function scrubSecrets(text: string): ScrubReport {
  let out = text;
  const hits: Record<string, number> = {};
  for (const { id, regex } of SECRET_PATTERNS) {
    out = out.replace(regex, (...args) => {
      const match = args[0] as string;
      hits[id] = (hits[id] ?? 0) + 1;
      if (id === "env_assignment") {
        const key = args[1] as string;
        // The marker contains whitespace so the (\S+) value group can never
        // rematch it (a self-consistent scrub is a tested invariant).
        return `${key}=<redacted ${id}>`;
      }
      return `<redacted ${id}>`;
    });
  }
  return { text: out, hits };
}

export function containsSecretShape(text: string): boolean {
  return SECRET_PATTERNS.some(({ regex }) => {
    const probe = new RegExp(regex.source, regex.flags.replace("g", ""));
    return probe.test(text);
  });
}
