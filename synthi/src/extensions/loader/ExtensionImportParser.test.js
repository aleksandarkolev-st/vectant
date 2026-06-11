import { describe, expect, it } from 'vitest';
import { parseExtensionImportList, splitExtensionId } from './ExtensionImportParser';

describe('parseExtensionImportList', () => {
  it('parses plain text extension lists', () => {
    const result = parseExtensionImportList(`
      dbaeumer.vscode-eslint
      esbenp.prettier-vscode
    `);

    expect(result.ids).toEqual(['dbaeumer.vscode-eslint', 'esbenp.prettier-vscode']);
    expect(result.invalid).toEqual([]);
  });

  it('ignores comments, blank lines, and duplicate IDs', () => {
    const result = parseExtensionImportList(`
      # exported extensions
      dbaeumer.vscode-eslint
      DBAEUMER.vscode-eslint
      // another comment
      esbenp.prettier-vscode // formatter
    `);

    expect(result.ids).toEqual(['dbaeumer.vscode-eslint', 'esbenp.prettier-vscode']);
  });

  it('parses JSON arrays', () => {
    const result = parseExtensionImportList(JSON.stringify([
      'dbaeumer.vscode-eslint',
      'esbenp.prettier-vscode',
    ]));

    expect(result.ids).toEqual(['dbaeumer.vscode-eslint', 'esbenp.prettier-vscode']);
  });

  it('parses VS Code recommendations JSON', () => {
    const result = parseExtensionImportList(JSON.stringify({
      recommendations: ['ms-python.python'],
      unwantedRecommendations: ['github.vscode-pull-request-github'],
    }));

    expect(result.ids).toEqual(['ms-python.python', 'github.vscode-pull-request-github']);
  });

  it('filters invalid IDs and already installed extensions', () => {
    const result = parseExtensionImportList(`
      dbaeumer.vscode-eslint
      no-dot
      .bad
      esbenp.prettier-vscode
    `, {
      installedIds: ['dbaeumer.vscode-eslint'],
    });

    expect(result.ids).toEqual(['esbenp.prettier-vscode']);
    expect(result.alreadyInstalled).toEqual(['dbaeumer.vscode-eslint']);
    expect(result.invalid).toEqual(['no-dot', '.bad']);
  });
});

describe('splitExtensionId', () => {
  it('splits publisher and extension name on the first dot', () => {
    expect(splitExtensionId('publisher.name.with.dots')).toEqual({
      namespace: 'publisher',
      name: 'name.with.dots',
    });
  });

  it('returns null for invalid split positions', () => {
    expect(splitExtensionId('missingdot')).toBeNull();
    expect(splitExtensionId('.missing-publisher')).toBeNull();
    expect(splitExtensionId('missing-name.')).toBeNull();
  });
});
