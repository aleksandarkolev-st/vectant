import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import * as issuerModule from "../../src/visual_capture_provenance_issuer.js";
import {
  VISUAL_CAPTURE_PROVENANCE_REFUSAL_CODE,
  VISUAL_CAPTURE_PROVENANCE_REFUSAL_SCHEMA,
  createVisualCaptureProvenanceIssuerCore,
  type VisualCaptureProvenanceIssuerRefusal,
} from "../../src/visual_capture_provenance_issuer.js";

const sourcePath = join(
  process.cwd(),
  "src",
  "visual_capture_provenance_issuer.ts",
);
const testPath = join(
  process.cwd(),
  "tests",
  "unit",
  "visual_capture_provenance_issuer.test.ts",
);

function refusal(request?: unknown): VisualCaptureProvenanceIssuerRefusal {
  return createVisualCaptureProvenanceIssuerCore(request);
}

describe("visual capture provenance issuer refusal surface", () => {
  it("returns the exact typed refusal schema", () => {
    expect(refusal()).toEqual({
      schemaVersion: VISUAL_CAPTURE_PROVENANCE_REFUSAL_SCHEMA,
      status: "refused",
      reasonCode: VISUAL_CAPTURE_PROVENANCE_REFUSAL_CODE,
      issuerAvailable: false,
      receiptIssuanceAvailable: false,
      receiptConsumptionAvailable: false,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      runtimeAccepted: false,
      dispatchAccepted: false,
      strictLedgerClosed: false,
    });
  });

  it("returns one immutable deterministic value", () => {
    const first = refusal();
    const second = refusal({ arbitrary: "input" });
    expect(first).toBe(second);
    expect(Object.isFrozen(first)).toBe(true);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it.each([
    undefined,
    null,
    false,
    true,
    0,
    1,
    "runtime-capability",
    Symbol("capability"),
    1n,
    {},
    [],
    new Uint8Array([1, 2, 3]),
    () => ({ receiptId: "forged" }),
    Promise.resolve({}),
  ])("refuses every caller-controlled request %#", (request) => {
    expect(refusal(request)).toBe(refusal());
  });

  it("does not inspect caller getters", () => {
    let getterCalls = 0;
    const request = Object.defineProperty({}, "runtimeTupleSource", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        throw new Error("must not execute");
      },
    });
    expect(refusal(request)).toBe(refusal());
    expect(getterCalls).toBe(0);
  });

  it("does not inspect caller proxy traps", () => {
    let trapCalls = 0;
    const request = new Proxy({}, {
      get: () => {
        trapCalls += 1;
        throw new Error("must not execute");
      },
      ownKeys: () => {
        trapCalls += 1;
        throw new Error("must not execute");
      },
      getOwnPropertyDescriptor: () => {
        trapCalls += 1;
        throw new Error("must not execute");
      },
    });
    expect(refusal(request)).toBe(refusal());
    expect(trapCalls).toBe(0);
  });

  it("does not expose executable or opaque authority values", () => {
    const result = refusal() as unknown as Record<string, unknown>;
    expect(Object.values(result).some((value) => typeof value === "function"))
      .toBe(false);
    expect(Reflect.ownKeys(result).some((key) => typeof key === "symbol"))
      .toBe(false);
    expect(result).not.toHaveProperty("receiptId");
    expect(result).not.toHaveProperty("captureId");
    expect(result).not.toHaveProperty("authority");
    expect(result).not.toHaveProperty("token");
    expect(result).not.toHaveProperty("capability");
  });

  it("keeps every acceptance and availability flag false", () => {
    expect(refusal()).toMatchObject({
      issuerAvailable: false,
      receiptIssuanceAvailable: false,
      receiptConsumptionAvailable: false,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      runtimeAccepted: false,
      dispatchAccepted: false,
      strictLedgerClosed: false,
    });
  });

  it("exports only refusal constants and the refusal factory at runtime", () => {
    expect(Object.keys(issuerModule).sort()).toEqual([
      "VISUAL_CAPTURE_PROVENANCE_REFUSAL_CODE",
      "VISUAL_CAPTURE_PROVENANCE_REFUSAL_SCHEMA",
      "createVisualCaptureProvenanceIssuerCore",
    ]);
  });

  it("remains absent from public barrels and package exports", () => {
    const publicIndex = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
    const packageJson = readFileSync(join(process.cwd(), "package.json"), "utf8");
    expect(publicIndex).not.toContain("visual_capture_provenance_issuer");
    expect(packageJson).not.toContain("visual_capture_provenance_issuer");
  });

  it("contains no functional issuer construction or lifecycle implementation", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(source).not.toMatch(/\bclass\b|\bnew\s+[A-Za-z_$]|#[A-Za-z_$]/);
    expect(source).not.toMatch(/\bWeakMap\b|\bWeakSet\b|\bMap\b|\bSet\b/);
    expect(source).not.toMatch(
      /admitRuntimeTuple|issueCaptureLease|captureWithLease|finalizePair|consumeReceipt/,
    );
    expect(source).not.toMatch(
      /CaptureHandle|ReceiptHandle|LeaseState|FrameState|LineageReservation/,
    );
  });

  it("contains no receipt construction, identity, hashing, or byte-copy machinery", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(source).not.toMatch(
      /VisualCapturePairReceipt|VisualCaptureIdentityReceipt|visualIdentity|receiptId|captureId/,
    );
    expect(source).not.toMatch(
      /createHash|randomBytes|sha256Bytes|sha256Text|copyBytes|Uint8Array\.from/,
    );
    expect(source).not.toMatch(/node:crypto|node:util\/types/);
  });

  it("contains no hidden factory, runtime token, or closure injection path", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(source).not.toMatch(/createRuntimeOwned|PrivateVisual|runtimeOwnedIssuer/);
    expect(source).not.toMatch(/runtimeTupleSource|captureClosure|diffClosure/);
    expect(source).not.toMatch(/options|OPTION_KEYS|LIMIT_KEYS/);
    expect(source.match(/\bfunction\s+[A-Za-z_$][\w$]*\s*\(/g)).toEqual([
      "function createVisualCaptureProvenanceIssuerCore(",
    ]);
  });

  it("contains no dynamic evaluation, source loading, or module escape", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(source).not.toMatch(/\beval\s*\(|\bFunction\s*\(|\bimport\s*\(/);
    expect(source).not.toMatch(/data:text|transpile|typescript|node:vm/);
    expect(source).not.toContain(["base", "64"].join(""));
    expect(source).not.toMatch(/readFile|writeFile|require\s*\(|module\.|process\./);
  });

  it("has no test source-rewrite or data-import hook", () => {
    const testSource = readFileSync(testPath, "utf8");
    for (const fragments of [
      ["transpile", "Module"],
      ["privateIssuer", "Source"],
      ["data:", "text/javascript"],
      ["base", "64"],
    ]) {
      expect(testSource).not.toContain(fragments.join(""));
    }
    expect(testSource).not.toMatch(/\bimport\s*\(/);
  });

  it("contains no name-based support selectors or circular strict-proof IDs", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(source).not.toMatch(
      /\b(?:projectName|profileName|apiName|webgpu|directx|vulkan|cuda|rocm|metal)\b/i,
    );
    expect(source).not.toContain("parentStrictProofId");
    expect(source).not.toContain("parentStrictLedgerId");
  });
});
