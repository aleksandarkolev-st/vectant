'use client';

import { useCallback, useState } from 'react';
import { Box, Play, PackageCheck, AlertTriangle } from 'lucide-react';
import { useAnalyzerGateway } from '@/hooks/useAnalyzerGateway';

const inputClass = 'w-full rounded-[var(--radius-control)] border px-2 py-1.5 text-xs outline-none focus:ring-2';

export function FailureDistillerPanel() {
  const gateway = useAnalyzerGateway();
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [command, setCommand] = useState('');
  const [signature, setSignature] = useState('');
  const [budget, setBudget] = useState('standard');
  const [capsule, setCapsule] = useState(null);
  const [outcome, setOutcome] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const execute = useCallback(async (action) => {
    setBusy(true);
    setError(null);
    try {
      const result = await action();
      setOutcome(result);
      if (result?.workspacePath) setCapsule(result);
      if (!result?.ok) setError(result?.reason || result?.status || 'The operation did not complete.');
    } catch (cause) {
      setError(cause?.message || 'The gateway request failed.');
    } finally {
      setBusy(false);
    }
  }, []);

  const distill = useCallback(() => execute(() => gateway.distillFailure({
    workspaceRoot: workspaceRoot.trim(),
    command: command.trim() ? command.trim().split(/\s+/) : [],
    signature: signature.trim() ? { required: [signature.trim()] } : {},
    budget: { preset: budget },
    autoDiscover: true,
    networkPolicy: 'deny',
  })), [budget, command, execute, gateway, signature, workspaceRoot]);

  return (
    <section className="border-t p-3" style={{ borderColor: 'var(--border-subtle)' }} data-testid="failure-distiller-panel">
      <div className="mb-2 flex items-center gap-2">
        <Box size={15} style={{ color: 'var(--accent-info)' }} />
        <div>
          <h3 className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Failure Distiller</h3>
          <p className="text-[10px]" style={{ color: 'var(--text-muted)' }}>Create an evidence-backed debugging capsule. Source is never edited.</p>
        </div>
      </div>
      <div className="space-y-2">
        <label className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>Workspace root
          <input value={workspaceRoot} onChange={(event) => setWorkspaceRoot(event.target.value)} placeholder="C:\\project" className={inputClass} style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }} />
        </label>
        <label className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>Failing command
          <input value={command} onChange={(event) => setCommand(event.target.value)} placeholder="pytest tests/test_invite.py" className={inputClass} style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }} />
        </label>
        <label className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>Failure signature regex (optional)
          <input value={signature} onChange={(event) => setSignature(event.target.value)} placeholder="InviteModal.onSubmit" className={inputClass} style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }} />
        </label>
        <div className="flex items-center gap-2">
          <select value={budget} onChange={(event) => setBudget(event.target.value)} className="rounded-[var(--radius-control)] border px-2 py-1 text-xs" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }}>
            <option value="fast">Fast</option><option value="standard">Standard</option><option value="deep">Deep</option>
          </select>
          <button type="button" disabled={busy || !workspaceRoot.trim() || !command.trim()} onClick={distill} className="th-focus-ring flex items-center gap-1 rounded-[var(--radius-control)] px-2 py-1 text-xs disabled:opacity-50" style={{ background: 'var(--accent-primary)', color: 'var(--bg-app)' }}>
            <Play size={12} /> Distill
          </button>
          {capsule?.workspacePath ? <button type="button" disabled={busy} onClick={() => execute(() => gateway.runFailureCapsule(capsule.workspacePath))} className="th-focus-ring rounded-[var(--radius-control)] border px-2 py-1 text-xs disabled:opacity-50" style={{ borderColor: 'var(--border-subtle)' }}>Replay</button> : null}
          {capsule?.workspacePath ? <button type="button" disabled={busy} onClick={() => execute(() => gateway.materializeFailureCapsule({ capsulePath: capsule.workspacePath }))} className="th-focus-ring flex items-center gap-1 rounded-[var(--radius-control)] border px-2 py-1 text-xs disabled:opacity-50" style={{ borderColor: 'var(--border-subtle)' }}><PackageCheck size={12} /> Materialize</button> : null}
        </div>
      </div>
      {error ? <div className="mt-2 flex gap-1 text-[10px]" style={{ color: 'var(--accent-danger)' }}><AlertTriangle size={12} />{error}</div> : null}
      {outcome ? <div className="mt-2 rounded border p-2 text-[10px]" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }}>
        <div className="font-medium" style={{ color: 'var(--text-secondary)' }}>{outcome.status || 'completed'}</div>
        {outcome.capsuleId ? <div className="font-mono" style={{ color: 'var(--text-muted)' }}>{outcome.capsuleId}</div> : null}
        {outcome.reduction ? <div style={{ color: 'var(--text-muted)' }}>{outcome.reduction.removed_units} removed, {outcome.reduction.retained_units} retained</div> : null}
      </div> : null}
    </section>
  );
}

export default FailureDistillerPanel;
