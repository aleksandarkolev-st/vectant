import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROGRAM_RECIPES, buildDefaultPrograms } from '../defaultPrograms';
import { SUPPORTED_RUNTIME_TYPES, KNOWN_SCOPES } from '../manifest';

describe('buildDefaultPrograms', () => {
  const built = buildDefaultPrograms();

  it('builds one valid @vectant/<name> program per recipe', () => {
    expect(built.length).toBe(DEFAULT_PROGRAM_RECIPES.length);
    expect(built.length).toBe(10);
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

  it('ships @vectant/dbeaver as a webGui container program (KasmVNC)', () => {
    const dbeaver = built.find((b) => b.packageId === '@vectant/dbeaver').config;
    expect(dbeaver.runtimeType).toBe('container');
    expect(dbeaver.webGui).toBe(true);
    expect(dbeaver.ports).toEqual([6901]);
    expect(dbeaver.launch).toMatch(/^docker run .*-p 6901:6901/);
    // Mounts the workspace so DBeaver reads/writes the same /workspace files as the editor.
    expect(dbeaver.launch).toContain('-v "$PWD":/workspace -w /workspace');
    expect(dbeaver.permissions).toContain('ports.expose');
    // Per-session auto-login: the password is injected by the runtime manager;
    // the recipe only declares the passthrough (no value committed).
    expect(dbeaver.launch).toMatch(/-e KASM_PASSWORD(\s|$)/);
    expect(dbeaver.launch).not.toContain('KASM_PASSWORD=');
  });

  it('ships @vectant/postman as a webGui container program (KasmVNC)', () => {
    const postman = built.find((b) => b.packageId === '@vectant/postman').config;
    expect(postman.runtimeType).toBe('container');
    expect(postman.webGui).toBe(true);
    expect(postman.ports).toEqual([6902]);
    expect(postman.launch).toMatch(/^docker run .*-p 6902:6902/);
    // Distinct KasmVNC port so Postman and DBeaver (6901) can run side by side.
    expect(postman.launch).toContain('-e KASM_PORT=6902');
    // Mounts the workspace so Postman imports/exports collections as /workspace files.
    expect(postman.launch).toContain('-v "$PWD":/workspace -w /workspace');
    expect(postman.permissions).toContain('ports.expose');
    // Per-session auto-login passthrough (distinct from the -e KASM_PORT value above).
    expect(postman.launch).toMatch(/-e KASM_PASSWORD(\s|$)/);
    expect(postman.launch).not.toContain('KASM_PASSWORD=');
  });

  it('ships @vectant/portainer as a web-UI container program (Docker GUI)', () => {
    const portainer = built.find((b) => b.packageId === '@vectant/portainer').config;
    expect(portainer.runtimeType).toBe('container');
    expect(portainer.webGui).toBe(false); // web-UI tier: plain iframe, not KasmVNC
    expect(portainer.ports).toEqual([9000]);
    expect(portainer.launch).toMatch(/^docker run .*-p 9000:9000/);
    expect(portainer.launch).toContain('/var/run/docker.sock:/var/run/docker.sock');
    expect(portainer.launch).toContain('-v "$PWD/.vectant/portainer":/data');
    expect(portainer.launch).toContain('--no-csp');
    expect(portainer.permissions).toContain('ports.expose');
  });

  it('builds the Dev Container default via the devcontainer importer', () => {
    const dc = built.find((b) => b.packageId === '@vectant/devcontainer').config;
    expect(dc.source).toBe('devcontainer.json');
    expect(dc.sourceHints.containerImage).toMatch(/devcontainers/);
    expect(dc.ports).toContain(3000);
    expect(dc.launch).toBe('npm run dev');
    expect(dc.description.length).toBeGreaterThan(0);
  });

  it('ships the Dev Container as a real container program when containerRuntime is enabled', () => {
    const builtC = buildDefaultPrograms({ containerRuntime: true });
    const dc = builtC.find((b) => b.packageId === '@vectant/devcontainer').config;
    expect(dc.runtimeType).toBe('container');
    expect(dc.install.join(' ')).toMatch(/docker pull/);
    expect(dc.launch).toMatch(/docker run/);
    expect(dc.launch).toContain('-p 3000:3000');
    // non-devcontainer recipes are unaffected by the flag
    const web = builtC.find((b) => b.packageId === '@vectant/nextjs-dev').config;
    expect(web.runtimeType).toBe('web');
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
    expect(seeded).toContain('@vectant/dbeaver');
    expect(seeded.length).toBe(10);
    expect(prisma.marketplaceProgram.upsert).toHaveBeenCalledTimes(10);
    expect(prisma.programVersion.upsert).toHaveBeenCalledTimes(10);

    const arg = prisma.marketplaceProgram.upsert.mock.calls.find(
      (c) => c[0].where.packageId === '@vectant/nextjs-dev',
    )[0];
    expect(arg.create).toMatchObject({ packageId: '@vectant/nextjs-dev', publisher: 'vectant', verified: true, latestVersion: '1.0.0', publishedVersion: '1.0.0' });
    expect(arg.update).toMatchObject({ verified: true, latestVersion: '1.0.0', publishedVersion: '1.0.0' });
  });

  it('marks defaults as live-published so the marketplace lists them (publishedVersion set)', async () => {
    const prisma = makePrisma();
    await ensureDefaultPrograms(prisma);
    for (const call of prisma.marketplaceProgram.upsert.mock.calls) {
      expect(call[0].create.publishedVersion).toBe('1.0.0');
      expect(call[0].update.publishedVersion).toBe('1.0.0');
    }
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
