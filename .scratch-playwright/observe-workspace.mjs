// Capture the actual workspace UI (auth bypassed via ?observe=1)
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

page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('[console.error]', msg.text().slice(0, 200));
});

async function shot(name, urlPath, { fullPage = false, waitMs = 2500, action } = {}) {
  const url = `${BASE}${urlPath}`;
  console.log(`→ ${name}: ${url}`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(waitMs);
    if (action) await action(page);
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, fullPage });
    console.log(`  ✓ ${file}`);
  } catch (e) {
    console.log(`  ✗ ${e.message}`);
  }
}

// Main workspace (auth bypassed)
await shot('10-workspace-empty', '/workspace/observe-demo?observe=1', { waitMs: 5000 });

// Workspace with chat visible
await shot('11-workspace-chat', '/workspace/observe-demo?observe=1', {
  waitMs: 4000,
  action: async (p) => {
    // Toggle chat by clicking the chat button in topnav (title="Toggle Chat")
    try {
      const chatBtn = await p.$('[title="Toggle Chat" i]');
      if (chatBtn) await chatBtn.click();
      await p.waitForTimeout(800);
    } catch (e) { console.log('  (chat btn miss)', e.message); }
  },
});

// Workspace with terminal toggled
await shot('12-workspace-terminal', '/workspace/observe-demo?observe=1', {
  waitMs: 4000,
  action: async (p) => {
    try {
      const t = await p.$('[title="Toggle Terminal" i]');
      if (t) await t.click();
      await p.waitForTimeout(800);
    } catch (e) {}
  },
});

// Settings view via activity bar
await shot('13-workspace-settings', '/workspace/observe-demo?observe=1', {
  waitMs: 4000,
  action: async (p) => {
    try {
      const s = await p.$('[aria-label="Settings"]');
      if (s) await s.click();
      await p.waitForTimeout(800);
    } catch (e) {}
  },
});

// Search sidebar
await shot('14-workspace-search', '/workspace/observe-demo?observe=1', {
  waitMs: 4000,
  action: async (p) => {
    try {
      const s = await p.$('[aria-label="Search"]');
      if (s) await s.click();
      await p.waitForTimeout(800);
    } catch (e) {}
  },
});

// Git (Source Control)
await shot('15-workspace-git', '/workspace/observe-demo?observe=1', {
  waitMs: 4000,
  action: async (p) => {
    try {
      const s = await p.$('[aria-label="Source Control"]');
      if (s) await s.click();
      await p.waitForTimeout(800);
    } catch (e) {}
  },
});

// AI Healing panel
await shot('16-workspace-ai-healing', '/workspace/observe-demo?observe=1', {
  waitMs: 4000,
  action: async (p) => {
    try {
      const s = await p.$('[aria-label="AI Healing"]');
      if (s) await s.click();
      await p.waitForTimeout(800);
    } catch (e) {}
  },
});

// Extensions
await shot('17-workspace-extensions', '/workspace/observe-demo?observe=1', {
  waitMs: 4000,
  action: async (p) => {
    try {
      const s = await p.$('[aria-label="Extensions"]');
      if (s) await s.click();
      await p.waitForTimeout(800);
    } catch (e) {}
  },
});

// Theme picker via Ctrl+K Ctrl+T
await shot('18-theme-picker', '/workspace/observe-demo?observe=1', {
  waitMs: 4000,
  action: async (p) => {
    try {
      await p.keyboard.press('Control+k');
      await p.waitForTimeout(150);
      await p.keyboard.press('Control+t');
      await p.waitForTimeout(800);
    } catch (e) {}
  },
});

// Pull Requests
await shot('19-workspace-prs', '/workspace/observe-demo?observe=1', {
  waitMs: 4000,
  action: async (p) => {
    try {
      const s = await p.$('[aria-label="Pull Requests"]');
      if (s) await s.click();
      await p.waitForTimeout(800);
    } catch (e) {}
  },
});

await browser.close();
console.log('done');
