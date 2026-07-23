import { describe, expect, it } from 'vitest';
import { normalizeNotebook, parseNotebook, revisionOf } from '../notebook';
import { chooseSafeOutput, safeImageUrl } from '../outputSafety';
import { safeJupyterPath, validateJupyterOrigin } from '../policy';
import { compareNotebookRevisions, savePlan } from '../sync';

describe('notebook model', () => {
  const notebook = { nbformat: 4, nbformat_minor: 5, metadata: { kernelspec: { name: 'python3' } }, cells: [{ cell_type: 'code', source: ['print(1)\n'], metadata: { custom: true }, execution_count: 1, outputs: [{ output_type: 'stream', name: 'stdout', text: '1\n' }] }] };
  it('preserves unknown metadata and normalizes source and ids', () => { const result = normalizeNotebook(notebook); expect(result.cells[0]).toMatchObject({ source: 'print(1)\n', metadata: { custom: true } }); expect(result.cells[0].id).toBeTruthy(); });
  it('rejects malformed notebooks', () => { expect(() => parseNotebook('{')).toThrow('malformed'); expect(() => normalizeNotebook({ nbformat: 4, cells: [{}] })).toThrow('unsupported type'); });
  it('produces stable revision metadata', () => { expect(revisionOf('abc')).toEqual(revisionOf('abc')); expect(revisionOf('abc').hash).not.toBe(revisionOf('abd').hash); });
});
describe('output safety', () => { it('chooses only supported MIME types and bounds image URLs', () => { expect(chooseSafeOutput({ 'text/html': '<script />', 'text/plain': 'safe' })).toEqual({ mime: 'text/plain', value: 'safe' }); expect(safeImageUrl('image/svg+xml', 'abc')).toBeNull(); expect(safeImageUrl('image/png', 'abc')).toBe('data:image/png;base64,abc'); }); });
describe('gateway policy', () => { it('rejects credential URLs and path traversal', () => { expect(() => validateJupyterOrigin('https://token@example.com')).toThrow(); expect(() => safeJupyterPath('../secret.ipynb')).toThrow(); expect(safeJupyterPath('notebooks/a.ipynb')).toBe('notebooks/a.ipynb'); }); });
describe('sync coordination', () => { it('never resolves concurrent durable changes with last-write-wins', () => { const sync = compareNotebookRevisions({ baseline: { hash: 'base' }, workspace: { hash: 'local' }, server: { hash: 'remote' } }); expect(sync.state).toBe('conflict'); expect(savePlan({ sync })).toMatchObject({ allowed: false, recovery: 'choose_workspace_or_server' }); }); it('avoids duplicate writes for a mounted server', () => { expect(savePlan({ sync: { state: 'clean' }, mounted: true }).operations).toEqual(['workspace_write']); }); });
