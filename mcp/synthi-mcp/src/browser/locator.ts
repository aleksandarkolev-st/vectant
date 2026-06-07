import type { BrowserElementMetadata, LocatorCandidate } from "./types.js";

const TEST_ID_CONFIDENCE = 0.99;
const ROLE_CONFIDENCE = 0.96;
const LABEL_CONFIDENCE = 0.94;
const PLACEHOLDER_CONFIDENCE = 0.9;
const TEXT_CONFIDENCE = 0.72;
const SHADOW_CSS_CONFIDENCE = 0.995;
const CSS_CONFIDENCE = 0.58;
const XPATH_CONFIDENCE = 0.35;

export function rankedLocatorCandidates(element: BrowserElementMetadata | undefined): LocatorCandidate[] {
  if (!element) return [];
  const candidates: LocatorCandidate[] = [];

  if (element.shadow_dom === "open" && stableCss(element.shadow_css)) {
    candidates.push({
      kind: "css",
      locator: `page.locator(${quote(element.shadow_css!)})`,
      confidence: SHADOW_CSS_CONFIDENCE,
      reason: "open_shadow_scoped_css",
    });
  }

  if (element.role && element.name) {
    candidates.push({
      kind: "role",
      locator: `page.getByRole(${quote(element.role)}, { name: ${quote(element.name)} })`,
      confidence: ROLE_CONFIDENCE,
      reason: "accessible_role_and_name",
    });
  }

  if (element.label) {
    candidates.push({
      kind: "label",
      locator: `page.getByLabel(${quote(element.label)})`,
      confidence: LABEL_CONFIDENCE,
      reason: "form_label",
    });
  }

  if (element.placeholder) {
    candidates.push({
      kind: "placeholder",
      locator: `page.getByPlaceholder(${quote(element.placeholder)})`,
      confidence: PLACEHOLDER_CONFIDENCE,
      reason: "placeholder_text",
    });
  }

  if (element.test_id) {
    candidates.push({
      kind: "test_id",
      locator: `page.getByTestId(${quote(element.test_id)})`,
      confidence: TEST_ID_CONFIDENCE,
      reason: "test_id",
    });
  }

  if (stableText(element.text)) {
    candidates.push({
      kind: "text",
      locator: `page.getByText(${quote(element.text!.trim())})`,
      confidence: TEXT_CONFIDENCE,
      reason: "stable_visible_text",
    });
  }

  if (stableCss(element.css)) {
    candidates.push({
      kind: "css",
      locator: `page.locator(${quote(element.css!)})`,
      confidence: CSS_CONFIDENCE,
      reason: "stable_css_selector",
    });
  }

  if (element.xpath) {
    candidates.push({
      kind: "xpath",
      locator: `page.locator(${quote(`xpath=${element.xpath}`)})`,
      confidence: XPATH_CONFIDENCE,
      reason: "xpath_last_resort",
    });
  }

  return dedupe(candidates).sort((a, b) => b.confidence - a.confidence);
}

export function bestLocator(element: BrowserElementMetadata | undefined): LocatorCandidate | undefined {
  return rankedLocatorCandidates(element)[0];
}

function stableText(text: string | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (trimmed.length < 1 || trimmed.length > 80) return false;
  if (/^\d+$/.test(trimmed)) return false;
  if (/\s{3,}/.test(trimmed)) return false;
  return true;
}

function stableCss(css: string | undefined): boolean {
  if (!css) return false;
  if (css.includes(":nth-child") || css.includes(":nth-of-type")) return false;
  if (css.length > 180) return false;
  return true;
}

function dedupe(candidates: LocatorCandidate[]): LocatorCandidate[] {
  const seen = new Set<string>();
  const out: LocatorCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.kind}:${candidate.locator}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

function quote(value: string): string {
  return JSON.stringify(value);
}
