/**
 * Minimal inline starter templates for the scaffoldable @vectant/* defaults.
 * Each template is a list of { path, contents } files. They are written
 * server-side, ONLY when the file is missing (never clobbered) — see the
 * collab-server scaffold writer. Templates are deliberately tiny: just enough
 * for the default's launch command to run.
 */

const NEXTJS = [
  {
    path: 'package.json',
    contents: JSON.stringify(
      {
        name: 'vectant-nextjs-starter', version: '0.1.0', private: true,
        scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
        dependencies: { next: '^14.2.0', react: '^18.3.0', 'react-dom': '^18.3.0' },
      },
      null,
      2,
    ) + '\n',
  },
  {
    path: 'app/layout.js',
    contents: `export const metadata = { title: 'Vectant Next.js Starter' };\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`,
  },
  {
    path: 'app/page.js',
    contents: `export default function Page() {\n  return (\n    <main style={{ fontFamily: 'system-ui', padding: 48 }}>\n      <h1>Next.js is running 🎉</h1>\n      <p>Edit app/page.js and save to see changes.</p>\n    </main>\n  );\n}\n`,
  },
];

const VITE_REACT = [
  {
    path: 'package.json',
    contents: JSON.stringify(
      {
        name: 'vectant-vite-react-starter', version: '0.1.0', private: true, type: 'module',
        scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview' },
        dependencies: { react: '^18.3.0', 'react-dom': '^18.3.0' },
        devDependencies: { vite: '^5.2.0', '@vitejs/plugin-react': '^4.3.0' },
      },
      null,
      2,
    ) + '\n',
  },
  {
    path: 'vite.config.js',
    contents: `import { defineConfig } from 'vite';\nimport react from '@vitejs/plugin-react';\n\nexport default defineConfig({ plugins: [react()], server: { host: true, port: 5173 } });\n`,
  },
  {
    path: 'index.html',
    contents: `<!doctype html>\n<html>\n  <head><meta charset="utf-8" /><title>Vite + React</title></head>\n  <body>\n    <div id="root"></div>\n    <script type="module" src="/src/main.jsx"></script>\n  </body>\n</html>\n`,
  },
  {
    path: 'src/main.jsx',
    contents: `import React from 'react';\nimport { createRoot } from 'react-dom/client';\n\ncreateRoot(document.getElementById('root')).render(\n  <main style={{ fontFamily: 'system-ui', padding: 48 }}>\n    <h1>Vite + React is running ⚡</h1>\n    <p>Edit src/main.jsx and save.</p>\n  </main>,\n);\n`,
  },
];

const FLASK = [
  {
    path: 'requirements.txt',
    contents: `flask>=3.0\n`,
  },
  {
    path: 'app.py',
    contents: `from flask import Flask\n\napp = Flask(__name__)\n\n\n@app.get("/")\ndef index():\n    return "Flask is running 🐍"\n`,
  },
];

const STATIC_SITE = [
  {
    path: 'index.html',
    contents: `<!doctype html>\n<html>\n  <head><meta charset="utf-8" /><title>Static Site</title></head>\n  <body style="font-family: system-ui; padding: 48px;">\n    <h1>Static site is serving 📄</h1>\n    <p>Edit index.html and refresh.</p>\n  </body>\n</html>\n`,
  },
];

const NODE_WORKER = [
  {
    path: 'package.json',
    contents: JSON.stringify(
      { name: 'vectant-worker-starter', version: '0.1.0', private: true, scripts: { start: 'node worker.js' } },
      null,
      2,
    ) + '\n',
  },
  {
    path: 'worker.js',
    contents: `let n = 0;\nconsole.log('worker started');\nsetInterval(() => {\n  n += 1;\n  console.log('tick', n, new Date().toISOString());\n}, 5000);\n`,
  },
];

/** Templates keyed by the bare default name (matches @vectant/<name>). */
export const SCAFFOLD_TEMPLATES = {
  'nextjs-dev': NEXTJS,
  'vite-react': VITE_REACT,
  'flask-api': FLASK,
  'static-site': STATIC_SITE,
  'node-worker': NODE_WORKER,
};

/** The packageIds that have a scaffold template (used by the route + UI). */
export const SCAFFOLDABLE_PACKAGE_IDS = Object.keys(SCAFFOLD_TEMPLATES).map((name) => `@vectant/${name}`);

/** Look up a scaffold template by published packageId (@vectant/<name>) → files | null. */
export function getScaffoldTemplate(packageId) {
  if (typeof packageId !== 'string') return null;
  const match = /^@vectant\/(.+)$/.exec(packageId);
  if (!match) return null;
  return SCAFFOLD_TEMPLATES[match[1]] || null;
}
