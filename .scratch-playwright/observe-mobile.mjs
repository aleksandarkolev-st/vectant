// Mobile-viewport snapshots for the floating status island.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.SYNTHI_BASE || 'http://localhost:3001';
const OUT = path.resolve('./screenshots');
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({
  viewport: { width: 414, height: 800 }, // iPhone-ish
  deviceScaleFactor: 2,
});
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

async function shot(name, urlPath, { waitMs = 4000 } = {}) {
  const url = `${BASE}${urlPath}`;
  console.log(`→ ${name}: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(waitMs);
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file });
    console.log(`  ✓ ${file}`);
  } catch (e) {
    console.log(`  ✗ ${e.message}`);
  }
}

await shot('30-mobile-empty', '/workspace/observe-demo?observe=1');

// Tablet
await ctx.close();
const tabletCtx = await browser.newContext({
  viewport: { width: 820, height: 1180 },
  deviceScaleFactor: 2,
});
const tabletPage = await tabletCtx.newPage();
await tabletPage.goto(`${BASE}/workspace/observe-demo?observe=1`, { waitUntil: 'domcontentloaded' });
await tabletPage.waitForTimeout(4000);
await tabletPage.screenshot({ path: path.join(OUT, '31-tablet-empty.png') });
console.log('  ✓ 31-tablet-empty.png');

await browser.close();
console.log('done');
