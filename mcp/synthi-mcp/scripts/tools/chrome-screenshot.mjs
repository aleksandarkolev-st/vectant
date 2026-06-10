#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

function parseArgs(argv) {
  const args = {
    url: '',
    output: '',
    width: 1280,
    height: 720,
    delayMs: 1000,
    gpuEnabled: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--url') args.url = argv[++index] ?? '';
    else if (arg === '--output') args.output = argv[++index] ?? '';
    else if (arg === '--width') args.width = Number(argv[++index] ?? args.width);
    else if (arg === '--height') args.height = Number(argv[++index] ?? args.height);
    else if (arg === '--delay-ms') args.delayMs = Number(argv[++index] ?? args.delayMs);
    else if (arg === '--disable-gpu') args.gpuEnabled = false;
    else if (arg === '--enable-gpu') args.gpuEnabled = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.url) throw new Error('--url is required');
  if (!args.output) throw new Error('--output is required');
  if (!Number.isInteger(args.width) || args.width <= 0) throw new Error('--width must be positive');
  if (!Number.isInteger(args.height) || args.height <= 0) throw new Error('--height must be positive');
  if (!Number.isInteger(args.delayMs) || args.delayMs < 0) throw new Error('--delay-ms must be non-negative');
  return args;
}

function candidateChromePaths() {
  const roots = [
    process.env.PROGRAMFILES,
    process.env['PROGRAMFILES(X86)'],
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google') : '',
  ].filter(Boolean);
  return [
    process.env.CHROME_BIN,
    ...roots.map((root) => path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
    ...roots.map((root) => path.join(root, 'Chrome', 'Application', 'chrome.exe')),
  ].filter(Boolean);
}

function findChrome() {
  for (const candidate of candidateChromePaths()) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('Chrome executable not found; set CHROME_BIN');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const chrome = findChrome();
  await mkdir(path.dirname(path.resolve(args.output)), { recursive: true });
  const chromeArgs = [
    '--headless=new',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${args.width},${args.height}`,
    `--virtual-time-budget=${args.delayMs}`,
    `--screenshot=${path.resolve(args.output)}`,
    args.url,
  ];
  if (!args.gpuEnabled) chromeArgs.splice(1, 0, '--disable-gpu');
  const started = Date.now();
  const code = await new Promise((resolve, reject) => {
    const child = spawn(chrome, chromeArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('exit', (exitCode, signal) => {
      if (exitCode !== 0 || signal) {
        reject(new Error(`Chrome screenshot failed exit=${exitCode} signal=${signal ?? ''}: ${stderr.slice(-2000)}`));
        return;
      }
      resolve(exitCode ?? 0);
    });
  });
  console.log(JSON.stringify({
    schemaVersion: 'synthi.chrome_screenshot.v1',
    code,
    elapsedMs: Date.now() - started,
    url: args.url,
    output: path.resolve(args.output),
    width: args.width,
    height: args.height,
    gpuEnabled: args.gpuEnabled,
  }));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exitCode = 1;
});
