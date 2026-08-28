import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addAuthCookiesToBrowserContext,
  proofAuthCookieForSlug,
} from '../../synthi/scripts/codesite-proof-api.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const proofDir = path.resolve(repoRoot, 'tmp', 'codesite-dojo-proof');
const proofJsonPath = path.join(proofDir, 'codesite-radar-ui-proof.json');
const proofHtmlPath = path.join(proofDir, 'codesite-radar-ui-proof.html');
const adapterProofPath = path.join(proofDir, 'codesite-radar-adapter-proof.json');
const appUrl = process.env.CODESITE_APP_URL || process.env.CODESITE_PROOF_BASE_URL || 'http://127.0.0.1:3109';

async function readJsonIfExists(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw error;
  }
}

const existingProof = await readJsonIfExists(proofJsonPath);
const adapterProof = await readJsonIfExists(adapterProofPath);
const slug = adapterProof.slug || existingProof.slug || 'codesite-radar-proof-1782857554702';
const route = adapterProof.schemaProject?.route || adapterProof.project?.route || `/workspace/${encodeURIComponent(slug)}/codesite`;
const { authCookie } = await proofAuthCookieForSlug(slug);
const proof = {
  schemaVersion: 'synthi.codesite.radarUiProof.v1',
  ...existingProof,
  generatedAt: new Date().toISOString(),
  appUrl,
  slug,
  route,
  adapterProofPath: path.relative(repoRoot, adapterProofPath),
};

const browser = await chromium.launch({ headless: true });
const captures = [];

async function capture(viewport) {
  const context = await browser.newContext({ viewport });
  await addAuthCookiesToBrowserContext(context, appUrl, authCookie);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.goto(new URL(route, appUrl).toString(), { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => {
    return document.querySelector('[data-testid="codesite-panel"]')
      && document.querySelectorAll('[data-testid="codesite-flight-blip"]').length >= 3
      && document.body.innerText.includes('Landing queue');
  }, null, { timeout: 30000 });
  await page.waitForTimeout(450);

  const screenshot = `tmp/codesite-dojo-proof/codesite-radar-ui-${viewport.name}.png`;
  await page.screenshot({ path: path.resolve(repoRoot, screenshot), fullPage: true });

  const checks = await page.evaluate(() => {
    const rectOf = (selector) => {
      const node = document.querySelector(selector);
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      };
    };
    const laneRects = [...document.querySelectorAll('[data-testid="codesite-airspace-lane"]')].map((lane) => {
      const rect = lane.getBoundingClientRect();
      const pathChips = [...lane.querySelectorAll('code')].map((chip) => {
        const chipRect = chip.getBoundingClientRect();
        return {
          text: chip.textContent.trim(),
          width: chipRect.width,
          height: chipRect.height,
        };
      });
      return {
        width: rect.width,
        height: rect.height,
        text: lane.textContent.trim(),
        pathChips,
      };
    });
    return {
      radarRect: rectOf('[data-testid="codesite-radar-graph"]'),
      svgRect: rectOf('[data-testid="codesite-radar-graph"] svg'),
      tracePoints: document.querySelector('[data-testid="codesite-replay-trace"]')?.getAttribute('points') || '',
      holdingPatterns: document.querySelectorAll('[data-testid="codesite-holding-pattern"]').length,
      riskCones: document.querySelectorAll('[data-testid="codesite-risk-cone"]').length,
      flightBlips: document.querySelectorAll('[data-testid="codesite-flight-blip"]').length,
      hasLandingQueue: document.body.innerText.includes('Landing queue'),
      hasRiskLabel: document.body.innerText.includes('Risk cone'),
      laneRects,
      visibleText: document.body.innerText.slice(0, 2500),
    };
  });

  const collapsedChips = checks.laneRects.flatMap((lane, laneIndex) => {
    return lane.pathChips
      .filter((chip) => chip.text.length > 5 && chip.width < 44)
      .map((chip) => ({ laneIndex, ...chip }));
  });

  if (consoleErrors.length) {
    throw new Error(`${viewport.name} console errors: ${consoleErrors.join('\n')}`);
  }
  if (!checks.radarRect || checks.radarRect.width < 300 || checks.radarRect.height < 240) {
    throw new Error(`${viewport.name} radar graph is missing or undersized`);
  }
  if (checks.holdingPatterns < 1 || checks.riskCones < 1 || checks.flightBlips < 3) {
    throw new Error(`${viewport.name} radar layers are incomplete`);
  }
  if (!checks.hasLandingQueue || !checks.hasRiskLabel) {
    throw new Error(`${viewport.name} expected CodeSite labels are missing`);
  }
  if (collapsedChips.length) {
    throw new Error(`${viewport.name} collapsed path chips: ${JSON.stringify(collapsedChips)}`);
  }

  await context.close();
  captures.push({ viewport, screenshot, consoleErrors, checks });
}

try {
  await capture({ name: 'desktop', width: 1440, height: 980 });
  await capture({ name: 'mobile', width: 390, height: 920 });
} finally {
  await browser.close();
}

proof.browserProof = {
  generatedAt: new Date().toISOString(),
  appUrl,
  route,
  captures,
};

await fs.writeFile(proofJsonPath, `${JSON.stringify(proof, null, 2)}\n`);

function plural(count, singular, pluralName = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralName}`;
}

const imageRows = captures.map((capture) => {
  const src = path.basename(capture.screenshot);
  const chipCount = capture.checks.laneRects.reduce((sum, lane) => sum + lane.pathChips.length, 0);
  return [
    '    <section>',
    `      <h2>${capture.viewport.name} (${capture.viewport.width} x ${capture.viewport.height})</h2>`,
    `      <p>Radar ${Math.round(capture.checks.radarRect.width)} x ${Math.round(capture.checks.radarRect.height)}, ${plural(capture.checks.flightBlips, 'flight')}, ${plural(capture.checks.riskCones, 'risk cone')}, ${plural(capture.checks.holdingPatterns, 'holding pattern')}, ${plural(chipCount, 'readable path chip')}.</p>`,
    `      <img src="${src}" alt="CodeSite radar ${capture.viewport.name} proof screenshot" />`,
    '    </section>',
  ].join('\n');
}).join('\n\n');

await fs.writeFile(proofHtmlPath, `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CodeSite Radar UI Proof</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, sans-serif; background: #0b0b10; color: #f4f7fb; }
    body { margin: 0; padding: 24px; }
    main { max-width: 1500px; margin: 0 auto; display: grid; gap: 24px; }
    h1, h2, p { margin: 0; }
    h1 { font-size: 24px; }
    h2 { font-size: 18px; margin-bottom: 8px; }
    p { color: #9aa6bd; margin-bottom: 12px; }
    section { border: 1px solid #252a38; border-radius: 8px; padding: 16px; background: #141622; }
    img { display: block; width: 100%; height: auto; border-radius: 6px; border: 1px solid #252a38; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>CodeSite Radar UI Proof</h1>
      <p>Generated ${proof.browserProof.generatedAt} from ${appUrl}${route}</p>
    </header>
${imageRows}
  </main>
</body>
</html>
`);

console.log(JSON.stringify({
  ok: true,
  proofJsonPath: path.relative(repoRoot, proofJsonPath),
  proofHtmlPath: path.relative(repoRoot, proofHtmlPath),
  captures: captures.map((capture) => ({
    name: capture.viewport.name,
    screenshot: capture.screenshot,
    laneWidths: capture.checks.laneRects.map((lane) => lane.width),
    pathChipWidths: capture.checks.laneRects.map((lane) => lane.pathChips.map((chip) => chip.width)),
  })),
}, null, 2));
