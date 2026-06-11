'use client';

import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Plus, Trash2, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { fetchTokens, createToken, revokeToken } from './integrationsClient';

export default function CliAccessSection() {
  const [tokens, setTokens] = useState([]);
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [justCreated, setJustCreated] = useState(null); // { name, token } shown once

  const load = useCallback(async () => {
    try { setTokens(await fetchTokens()); } catch (e) { toast.error(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const onCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed) { toast.error('Name the token (e.g. "laptop / claude-code")'); return; }
    setCreating(true);
    try {
      const created = await createToken(trimmed);
      setJustCreated({ name: created.name, token: created.token });
      setName('');
      load();
    } catch (e) { toast.error(e.message); } finally { setCreating(false); }
  };

  const onRevoke = async (id) => {
    try { await revokeToken(id); setTokens((t) => t.filter((x) => x.id !== id)); toast.success('Token revoked'); }
    catch (e) { toast.error(e.message); }
  };

  const copy = (text) => { navigator.clipboard?.writeText(text); toast.success('Copied'); };

  return (
    <div className="rounded-lg border" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}>
      <div className="flex items-center gap-2 px-2.5 py-2 text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
        <KeyRound className="w-3.5 h-3.5" /> CLI Access (Personal Access Tokens)
      </div>

      <div className="px-2.5 pb-2 flex items-center gap-1.5">
        <input
          value={name} onChange={(e) => setName(e.target.value)} placeholder="Token name (e.g. laptop / claude-code)"
          className="flex-1 text-xs rounded px-2 py-1 outline-none"
          style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)', border: '1px solid var(--border-subtle)' }}
        />
        <Button variant="ghost" size="icon" onClick={onCreate} disabled={creating} title="Generate token">
          <Plus className="w-3.5 h-3.5" />
        </Button>
      </div>

      {justCreated && (
        <div className="mx-2.5 mb-2 rounded p-2 text-[11px]" style={{ background: 'var(--bg-elevated)', color: 'var(--text-secondary)' }}>
          <div style={{ color: 'var(--text-muted)' }}>Copy this token now — it is shown only once:</div>
          <div className="flex items-center gap-1.5 mt-1">
            <code className="flex-1 break-all font-mono">{justCreated.token}</code>
            <Button variant="ghost" size="icon" onClick={() => copy(justCreated.token)} title="Copy"><Copy className="w-3.5 h-3.5" /></Button>
          </div>
        </div>
      )}

      <div className="px-2.5 pb-2 flex flex-col gap-1">
        {tokens.length === 0 && <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>No tokens yet.</div>}
        {tokens.map((t) => (
          <div key={t.id} className="flex items-center justify-between text-xs">
            <span className="truncate">
              {t.name} <span className="font-mono" style={{ color: 'var(--text-dim)' }}>…{t.last4}</span>
              {t.revokedAt && <span style={{ color: 'var(--accent-danger, #ff5757)' }}> (revoked)</span>}
            </span>
            {!t.revokedAt && (
              <Button variant="ghost" size="icon" onClick={() => onRevoke(t.id)} title="Revoke"><Trash2 className="w-3.5 h-3.5" /></Button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
