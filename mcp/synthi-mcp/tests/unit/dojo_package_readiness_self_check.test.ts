// @ts-nocheck
import { describe, expect, it } from "vitest";
import {
  buildDojoPackageReadinessEvidenceManifest,
  collectPackageEntryPaths,
  collectScriptReferencedPackagePaths,
  deriveDojoPackageReadinessRequiredScriptNames,
  DOJO_PACKAGE_READINESS_REQUIRED_FILE_ENTRIES,
  DOJO_PACKAGE_READINESS_REQUIRED_SCRIPT_NAMES,
  extractPackagePathsFromScript,
  isDojoReleaseHarnessScriptName,
  validateDojoPackageReadinessEvidence,
} from "../../scripts/dojo-package-readiness-self-check.mjs";

function packageFixture(overrides = {}) {
  const scripts = {
    build: "tsc",
    typecheck: "tsc --noEmit",
    "proof:dojo:self-check": "node scripts/dojo-proof-self-check.mjs",
    "proof:dojo:package-readiness:self-check": "node scripts/dojo-package-readiness-self-check.mjs",
    "proof:dojo:release-gates:self-check": "node scripts/dojo-release-gate-manifest.mjs --self-check",
    "proof:dojo:release-gates:runner:self-check": "node scripts/dojo-release-gate-runner.mjs --self-check",
    "proof:dojo:release-gates:verify:self-check": "node scripts/dojo-release-gate-verify.mjs --self-check",
    "proof:dojo:mcp-host-conformance:self-check": "node scripts/dojo-mcp-host-conformance.mjs --self-check",
    "live:dojo:mcp-host-conformance": "node scripts/dojo-mcp-host-conformance.mjs --out-dir tmp/live",
    "chaos:dojo:preflight": "node tests/chaos/runner.mjs --require-scenarios",
    "chaos:dojo:live": "node tests/chaos/runner.mjs --kind live --require-scenarios",
    soak: "node tests/soak/soak_loop.mjs",
  };

  return {
    name: "@synthi-inc/mcp-server",
    version: "0.1.0",
    private: false,
    main: "dist/index.js",
    types: "dist/index.d.ts",
    bin: { "synthi-mcp": "dist/index.js" },
    exports: {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
      "./dojo/proof/public-verifier": {
        types: "./dist/dojo/proof/public_verifier.d.ts",
        import: "./dist/dojo/proof/public_verifier.js",
      },
    },
    files: [
      ...DOJO_PACKAGE_READINESS_REQUIRED_FILE_ENTRIES,
      "scripts/dojo-proof-self-check.mjs",
    ],
    scripts,
    ...overrides,
  };
}

function buildEvidence({ packageJson = packageFixture(), packedFiles, packStatus = 0 } = {}) {
  const requiredEntries = collectPackageEntryPaths(packageJson);
  const requiredScriptNames = deriveDojoPackageReadinessRequiredScriptNames(packageJson);
  const scriptEntries = collectScriptReferencedPackagePaths(packageJson.scripts, requiredScriptNames);
  const files = (packedFiles || [
    "package.json",
    "README.md",
    ...requiredEntries,
    ...scriptEntries,
    "scripts/dojo-package-readiness-self-check.mjs",
    "scripts/dojo-release-gate-manifest.mjs",
    "scripts/dojo-release-gate-runner.mjs",
    "scripts/dojo-release-gate-verify.mjs",
    "scripts/dojo-mcp-host-conformance.mjs",
    "tests/chaos/runner.mjs",
    "tests/soak/soak_loop.mjs",
  ]).map((filePath) => ({ path: filePath }));
  return buildDojoPackageReadinessEvidenceManifest({
    now: "2026-06-11T00:00:00.000Z",
    packageJson,
    packageJsonText: JSON.stringify(packageJson),
    packageJsonPath: "package.json",
    packResult: { status: packStatus, signal: null },
    packReport: [{
      filename: "synthi-inc-mcp-server-0.1.0.tgz",
      integrity: "sha512-test",
      unpackedSize: 1234,
      files,
    }],
    packParseError: "",
    packReportPath: "tmp/pack.json",
    stdout: JSON.stringify([{ files }]),
    stderr: "",
    packStdoutPath: "tmp/stdout.log",
    packStderrPath: "tmp/stderr.log",
  });
}

describe("Dojo package readiness self-check", () => {
  it("derives package export entry paths from package metadata", () => {
    expect(collectPackageEntryPaths(packageFixture())).toEqual([
      "dist/dojo/proof/public_verifier.d.ts",
      "dist/dojo/proof/public_verifier.js",
      "dist/index.d.ts",
      "dist/index.js",
    ]);
  });

  it("extracts release harness paths from required package scripts", () => {
    expect(extractPackagePathsFromScript("node tests/chaos/runner.mjs --kind live")).toEqual([
      "tests/chaos/runner.mjs",
    ]);
    expect(collectScriptReferencedPackagePaths(packageFixture().scripts, [
      "proof:dojo:package-readiness:self-check",
      "chaos:dojo:live",
      "soak",
    ])).toEqual([
      "scripts/dojo-package-readiness-self-check.mjs",
      "tests/chaos/runner.mjs",
      "tests/soak/soak_loop.mjs",
    ]);
  });

  it("derives Dojo release harness scripts from package metadata", () => {
    const packageJson = packageFixture({
      scripts: {
        ...packageFixture().scripts,
        "proof:dojo:privacy-redaction:self-check": "node scripts/dojo-privacy-redaction-self-check.mjs",
        "proof:dojo:release-gates:verify": "node scripts/dojo-release-gate-verify.mjs --release-candidate",
        "chaos:dojo:live:list": "node tests/chaos/runner.mjs --list",
        "unrelated:dev": "node scripts/dev-only.mjs",
      },
    });

    expect(isDojoReleaseHarnessScriptName("proof:dojo:privacy-redaction:self-check")).toBe(true);
    expect(isDojoReleaseHarnessScriptName("unrelated:dev")).toBe(false);
    expect(deriveDojoPackageReadinessRequiredScriptNames(packageJson)).toEqual(expect.arrayContaining([
      ...DOJO_PACKAGE_READINESS_REQUIRED_SCRIPT_NAMES,
      "proof:dojo:privacy-redaction:self-check",
      "proof:dojo:release-gates:verify",
      "chaos:dojo:live:list",
    ]));
    expect(deriveDojoPackageReadinessRequiredScriptNames(packageJson)).not.toContain("unrelated:dev");
    expect(collectScriptReferencedPackagePaths(
      packageJson.scripts,
      deriveDojoPackageReadinessRequiredScriptNames(packageJson)
    )).toEqual(expect.arrayContaining([
      "scripts/dojo-privacy-redaction-self-check.mjs",
      "scripts/dojo-release-gate-verify.mjs",
      "tests/chaos/runner.mjs",
    ]));
  });

  it("accepts an evidence manifest when package exports and release harnesses are packed", () => {
    const evidence = buildEvidence();

    expect(evidence.ok).toBe(true);
    expect(validateDojoPackageReadinessEvidence(evidence)).toEqual({ ok: true, errors: [] });
    expect(evidence.required_package_scripts).toEqual(deriveDojoPackageReadinessRequiredScriptNames(packageFixture()));
    expect(evidence.required_package_scripts).toEqual(expect.arrayContaining(DOJO_PACKAGE_READINESS_REQUIRED_SCRIPT_NAMES));
  });

  it("fails closed when a required packed path is missing", () => {
    const packageJson = packageFixture();
    const evidence = buildEvidence({
      packageJson,
      packedFiles: [
        "package.json",
        "README.md",
        "dist/index.js",
        "dist/index.d.ts",
      ],
    });

    expect(evidence.ok).toBe(false);
    expect(evidence.errors).toContain("missing_packed_path:scripts/dojo-package-readiness-self-check.mjs");
    expect(validateDojoPackageReadinessEvidence(evidence).ok).toBe(false);
  });

  it("fails closed when npm pack fails", () => {
    const evidence = buildEvidence({ packStatus: 1 });

    expect(evidence.ok).toBe(false);
    expect(evidence.errors).toContain("npm_pack_exit_code:1");
  });
});
