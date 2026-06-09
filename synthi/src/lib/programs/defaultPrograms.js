/**
 * @fileoverview Canonical default marketplace catalog (single source of truth).
 *
 * These ship for every user as official `@vectant/*` programs (publisher
 * 'vectant', verified). Each recipe is validated through the SAME fail-closed
 * path as any user recipe — `parseProgramManifest` for manifest recipes,
 * `importDevcontainer` for the Dev Container. Real container execution is NOT
 * introduced here; the Dev Container runs in the managed session today (native
 * Docker is a separate future slice — see tasks/todo.md backlog).
 */

import { parseProgramManifest } from './manifest';
import { importDevcontainer } from './devcontainer';

const WEB_SCOPES = ['program.launch', 'network.outbound', 'ports.expose'];

/**
 * @typedef {{ name: string, kind: 'manifest'|'devcontainer', recipe: object, description?: string }} DefaultRecipe
 */

/** @type {DefaultRecipe[]} */
export const DEFAULT_PROGRAM_RECIPES = [
  {
    name: 'nextjs-dev',
    kind: 'manifest',
    recipe: {
      packageId: 'nextjs-dev', version: '1.0.0',
      displayName: 'Next.js Dev Server',
      description: 'Next.js development server with hot reload (port 3000).',
      runtimeType: 'web', install: ['npm install'], launch: 'npm run dev',
      ports: [3000], permissions: WEB_SCOPES,
    },
  },
  {
    name: 'vite-react',
    kind: 'manifest',
    recipe: {
      packageId: 'vite-react', version: '1.0.0',
      displayName: 'Vite + React',
      description: 'Vite + React dev server with fast HMR (port 5173).',
      runtimeType: 'web', install: ['npm install'], launch: 'npm run dev',
      ports: [5173], permissions: WEB_SCOPES,
    },
  },
  {
    name: 'flask-api',
    kind: 'manifest',
    recipe: {
      packageId: 'flask-api', version: '1.0.0',
      displayName: 'Flask API',
      description: 'Python Flask API server (port 5000).',
      // Debian 12's system Python is externally-managed (PEP 668), so install
      // into a venv. python3-venv is provided by the program-runtime image.
      runtimeType: 'web',
      install: ['python3 -m venv .venv', '.venv/bin/pip install -r requirements.txt'],
      launch: '.venv/bin/flask run --host 0.0.0.0 --port 5000',
      ports: [5000], permissions: WEB_SCOPES,
    },
  },
  {
    name: 'static-site',
    kind: 'manifest',
    recipe: {
      packageId: 'static-site', version: '1.0.0',
      displayName: 'Static Site',
      description: 'Static file server for HTML/CSS/JS (port 8080).',
      runtimeType: 'web', install: [], launch: 'npx http-server -p 8080',
      ports: [8080], permissions: WEB_SCOPES,
    },
  },
  {
    name: 'node-worker',
    kind: 'manifest',
    recipe: {
      packageId: 'node-worker', version: '1.0.0',
      displayName: 'Background Worker',
      description: 'Background Node.js worker process (no web port).',
      runtimeType: 'background', install: ['npm install'], launch: 'node worker.js',
      ports: [], permissions: ['program.launch', 'network.outbound'],
    },
  },
  {
    name: 'lazygit',
    kind: 'manifest',
    recipe: {
      packageId: 'lazygit', version: '1.0.0',
      displayName: 'lazygit (Git TUI)',
      description: 'lazygit terminal UI for Git.',
      runtimeType: 'tui', install: [], launch: 'lazygit',
      ports: [], permissions: ['program.launch'],
    },
  },
  {
    name: 'devcontainer',
    kind: 'devcontainer',
    description:
      "Containerized dev environment (devcontainer.json / Docker image). Runs in Vectant's managed runtime today; native Docker execution is on the roadmap.",
    recipe: {
      name: 'Dev Container', version: '1.0.0',
      image: 'mcr.microsoft.com/devcontainers/universal:2',
      forwardPorts: [3000],
      postCreateCommand: 'npm install',
      postStartCommand: 'npm run dev',
    },
  },
];

/**
 * Build the validated default catalog. Manifest recipes go through
 * parseProgramManifest; the devcontainer recipe through importDevcontainer.
 * @returns {{ packageId: string, config: object }[]}
 */
export function buildDefaultPrograms() {
  return DEFAULT_PROGRAM_RECIPES.map((entry) => {
    let config;
    if (entry.kind === 'devcontainer') {
      config = importDevcontainer(entry.recipe).config;
      if (entry.description) config.description = entry.description;
    } else {
      config = parseProgramManifest(entry.recipe);
    }
    return { packageId: `@vectant/${entry.name}`, config };
  });
}

/**
 * Idempotently upsert the default catalog. Mirrors store.publishProgram's
 * upsert shape but with publisher 'vectant' + verified true. The `update`
 * clause deliberately omits installCount so re-seeding preserves reputation.
 * @param {import('@prisma/client').PrismaClient} prisma
 * @returns {Promise<string[]>} the upserted packageIds
 */
export async function ensureDefaultPrograms(prisma) {
  const built = buildDefaultPrograms();
  const seeded = [];
  for (const { packageId, config } of built) {
    const program = await prisma.marketplaceProgram.upsert({
      where: { packageId },
      update: {
        verified: true,
        displayName: config.displayName,
        description: config.description || null,
        latestVersion: config.version,
      },
      create: {
        packageId,
        publisher: 'vectant',
        verified: true,
        displayName: config.displayName,
        description: config.description || null,
        latestVersion: config.version,
        publishedByUserId: null,
      },
    });
    await prisma.programVersion.upsert({
      where: { programId_version: { programId: program.id, version: config.version } },
      update: {
        manifestJson: JSON.stringify(config),
        requiredTools: [],
        ports: (config.ports || []).map((p) => String(p)),
      },
      create: {
        programId: program.id,
        version: config.version,
        manifestJson: JSON.stringify(config),
        requiredTools: [],
        ports: (config.ports || []).map((p) => String(p)),
      },
    });
    seeded.push(packageId);
  }
  return seeded;
}
