'use client';
import { useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { AlertTriangle, Check, ChevronDown, Code2, FileText, Save } from 'lucide-react';
import { parseNotebook, serializeNotebook } from '@/lib/jupyter/notebook';
import { chooseSafeOutput, safeImageUrl } from '@/lib/jupyter/outputSafety';

function SafeOutput({ output }) {
  if (output.output_type === 'error') return <pre className="notebook-error">{[output.ename, output.evalue, ...(output.traceback || [])].filter(Boolean).join('\n')}</pre>;
  const candidate = chooseSafeOutput(output.data || {});
  const text = candidate?.value ?? output.text ?? '';
  if (!candidate) return text ? <pre className="notebook-output">{Array.isArray(text) ? text.join('') : text}</pre> : null;
  if (candidate.mime.startsWith('image/')) { const src = safeImageUrl(candidate.mime, candidate.value); return src ? <img className="notebook-image" src={src} alt="Notebook output" /> : <p className="notebook-muted">Image output exceeds the safe preview limit.</p>; }
  if (candidate.mime === 'application/json') return <pre className="notebook-output">{typeof text === 'string' ? text : JSON.stringify(text, null, 2)}</pre>;
  if (candidate.mime === 'text/markdown') return <div className="notebook-markdown" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(String(text), { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'iframe', 'script', 'svg'] }) }} />;
  return <pre className="notebook-output">{String(text)}</pre>;
}

export default function NotebookViewer({ path, content, readOnly = false, onSave }) {
  const [selected, setSelected] = useState(new Set());
  const parsed = useMemo(() => { try { return { notebook: parseNotebook(content) }; } catch (error) { return { error }; } }, [content]);
  if (parsed.error) return <section className="notebook-shell" role="alert"><AlertTriangle size={18} /><div><strong>Notebook unavailable</strong><p>{parsed.error.message}</p><p className="notebook-muted">Open as source to recover or repair this file.</p></div></section>;
  const { notebook } = parsed;
  return <section className="notebook-shell" aria-label={`Notebook ${path}`}>
    <header className="notebook-toolbar"><div><span className="notebook-eyebrow">Jupyter notebook</span><strong>{path.split('/').pop()}</strong></div><div className="notebook-toolbar-actions"><span>{notebook.cells.length} cells</span>{onSave && !readOnly && <button type="button" onClick={() => onSave(serializeNotebook(notebook))}><Save size={15} /> Save notebook</button>}</div></header>
    <div className="notebook-notice"><AlertTriangle size={14} /> Rendered notebook content is untrusted. Scripts, widgets, iframes, SVG, and remote embeds are blocked.</div>
    <div className="notebook-cells">{notebook.cells.map((cell, index) => { const active = selected.has(cell.id); return <article className={`notebook-cell ${active ? 'is-selected' : ''}`} key={cell.id}>
      <header><button type="button" aria-pressed={active} onClick={() => setSelected((current) => { const next = new Set(current); next.has(cell.id) ? next.delete(cell.id) : next.add(cell.id); return next; })}>{active ? <Check size={14} /> : <ChevronDown size={14} />} <span>Cell {index + 1}</span></button><span>{cell.cell_type}</span></header>
      {cell.cell_type === 'markdown' ? <div className="notebook-markdown" dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(cell.source, { USE_PROFILES: { html: true }, FORBID_TAGS: ['style', 'iframe', 'script', 'svg'] }) }} /> : <pre className="notebook-source"><Code2 size={14} /><code>{cell.source}</code></pre>}
      {cell.cell_type === 'code' && cell.outputs?.map((output, outputIndex) => <SafeOutput output={output} key={outputIndex} />)}
    </article>; })}</div>
    <style jsx>{`.notebook-shell{height:100%;overflow:auto;background:var(--bg-editor);color:var(--text-primary);font:13px/1.5 system-ui,sans-serif}.notebook-toolbar{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;padding:12px 20px;border-bottom:1px solid var(--border-medium);background:var(--bg-sidebar)}.notebook-toolbar strong{display:block}.notebook-eyebrow{display:block;color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:.08em}.notebook-toolbar-actions{display:flex;gap:12px;align-items:center;color:var(--text-secondary)}.notebook-toolbar button{display:inline-flex;gap:6px;align-items:center;border:1px solid var(--border-medium);border-radius:5px;background:transparent;color:inherit;padding:6px 9px}.notebook-notice{display:flex;gap:8px;align-items:center;margin:16px auto;max-width:980px;padding:9px 12px;border:1px solid color-mix(in srgb,#d39235 34%,var(--border-medium));color:var(--text-secondary);background:color-mix(in srgb,#d39235 8%,transparent)}.notebook-cells{max-width:980px;margin:0 auto;padding:0 20px 48px}.notebook-cell{margin:12px 0;border:1px solid var(--border-medium);border-radius:6px;overflow:hidden}.notebook-cell.is-selected{outline:2px solid color-mix(in srgb,var(--accent-primary) 65%,transparent);outline-offset:1px}.notebook-cell>header{display:flex;justify-content:space-between;padding:6px 10px;background:var(--bg-sidebar);color:var(--text-muted);font-size:11px}.notebook-cell>header button{display:flex;align-items:center;gap:6px;border:0;background:transparent;color:inherit;padding:0}.notebook-source,.notebook-output,.notebook-error{margin:0;padding:14px;white-space:pre-wrap;overflow:auto;background:color-mix(in srgb,var(--bg-editor) 86%,#111)}.notebook-source{display:flex;gap:9px}.notebook-error{color:#f19797;background:color-mix(in srgb,#a73b3b 16%,var(--bg-editor))}.notebook-markdown{padding:16px;max-width:75ch}.notebook-markdown :global(h1),.notebook-markdown :global(h2){margin-top:0}.notebook-image{display:block;max-width:min(100%,900px);height:auto;padding:12px}.notebook-muted{padding:0 14px;color:var(--text-muted)}@media(max-width:700px){.notebook-toolbar{padding:10px 12px}.notebook-cells{padding:0 10px 30px}.notebook-toolbar-actions span{display:none}}`}</style>
  </section>;
}
