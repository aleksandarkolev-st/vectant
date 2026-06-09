import { describe, expect, it } from 'vitest';
import { SCAFFOLD_TEMPLATES, getScaffoldTemplate, SCAFFOLDABLE_PACKAGE_IDS } from '../scaffoldTemplates';

describe('scaffoldTemplates', () => {
  it('has a template for each scaffoldable default; every file has a relative path + contents', () => {
    expect(SCAFFOLDABLE_PACKAGE_IDS).toEqual(
      expect.arrayContaining(['@vectant/nextjs-dev', '@vectant/vite-react', '@vectant/flask-api', '@vectant/static-site', '@vectant/node-worker']),
    );
    for (const id of SCAFFOLDABLE_PACKAGE_IDS) {
      const files = getScaffoldTemplate(id);
      expect(Array.isArray(files)).toBe(true);
      expect(files.length).toBeGreaterThan(0);
      for (const f of files) {
        expect(typeof f.path).toBe('string');
        expect(f.path.length).toBeGreaterThan(0);
        expect(f.path.startsWith('/')).toBe(false);
        expect(f.path.split(/[\\/]/)).not.toContain('..');
        expect(typeof f.contents).toBe('string');
        expect(f.contents.length).toBeGreaterThan(0);
      }
    }
  });

  it('every package.json template is valid JSON', () => {
    for (const id of SCAFFOLDABLE_PACKAGE_IDS) {
      for (const f of getScaffoldTemplate(id)) {
        if (f.path === 'package.json') expect(() => JSON.parse(f.contents)).not.toThrow();
      }
    }
  });

  it('returns null for non-scaffoldable / unknown packageIds', () => {
    expect(getScaffoldTemplate('@vectant/lazygit')).toBeNull();
    expect(getScaffoldTemplate('@vectant/devcontainer')).toBeNull();
    expect(getScaffoldTemplate('@other/web')).toBeNull();
    expect(getScaffoldTemplate(undefined)).toBeNull();
  });

  it('SCAFFOLD_TEMPLATES is keyed by bare default name', () => {
    expect(Object.keys(SCAFFOLD_TEMPLATES)).toEqual(
      expect.arrayContaining(['nextjs-dev', 'vite-react', 'flask-api', 'static-site', 'node-worker']),
    );
  });
});
