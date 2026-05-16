// Observe the running synthi dev server and capture screenshots
// of every meaningful surface for a baseline before redesign.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const BASE = process.env.SYNTHI_BASE || 'http://localhost:3001';
const OUT = path.resolve('./screenshots');
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1600, height: 1000 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();

// Quiet down noisy console output but log errors
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

async function shot(name, urlPath, { fullPage = false, waitMs = 1500 } = {}) {
  const url = `${BASE}${urlPath}`;
  console.log(`→ ${name}: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for hydration + first paint
    await page.waitForTimeout(waitMs);
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, fullPage });
    console.log(`  ✓ ${file}`);
  } catch (e) {
    console.log(`  ✗ ${e.message}`);
  }
}

// Public surfaces (no auth)
await shot('01-root', '/', { fullPage: true, waitMs: 2500 });
await shot('02-login', '/login', { fullPage: true, waitMs: 2000 });
await shot('03-docking-demo', '/workspace/docking-demo', { fullPage: false, waitMs: 3000 });
await shot('04-extension-test', '/extension-test', { fullPage: false, waitMs: 2000 });
await shot('05-collab-fake', '/collab/test-session-abc', { fullPage: false, waitMs: 2500 });

// Workspace — will redirect when unauth. Capture pre-redirect.
await shot('06-workspace-redirect', '/workspace/test-slug', { fullPage: false, waitMs: 800 });

// Popout window
await shot('07-popout', '/workspace/popout', { fullPage: false, waitMs: 1500 });

await browser.close();
console.log('done');
