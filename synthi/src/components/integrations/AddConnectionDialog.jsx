'use client';

import { useState } from 'react';
import { Plug, Eye, EyeOff } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from 'sonner';
import { createConnection } from './integrationsClient';

export default function AddConnectionDialog({ workspaceSlug, onCreated }) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [form, setForm] = useState({
    name: '', url: '', transport: 'http', scope: 'personal', authType: 'none', headerName: '', secret: '',
  });

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async () => {
    if (!form.name.trim() || !form.url.trim()) {
      toast.error('Name and URL are required');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        name: form.name.trim(),
        url: form.url.trim(),
        transport: form.transport,
        scope: form.scope,
        workspaceSlug: form.scope === 'workspace' ? workspaceSlug : null,
        authType: form.authType,
        headerName: form.authType === 'header' ? form.headerName.trim() : null,
        secret: form.authType === 'none' ? null : form.secret.trim(),
      };
      const created = await createConnection(payload);
      toast.success(`Connected "${created.name}". Review its tools to enable them.`);
      setOpen(false);
      setForm({ name: '', url: '', transport: 'http', scope: 'personal', authType: 'none', headerName: '', secret: '' });
      onCreated?.(created);
    } catch (e) {
      toast.error(e.message);
    } finally {
      setSaving(false);
    }
  };

  const labelCls = 'text-[11px] uppercase tracking-wider';
  const labelStyle = { color: 'var(--text-muted)' };
  const fieldStyle = {
    background: 'var(--bg-input, var(--bg-editor))',
    borderColor: 'var(--border-subtle)',
    color: 'var(--text-primary)',
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5">
          <Plug className="w-3.5 h-3.5" /> Add connection
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect a tool (MCP server)</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-3 py-1">
          <div className="flex flex-col gap-1">
            <span className={labelCls} style={labelStyle}>Name</span>
            <Input value={form.name} onChange={set('name')} placeholder="e.g. GitHub" />
          </div>

          <div className="flex flex-col gap-1">
            <span className={labelCls} style={labelStyle}>Server URL (https)</span>
            <Input value={form.url} onChange={set('url')} placeholder="https://example.com/mcp" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <span className={labelCls} style={labelStyle}>Transport</span>
              <select value={form.transport} onChange={set('transport')}
                className="h-9 rounded-md border px-2 text-sm" style={fieldStyle}>
                <option value="http">Streamable HTTP</option>
                <option value="sse">SSE</option>
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <span className={labelCls} style={labelStyle}>Scope</span>
              <select value={form.scope} onChange={set('scope')}
                className="h-9 rounded-md border px-2 text-sm" style={fieldStyle}>
                <option value="personal">Personal</option>
                <option value="workspace" disabled={!workspaceSlug}>Workspace</option>
              </select>
            </div>
          </div>

          <div className="flex flex-col gap-1">
            <span className={labelCls} style={labelStyle}>Auth</span>
            <select value={form.authType} onChange={set('authType')}
              className="h-9 rounded-md border px-2 text-sm" style={fieldStyle}>
              <option value="none">None</option>
              <option value="bearer">Bearer token</option>
              <option value="header">Custom header</option>
            </select>
          </div>

          {form.authType === 'header' && (
            <div className="flex flex-col gap-1">
              <span className={labelCls} style={labelStyle}>Header name</span>
              <Input value={form.headerName} onChange={set('headerName')} placeholder="X-Api-Key" />
            </div>
          )}

          {form.authType !== 'none' && (
            <div className="flex flex-col gap-1">
              <span className={labelCls} style={labelStyle}>Secret</span>
              <div className="relative">
                <Input type={showSecret ? 'text' : 'password'} value={form.secret} onChange={set('secret')}
                  placeholder="Token / key (stored encrypted)" className="pr-8 font-mono" />
                <button type="button" onClick={() => setShowSecret((v) => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 opacity-60 hover:opacity-90">
                  {showSecret ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
