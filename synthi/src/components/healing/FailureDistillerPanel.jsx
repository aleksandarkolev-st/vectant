'use client';

import { useCallback, useState } from 'react';
import { Box, Play, PackageCheck, AlertTriangle, BarChart3, Trash2, Sprout, BadgeCheck, Clock3 } from 'lucide-react';
import { useAnalyzerGateway } from '@/hooks/useAnalyzerGateway';

const inputClass = 'w-full rounded-[var(--radius-control)] border px-2 py-1.5 text-xs outline-none focus:ring-2';

export function FailureDistillerPanel() {
  const gateway = useAnalyzerGateway();
  const [workspaceRoot, setWorkspaceRoot] = useState('');
  const [command, setCommand] = useState('');
  const [signature, setSignature] = useState('');
  const [observationKind, setObservationKind] = useState('command');
  const [observationFile, setObservationFile] = useState('');
  const [adapterRecording, setAdapterRecording] = useState('');
  const [containerImage, setContainerImage] = useState('');
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

  const distill = useCallback(() => {
    let recording = {};
    try {
      recording = adapterRecording.trim() ? JSON.parse(adapterRecording) : {};
    } catch {
      setError('Adapter recording must be valid JSON.');
      return;
    }
    if (observationKind !== 'command' && Object.keys(recording).length === 0) {
      setError(`${observationKind.toUpperCase()} distillation requires its recorded adapter evidence.`);
      return;
    }
    return execute(() => gateway.distillFailure({
      workspaceRoot: workspaceRoot.trim(),
      command: command.trim(),
      signature: signature.trim() ? { required: [signature.trim()] } : {},
      observation: { kind: observationKind, ...(observationFile.trim() ? { filePath: observationFile.trim() } : {}), ...recording },
      isolation: { mode: 'container', engine: 'docker', image: containerImage.trim() },
      budget: { preset: budget }, autoDiscover: true, networkPolicy: 'deny',
    }));
  }, [adapterRecording, budget, command, containerImage, execute, gateway, observationFile, observationKind, signature, workspaceRoot]);

  const deleteCapsule = useCallback(() => {
    if (!capsule?.workspacePath || !window.confirm('Permanently delete this capsule and its materialized contents? This cannot be undone.')) return;
    execute(async () => {
      const result = await gateway.deleteFailureCapsule(capsule.workspacePath);
      if (result?.ok) setCapsule(null);
      return result;
    });
  }, [capsule, execute, gateway]);

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
        <label className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>Isolated runtime image
          <input value={containerImage} onChange={(event) => setContainerImage(event.target.value)} placeholder="python:3.12-slim or node:22-bookworm" className={inputClass} style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }} />
          <span className="mt-1 block" style={{ color: 'var(--text-muted)' }}>Runs with outbound network, package installation, and lifecycle scripts denied.</span>
        </label>
        <label className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>Failure signature regex (optional)
          <input value={signature} onChange={(event) => setSignature(event.target.value)} placeholder="InviteModal.onSubmit" className={inputClass} style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>Observed via
            <select value={observationKind} onChange={(event) => setObservationKind(event.target.value)} className="mt-1 w-full rounded-[var(--radius-control)] border px-2 py-1 text-xs" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }}>
              <option value="command">Command/test</option><option value="hmr">HMR</option><option value="browser">Browser</option><option value="native">Native</option><option value="gpu">GPU</option>
            </select>
          </label>
          <label className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>Observed source file (optional)
            <input value={observationFile} onChange={(event) => setObservationFile(event.target.value)} placeholder="src/InviteModal.tsx" className={inputClass} style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }} />
          </label>
        </div>
        {observationKind !== 'command' ? <label className="block text-[10px]" style={{ color: 'var(--text-muted)' }}>Recorded {observationKind} evidence (JSON)
          <textarea value={adapterRecording} onChange={(event) => setAdapterRecording(event.target.value)} placeholder={observationKind === 'browser' ? '{"workflow":{"route":"/invite","viewport":{"width":1280,"height":720},"steps":["submit"],"network_sequence":[],"dom_transitions":["modal closed"],"source_events":["InviteModal.onSubmit"]}}' : 'Paste the validated adapter recording'} rows={4} className={`${inputClass} font-mono`} style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }} />
        </label> : null}
        <div className="flex items-center gap-2">
          <select value={budget} onChange={(event) => setBudget(event.target.value)} className="rounded-[var(--radius-control)] border px-2 py-1 text-xs" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }}>
            <option value="fast">Fast</option><option value="standard">Standard</option><option value="deep">Deep</option>
          </select>
          <button type="button" disabled={busy || !workspaceRoot.trim() || !command.trim() || !containerImage.trim()} onClick={distill} className="th-focus-ring flex items-center gap-1 rounded-[var(--radius-control)] px-2 py-1 text-xs disabled:opacity-50" style={{ background: 'var(--accent-primary)', color: 'var(--bg-app)' }}>
            <Play size={12} /> Distill
          </button>
          {capsule?.workspacePath ? <button type="button" disabled={busy} onClick={() => execute(() => gateway.runFailureCapsule(capsule.workspacePath))} className="th-focus-ring rounded-[var(--radius-control)] border px-2 py-1 text-xs disabled:opacity-50" style={{ borderColor: 'var(--border-subtle)' }}>Replay</button> : null}
          {capsule?.workspacePath ? <button type="button" disabled={busy} onClick={() => execute(() => gateway.materializeFailureCapsule({ capsulePath: capsule.workspacePath }))} className="th-focus-ring flex items-center gap-1 rounded-[var(--radius-control)] border px-2 py-1 text-xs disabled:opacity-50" style={{ borderColor: 'var(--border-subtle)' }}><PackageCheck size={12} /> Materialize</button> : null}
          {capsule?.workspacePath ? <button type="button" disabled={busy} onClick={() => execute(() => gateway.exportFailureCapsuleToVivarium(capsule.workspacePath))} className="th-focus-ring flex items-center gap-1 rounded-[var(--radius-control)] border px-2 py-1 text-xs disabled:opacity-50" style={{ borderColor: 'var(--accent-info)' }}><Sprout size={12} /> Vivarium</button> : null}
          {capsule?.workspacePath ? <button type="button" disabled={busy} onClick={() => execute(() => gateway.promoteFailureCapsuleToVivarium(capsule.workspacePath))} className="th-focus-ring flex items-center gap-1 rounded-[var(--radius-control)] border px-2 py-1 text-xs disabled:opacity-50" style={{ borderColor: 'var(--accent-info)' }}><BadgeCheck size={12} /> Promote</button> : null}
          {capsule?.workspacePath ? <button type="button" disabled={busy} onClick={deleteCapsule} className="th-focus-ring flex items-center gap-1 rounded-[var(--radius-control)] border px-2 py-1 text-xs disabled:opacity-50" style={{ borderColor: 'var(--accent-danger)', color: 'var(--accent-danger)' }}><Trash2 size={12} /> Delete</button> : null}
          <button type="button" disabled={busy || !workspaceRoot.trim()} onClick={() => execute(() => gateway.purgeExpiredFailureCapsules(workspaceRoot.trim()))} className="th-focus-ring flex items-center gap-1 rounded-[var(--radius-control)] border px-2 py-1 text-xs disabled:opacity-50" style={{ borderColor: 'var(--border-subtle)' }}><Clock3 size={12} /> Purge expired</button>
          <button type="button" disabled={busy} onClick={() => execute(() => gateway.getFailureDistillerMetrics())} className="th-focus-ring flex items-center gap-1 rounded-[var(--radius-control)] border px-2 py-1 text-xs disabled:opacity-50" style={{ borderColor: 'var(--border-subtle)' }}><BarChart3 size={12} /> Metrics</button>
        </div>
      </div>
      {error ? <div className="mt-2 flex gap-1 text-[10px]" style={{ color: 'var(--accent-danger)' }}><AlertTriangle size={12} />{error}</div> : null}
      {outcome ? <div className="mt-2 rounded border p-2 text-[10px]" style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-editor)' }}>
        <div className="font-medium" style={{ color: 'var(--text-secondary)' }}>{outcome.status || 'completed'}</div>
        {outcome.capsuleId ? <div className="font-mono" style={{ color: 'var(--text-muted)' }}>{outcome.capsuleId}</div> : null}
        {outcome.reduction ? <div style={{ color: 'var(--text-muted)' }}>{outcome.reduction.removed_units} removed, {outcome.reduction.retained_units} retained</div> : null}
        {outcome.metrics ? <div style={{ color: 'var(--text-muted)' }}>{outcome.metrics.accepted_capsules} capsules, {Math.round((outcome.metrics.reduction_ratio || 0) * 100)}% unit reduction, {outcome.metrics.validated_patches} validated patches</div> : null}
        {outcome.scenarioId ? <div style={{ color: 'var(--text-muted)' }}>Vivarium handoff: {outcome.scenarioId}</div> : null}
        {outcome.promotionId ? <div style={{ color: 'var(--text-muted)' }}>Vivarium promotion: {outcome.promotionId}</div> : null}
      </div> : null}
    </section>
  );
}

export default FailureDistillerPanel;
