// @ts-nocheck
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDojoPackageReadinessEvidenceManifest,
  collectScriptDependencyGraph,
  collectPackageEntryPaths,
  collectScriptReferencedPackagePaths,
  collectScriptTransitivePackagePaths,
  deriveDojoPackageReadinessRequiredScriptNames,
  DOJO_PACKAGE_READINESS_REQUIRED_FILE_ENTRIES,
  DOJO_PACKAGE_READINESS_REQUIRED_SCRIPT_SELECTORS,
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
    "live:browser:workflow-pipeline": "node scripts/workflow-pipeline-e2e.mjs",
    "live:browser:private-tool-stdio": "node scripts/private-tool-stdio-acceptance.mjs",
    "live:browser:private-tool-codex": "node scripts/private-tool-codex-acceptance.mjs",
    "live:browser:private-tool-host-conformance": "node scripts/private-tool-stdio-acceptance.mjs --require-custom-mcp-command --require-non-loopback-runtime --require-external-private-tool-store",
    "live:browser:private-tool-codex-host-conformance": "node scripts/private-tool-codex-acceptance.mjs --require-custom-mcp-command --require-non-loopback-runtime --require-external-private-tool-store",
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
      "scripts",
      "scripts/dojo-proof-self-check.mjs",
    ],
    scripts,
    ...overrides,
  };
}

function buildEvidence({ packageJson = packageFixture(), packedFiles, packStatus = 0 } = {}) {
  const requiredEntries = collectPackageEntryPaths(packageJson);
  const requiredScriptNames = deriveDojoPackageReadinessRequiredScriptNames(packageJson);
  const scriptEntries = collectScriptTransitivePackagePaths(packageJson.scripts, requiredScriptNames);
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
      "scripts/live-browser-smoke.mjs",
      "scripts/workflow-pipeline-e2e.mjs",
      "scripts/private-tool-acceptance-conformance.mjs",
      "scripts/private-tool-stdio-acceptance.mjs",
      "scripts/private-tool-codex-acceptance.mjs",
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
        "live:browser:custom-host-proof": "node scripts/private-tool-stdio-acceptance.mjs --require-custom-mcp-command",
        "chaos:dojo:live:list": "node tests/chaos/runner.mjs --list",
        "unrelated:dev": "node scripts/dev-only.mjs",
      },
    });

    expect(isDojoReleaseHarnessScriptName("proof:dojo:privacy-redaction:self-check")).toBe(true);
    expect(isDojoReleaseHarnessScriptName("live:browser:custom-host-proof")).toBe(true);
    expect(isDojoReleaseHarnessScriptName("unrelated:dev")).toBe(false);
    expect(deriveDojoPackageReadinessRequiredScriptNames(packageJson)).toEqual(expect.arrayContaining([
      ...DOJO_PACKAGE_READINESS_REQUIRED_SCRIPT_NAMES,
      "proof:dojo:privacy-redaction:self-check",
      "proof:dojo:release-gates:verify",
      "live:browser:custom-host-proof",
      "chaos:dojo:live:list",
    ]));
    expect(deriveDojoPackageReadinessRequiredScriptNames(packageJson)).not.toContain("unrelated:dev");
    expect(collectScriptReferencedPackagePaths(
      packageJson.scripts,
      deriveDojoPackageReadinessRequiredScriptNames(packageJson)
    )).toEqual(expect.arrayContaining([
      "scripts/dojo-privacy-redaction-self-check.mjs",
      "scripts/dojo-release-gate-verify.mjs",
      "scripts/private-tool-stdio-acceptance.mjs",
      "tests/chaos/runner.mjs",
    ]));
  });

  it("recursively requires local helper modules imported by release harness scripts", () => {
    const packageJson = packageFixture({
      scripts: {
        ...packageFixture().scripts,
        "live:browser:private-tool-custom": "node scripts/private-tool-stdio-acceptance.mjs",
      },
    });

    expect(collectScriptTransitivePackagePaths(
      packageJson.scripts,
      deriveDojoPackageReadinessRequiredScriptNames(packageJson)
    )).toEqual(expect.arrayContaining([
      "scripts/private-tool-stdio-acceptance.mjs",
      "scripts/private-tool-acceptance-conformance.mjs",
      "scripts/lib/private-tool-stdio-acceptance-helpers.mjs",
    ]));
  });

  it("fails closed when a package script imports a helper outside the package root", async () => {
    const root = await mkdtemp(join(tmpdir(), "dojo-package-readiness-outside-import-"));
    const packageRoot = join(root, "package");
    const sharedRoot = join(root, "shared");
    await mkdir(join(packageRoot, "scripts"), { recursive: true });
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    await mkdir(sharedRoot, { recursive: true });
    await writeFile(join(packageRoot, "scripts", "main.mjs"), "import '../../shared/helper.mjs';\n", "utf8");
    await writeFile(join(sharedRoot, "helper.mjs"), "export const ok = true;\n", "utf8");
    await writeFile(join(packageRoot, "dist", "index.js"), "export {};\n", "utf8");
    await writeFile(join(packageRoot, "dist", "index.d.ts"), "export {};\n", "utf8");
    await writeFile(join(packageRoot, "README.md"), "fixture\n", "utf8");

    const scripts = {
      "proof:dojo:self-check": "node scripts/main.mjs",
    };
    const packageJson = {
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
      },
      files: ["dist", "scripts/main.mjs", "README.md"],
      scripts,
    };
    const graph = collectScriptDependencyGraph(scripts, ["proof:dojo:self-check"], { rootDir: packageRoot });

    expect(graph.outside_package_script_imports).toEqual([
      "scripts/main.mjs->../../shared/helper.mjs->../shared/helper.mjs",
    ]);

    const evidence = buildDojoPackageReadinessEvidenceManifest({
      now: "2026-06-11T00:00:00.000Z",
      packageJson,
      packageJsonText: JSON.stringify(packageJson),
      packageJsonPath: join(packageRoot, "package.json"),
      packageRoot,
      packResult: { status: 0, signal: null },
      packReport: [{
        filename: "fixture.tgz",
        integrity: "sha512-fixture",
        unpackedSize: 100,
        files: [
          { path: "package.json" },
          { path: "README.md" },
          { path: "dist/index.js" },
          { path: "dist/index.d.ts" },
          { path: "scripts/main.mjs" },
        ],
      }],
      packParseError: "",
      packReportPath: join(root, "pack.json"),
      stdout: "[]",
      stderr: "",
      packStdoutPath: join(root, "stdout.log"),
      packStderrPath: join(root, "stderr.log"),
    });

    expect(evidence.ok).toBe(false);
    expect(evidence.outside_package_script_imports).toEqual(graph.outside_package_script_imports);
    expect(evidence.errors).toContain(
      "outside_package_script_import:scripts/main.mjs->../../shared/helper.mjs->../shared/helper.mjs"
    );
    expect(validateDojoPackageReadinessEvidence(evidence).errors).toEqual(expect.arrayContaining([
      "package_readiness_validation:outside_package_script_import:scripts/main.mjs->../../shared/helper.mjs->../shared/helper.mjs",
    ]));
  });

  it("accepts an evidence manifest when package exports and release harnesses are packed", () => {
    const evidence = buildEvidence();

    expect(evidence.ok).toBe(true);
    expect(validateDojoPackageReadinessEvidence(evidence)).toEqual({ ok: true, errors: [] });
    expect(evidence.required_package_script_selectors).toEqual(DOJO_PACKAGE_READINESS_REQUIRED_SCRIPT_SELECTORS);
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
