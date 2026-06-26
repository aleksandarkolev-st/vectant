#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SYNTHI_ROOT = path.resolve(__dirname, "..");
const OUT_DIR = path.resolve(process.argv.includes("--out-dir")
  ? process.argv[process.argv.indexOf("--out-dir") + 1]
  : path.join(SYNTHI_ROOT, "tmp", "shadow-card-visual-proof"));

const VIEWPORTS = [
  { name: "desktop", width: 1120, height: 760 },
  { name: "mobile", width: 390, height: 760 },
];

const REQUIRED_TEXT = [
  "Verify panel",
  "Learned from this run:",
  "Visual proof passed",
  "hash abcdef123456",
  "artifact artifacts/shadow/A-desktop.png",
  "Policy hint active:",
  "Arbiter picks Universe A",
];

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const results = [];
    for (const viewport of VIEWPORTS) {
      results.push(await capture(browser, viewport));
    }
    const report = {
      schema_version: "vectant.shadowCard.visualProof.v1",
      generated_at: new Date().toISOString(),
      ok: results.every((result) => result.ok),
      screenshot_count: results.length,
      screenshots: results.map((result) => result.screenshot_path),
      results,
    };
    const reportPath = path.join(OUT_DIR, "visual-proof.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(JSON.stringify({ ok: report.ok, report_path: reportPath, screenshots: report.screenshots }, null, 2));
    if (!report.ok) process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

async function capture(browser, viewport) {
  const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
  try {
    await page.setContent(buildHtml(), { waitUntil: "load" });
    const root = page.locator("[data-testid='shadow-visual-proof-fixture']");
    await root.waitFor({ timeout: 5000 });
    const text = await root.innerText();
    const checks = Object.fromEntries(REQUIRED_TEXT.map((item) => [`text:${item}`, text.includes(item)]));
    const layout = await page.evaluate(() => {
      const rootNode = document.querySelector("[data-testid='shadow-visual-proof-fixture']");
      const proofNode = document.querySelector("[data-testid='visual-proof-A']");
      const rootRect = rootNode.getBoundingClientRect();
      const proofRect = proofNode.getBoundingClientRect();
      return {
        root_width: Math.round(rootRect.width),
        root_height: Math.round(rootRect.height),
        proof_width: Math.round(proofRect.width),
        proof_height: Math.round(proofRect.height),
        body_scroll_width: document.documentElement.scrollWidth,
        viewport_width: window.innerWidth,
        overflowing: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    });
    const screenshotPath = path.join(OUT_DIR, `shadow-card-${viewport.name}.png`);
    await root.screenshot({ path: screenshotPath });
    const bytes = (await stat(screenshotPath)).size;
    const screenshotSha256 = await sha256File(screenshotPath);
    const dimensions = await pngDimensions(screenshotPath);
    const failed_visual_gates = [
      ...Object.entries(checks).filter(([, ok]) => !ok).map(([key]) => key),
      ...(bytes > 4000 ? [] : ["screenshot_too_small"]),
      ...(dimensions.width >= 300 && dimensions.height >= 220 ? [] : ["screenshot_dimensions_too_small"]),
      ...(layout.overflowing ? ["horizontal_overflow"] : []),
      ...(layout.proof_height > 20 ? [] : ["visual_proof_not_visible"]),
    ];
    return {
      viewport: viewport.name,
      ok: failed_visual_gates.length === 0,
      checks,
      failed_visual_gates,
      layout,
      dimensions,
      screenshot_path: screenshotPath,
      screenshot_sha256: screenshotSha256,
      bytes,
    };
  } finally {
    await page.close();
  }
}

function buildHtml() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    :root {
      --bg: oklch(16% 0.008 255);
      --panel: oklch(20% 0.011 255);
      --elevated: oklch(25% 0.012 255);
      --border: oklch(38% 0.018 255);
      --text: oklch(91% 0.012 255);
      --muted: oklch(68% 0.018 255);
      --purple: oklch(69% 0.13 296);
      --green: oklch(73% 0.12 146);
      --warning: oklch(78% 0.12 82);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      padding: 24px;
    }
    .genome-card {
      max-width: 840px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
      padding: 12px;
    }
    .genome-card__head,
    .genome-universe__head,
    .genome-universe__actions {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 8px;
    }
    .genome-card__head { justify-content: space-between; margin-bottom: 10px; }
    .genome-card__tier,
    .genome-universe__style,
    .genome-universe__status,
    .genome-arbiter__source {
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px 7px;
      font-size: 11px;
      color: var(--muted);
    }
    .genome-card__learned,
    .genome-card__policy,
    .genome-universe,
    .genome-arbiter {
      border: 1px solid var(--border);
      border-radius: 8px;
      background: color-mix(in srgb, var(--elevated) 64%, transparent);
      padding: 10px;
      margin-top: 8px;
    }
    .genome-card__learned { border-color: color-mix(in srgb, var(--purple) 42%, var(--border)); }
    .genome-card__policy { color: var(--muted); font-size: 12px; }
    .genome-universe__id { font-weight: 700; }
    .genome-universe__model,
    .genome-universe__evidence,
    .genome-universe__visual,
    .genome-arbiter__rationale { color: var(--muted); font-size: 12px; }
    .genome-universe__evidence,
    .genome-universe__visual {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 10px;
      margin-top: 8px;
    }
    .genome-universe__visual {
      border: 1px solid color-mix(in srgb, var(--green) 42%, var(--border));
      border-radius: 8px;
      padding: 7px 9px;
    }
    .genome-universe__visual-title,
    .genome-universe__review {
      display: inline-flex;
      align-items: center;
      gap: 5px;
    }
    button {
      border: 1px solid var(--border);
      border-radius: 7px;
      background: var(--elevated);
      color: var(--text);
      min-height: 30px;
      padding: 0 10px;
      font: inherit;
      font-size: 12px;
    }
    .genome-universe__review--done { border-color: color-mix(in srgb, var(--purple) 45%, var(--border)); }
    .genome-arbiter__head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
    @media (max-width: 520px) {
      body { padding: 10px; }
      .genome-card { padding: 10px; }
      .genome-card__head { align-items: flex-start; }
    }
  </style>
</head>
<body>
  <main class="genome-card" data-testid="shadow-visual-proof-fixture">
    <header class="genome-card__head">
      <span>Verify panel</span>
      <span class="genome-card__tier">tier: standard</span>
    </header>
    <div class="genome-card__learned"><strong>Learned from this run:</strong> Selector preferred smaller branch over Arbiter recommendation.</div>
    <div class="genome-card__policy">Policy hint active: lower size tolerance unless proof delta is large</div>
    <section class="genome-universe">
      <div class="genome-universe__head">
        <span class="genome-universe__id">Universe A</span>
        <span class="genome-universe__model">gpt -> claude critic</span>
        <span class="genome-universe__style">safe</span>
        <span class="genome-universe__status">verified</span>
      </div>
      <div class="genome-universe__evidence">
        <span>lint: clean</span>
        <span>types: clean</span>
        <span>tests: 1/1 passed</span>
        <span>runtime: clean</span>
        <span>attacks 0/0 survived</span>
        <span>LOC +1 -0</span>
        <span>score 1</span>
      </div>
      <div class="genome-universe__visual genome-universe__visual--passed" data-testid="visual-proof-A">
        <span class="genome-universe__visual-title">Visual proof passed</span>
        <span>hash abcdef123456</span>
        <span>viewport desktop</span>
        <span>artifact artifacts/shadow/A-desktop.png</span>
      </div>
      <div class="genome-universe__actions">
        <button class="genome-universe__review genome-universe__review--done">Reviewed</button>
        <button>Apply</button>
      </div>
    </section>
    <section class="genome-arbiter">
      <div class="genome-arbiter__head">
        <span>Arbiter picks Universe A</span>
        <span class="genome-arbiter__source">proof-valid</span>
      </div>
      <p class="genome-arbiter__rationale">Ranked proof-valid branches by proof score, risk, then patch size.</p>
    </section>
  </main>
</body>
</html>`;
}

async function sha256File(filePath) {
  const data = await readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

async function pngDimensions(filePath) {
  const data = await readFile(filePath);
  if (data.toString("ascii", 1, 4) !== "PNG") {
    throw new Error(`not_png:${filePath}`);
  }
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  };
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
