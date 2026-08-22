/**
 * Visual proof generator: runs the three conformance suites for real and
 * writes an HTML report from their ACTUAL output. No mocked data - if a
 * suite fails, the report shows the failure.
 */
import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const pkgDir = resolve(import.meta.dirname, "..");
const outDir = resolve(pkgDir, "..", "..", ".visual-proof", "embodied-core");
mkdirSync(outDir, { recursive: true });

/** Strip ANSI color codes so vitest output is parseable. */
function stripAnsi(text) {
  return text.replace(
    /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g,
    "",
  );
}

function runSuite(file) {
  try {
    let stdout = execSync(
      `npx vitest run ${file} --reporter=basic 2>&1`,
      { cwd: pkgDir, encoding: "utf8", timeout: 300_000, shell: "bash" },
    );
    stdout = stripAnsi(stdout);
    const testsLine = (stdout.match(/^\s*Tests\s+(.+)$/m)?.[1] ?? "").trim();
    const passed = Number((testsLine.match(/(\d+) passed/) ?? [])[1] ?? 0);
    const failedCount = Number((testsLine.match(/(\d+) failed/) ?? [])[1] ?? 0);
    return { file, passed, total: passed + failedCount, failed: failedCount, raw: stdout };
  } catch (error) {
    const stdout = stripAnsi(String(error.stdout ?? ""));
    const testsLine = (stdout.match(/^\s*Tests\s+(.+)$/m)?.[1] ?? "").trim();
    const passed = Number((testsLine.match(/(\d+) passed/) ?? [])[1] ?? 0);
    const failedCount = Number((testsLine.match(/(\d+) failed/) ?? [])[1] ?? 1);
    return {
      file,
      passed,
      total: passed + failedCount || 1,
      failed: failedCount || 1,
      raw: stdout || String(error),
    };
  }
}

const suites = [
  "tests/unit/embodied_grid_conformance.test.ts",
  "tests/unit/embodied_nn_conformance.test.ts",
  "tests/unit/embodied_kv_conformance.test.ts",
].map(runSuite);

const tscOutput = (() => {
  try {
    execSync("npx tsc --noEmit 2>&1", { cwd: pkgDir, encoding: "utf8", timeout: 300_000, shell: "bash" });
    return { ok: true, raw: "(clean)" };
  } catch (error) {
    return { ok: false, raw: String(error.stdout ?? error) };
  }
})();

const allGreen = tscOutput.ok && suites.every((s) => s.failed === 0 && s.passed > 0);
const generatedAt = new Date().toISOString();

// Deterministic per-seed detail extracted from each world's harness results
// is embedded in the suite output; we surface pass/fail + counts only.
const rows = suites
  .map(
    (s) => `
    <tr class="${s.failed === 0 ? "pass" : "fail"}">
      <td>${s.file.split("/").pop()}</td>
      <td>${s.passed}/${s.total || "?"}</td>
      <td>${s.failed === 0 ? "GREEN" : `FAILED (${s.failed})`}</td>
    </tr>`,
  )
  .join("\n");

const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Embodied Core — Conformance Proof</title>
<style>
 body{background:#101418;color:#e6e6e6;font-family:ui-monospace,Consolas,monospace;margin:2rem;}
 h1{font-size:1.3rem;} .verdict{font-size:1.6rem;padding:.6rem 1rem;border-radius:6px;display:inline-block;}
 .verdict.green{background:#123b23;color:#7ce38b;border:1px solid #1d5c34;}
 .verdict.red{background:#43111a;color:#ff8fa3;border:1px solid #6e2436;}
 table{border-collapse:collapse;margin:1.5rem 0;min-width:60%;}
 td,th{padding:.45rem .9rem;border-bottom:1px solid #2a3138;text-align:left;}
 tr.pass td:nth-child(3){color:#7ce38b;} tr.fail td:nth-child(3){color:#ff8fa3;}
 pre{background:#0a0d10;border:1px solid #232a30;padding:1rem;max-height:340px;overflow:auto;font-size:.72rem;line-height:1.35;}
 .muted{color:#8b949e;font-size:.8rem;}
</style></head><body>
<h1>Universal Embodied Teaching — Phase 0 conformance proof</h1>
<p class="muted">generated ${generatedAt} · all numbers come from live vitest/tsc runs executed by this script · no hardcoded values</p>
<div class="verdict ${allGreen ? "green" : "red"}">${allGreen ? "ALL WORLDS CONFORM" : "FAILURES PRESENT"}</div>
<table><tr><th>suite</th><th>tests</th><th>status</th></tr>${rows}</table>
<p>tsc --noEmit: ${tscOutput.ok ? '<span style="color:#7ce38b">CLEAN</span>' : '<span style="color:#ff8fa3">ERRORS</span>'}</p>
${suites
  .map(
    (s) => `<h3 style="font-size:.9rem">${s.file.split("/").pop()} — raw tail</h3>
<pre>${(s.raw.split("\n").slice(-14).join("\n")).replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</pre>`,
  )
  .join("\n")}
</body></html>`;

const outFile = join(outDir, "conformance-report.html");
writeFileSync(outFile, html);
for (const suite of suites) {
  console.log(`SUITE ${suite.file} passed=${suite.passed} failed=${suite.failed} total=${suite.total}`);
}
console.log(`TSC ok=${tscOutput.ok}`);
console.log(`WROTE ${outFile}`);
console.log(`VERDICT ${allGreen ? "GREEN" : "RED"}`);
