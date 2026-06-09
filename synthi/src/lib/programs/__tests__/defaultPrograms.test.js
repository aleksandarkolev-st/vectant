import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROGRAM_RECIPES, buildDefaultPrograms } from '../defaultPrograms';
import { SUPPORTED_RUNTIME_TYPES, KNOWN_SCOPES } from '../manifest';

describe('buildDefaultPrograms', () => {
  const built = buildDefaultPrograms();

  it('builds one valid @vectant/<name> program per recipe', () => {
    expect(built.length).toBe(DEFAULT_PROGRAM_RECIPES.length);
    expect(built.length).toBe(7);
    for (const { packageId, config } of built) {
      expect(packageId).toMatch(/^@vectant\/[a-z0-9._-]+$/);
      expect(SUPPORTED_RUNTIME_TYPES).toContain(config.runtimeType);
      expect(typeof config.launch).toBe('string');
      expect(config.launch.length).toBeGreaterThan(0);
      expect(config.version).toBe('1.0.0');
      expect(config.displayName.length).toBeGreaterThan(0);
      expect(config.description.length).toBeGreaterThan(0);
      for (const scope of config.permissions) expect(KNOWN_SCOPES).toContain(scope);
    }
  });

  it('spans non-web runtime types (background + tui with no ports)', () => {
    const byId = Object.fromEntries(built.map((b) => [b.packageId, b.config]));
    expect(byId['@vectant/node-worker'].runtimeType).toBe('background');
    expect(byId['@vectant/node-worker'].ports).toEqual([]);
    expect(byId['@vectant/lazygit'].runtimeType).toBe('tui');
    expect(byId['@vectant/lazygit'].ports).toEqual([]);
  });

  it('builds the Dev Container default via the devcontainer importer', () => {
    const dc = built.find((b) => b.packageId === '@vectant/devcontainer').config;
    expect(dc.source).toBe('devcontainer.json');
    expect(dc.sourceHints.containerImage).toMatch(/devcontainers/);
    expect(dc.ports).toContain(3000);
    expect(dc.launch).toBe('npm run dev');
    expect(dc.description.length).toBeGreaterThan(0);
  });
});

import { ensureDefaultPrograms } from '../defaultPrograms';

describe('ensureDefaultPrograms', () => {
  function makePrisma() {
    return {
      marketplaceProgram: { upsert: vi.fn(async ({ where }) => ({ id: `prog_${where.packageId}`, packageId: where.packageId })) },
      programVersion: { upsert: vi.fn(async () => ({ id: 'ver1' })) },
    };
  }

  it('upserts each default as a verified vectant program + its version', async () => {
    const prisma = makePrisma();
    const seeded = await ensureDefaultPrograms(prisma);

    expect(seeded).toContain('@vectant/nextjs-dev');
    expect(seeded.length).toBe(7);
    expect(prisma.marketplaceProgram.upsert).toHaveBeenCalledTimes(7);
    expect(prisma.programVersion.upsert).toHaveBeenCalledTimes(7);

    const arg = prisma.marketplaceProgram.upsert.mock.calls.find(
      (c) => c[0].where.packageId === '@vectant/nextjs-dev',
    )[0];
    expect(arg.create).toMatchObject({ packageId: '@vectant/nextjs-dev', publisher: 'vectant', verified: true, latestVersion: '1.0.0' });
    expect(arg.update).toMatchObject({ verified: true, latestVersion: '1.0.0' });
  });

  it('never writes installCount on update (preserves reputation on re-seed)', async () => {
    const prisma = makePrisma();
    await ensureDefaultPrograms(prisma);
    for (const call of prisma.marketplaceProgram.upsert.mock.calls) {
      expect(call[0].update).not.toHaveProperty('installCount');
      expect(call[0].create).not.toHaveProperty('installCount');
    }
  });
});
