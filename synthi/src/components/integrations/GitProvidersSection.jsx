'use client';
import { useCallback, useEffect, useState } from 'react';
import { GitBranch, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { fetchGitProviders, addGitProviderPat, deleteGitProvider, startGitOAuth } from './integrationsClient';

export default function GitProvidersSection() {
  const [providers, setProviders] = useState([]);
  const [form, setForm] = useState({ providerType: 'gitlab', name: '', baseUrl: '', token: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => { try { setProviders(await fetchGitProviders()); } catch (e) { toast.error(e.message); } }, []);
  useEffect(() => { load(); }, [load]);

  const addPat = async () => {
    if (!form.name.trim() || !form.token.trim()) { toast.error('Name + token required'); return; }
    setBusy(true);
    try { await addGitProviderPat(form); setForm({ ...form, name: '', token: '', baseUrl: '' }); load(); toast.success('Provider connected'); }
    catch (e) { toast.error(e.message); } finally { setBusy(false); }
  };
  const remove = async (id) => { try { await deleteGitProvider(id); setProviders((p) => p.filter((x) => x.id !== id)); toast.success('Disconnected'); } catch (e) { toast.error(e.message); } };

  return (
    <div className="rounded-lg border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
      <div className="flex items-center gap-2 px-2.5 py-2 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        <GitBranch className="w-3.5 h-3.5" /> Git Providers
      </div>
      <div className="px-2.5 pb-2 flex flex-wrap items-center gap-1.5">
        <Button variant="ghost" size="sm" onClick={() => startGitOAuth('gitlab')}>Connect GitLab (OAuth)</Button>
        <Button variant="ghost" size="sm" onClick={() => startGitOAuth('github')}>Connect GitHub (OAuth)</Button>
      </div>
      <div className="px-2.5 pb-2 flex flex-wrap items-center gap-1.5">
        <select value={form.providerType} onChange={(e) => setForm({ ...form, providerType: e.target.value })}
          className="text-xs rounded px-1.5 py-1" style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}>
          <option value="gitlab">GitLab</option><option value="github">GitHub</option><option value="generic">Generic</option>
        </select>
        <input placeholder="name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
          className="text-xs rounded px-2 py-1 w-24" style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }} />
        <input placeholder="base URL (self-hosted)" value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
          className="text-xs rounded px-2 py-1 flex-1" style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }} />
        <input placeholder="token (PAT)" type="password" value={form.token} onChange={(e) => setForm({ ...form, token: e.target.value })}
          className="text-xs rounded px-2 py-1 w-28" style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }} />
        <Button variant="ghost" size="icon" onClick={addPat} disabled={busy} title="Add PAT provider"><Plus className="w-3.5 h-3.5" /></Button>
      </div>
      <div className="px-2.5 pb-2 flex flex-col gap-1">
        {providers.length === 0 && <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>No git providers yet.</div>}
        {providers.map((p) => (
          <div key={p.id} className="flex items-center justify-between text-xs">
            <span className="truncate">{p.name} <span style={{ color: 'var(--text-dim)' }}>({p.providerType}{p.accountLogin ? ` · ${p.accountLogin}` : ''})</span>
              {p.needsRelink && <span style={{ color: 'var(--accent-danger, #ff5757)' }}> · needs relink</span>}</span>
            <Button variant="ghost" size="icon" onClick={() => remove(p.id)} title="Disconnect"><Trash2 className="w-3.5 h-3.5" /></Button>
          </div>
        ))}
      </div>
    </div>
  );
}
