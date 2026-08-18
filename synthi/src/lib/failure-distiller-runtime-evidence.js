const MAX_EVENTS = 50;

function append(previous, event) {
  const next = [...previous, event];
  return next.length > MAX_EVENTS ? next.slice(-MAX_EVENTS) : next;
}

function statusFrom(detail) {
  const data = detail?.data || detail || {};
  return typeof data.status === 'string' ? data.status.trim().toLowerCase() : '';
}

function diagnosticFrom(detail) {
  const diagnostics = Array.isArray(detail?.diagnostics) ? detail.diagnostics : [];
  const first = diagnostics.find((item) => item && (item.severity === 'error' || item.severity === 'fatal'));
  if (!first) return null;
  const code = [first.code, first.message, first.text].find((value) => typeof value === 'string' && value.trim());
  const sourceSpan = [first.source_span, first.sourceSpan, first.file, first.path, detail?.module].find((value) => typeof value === 'string' && value.trim());
  return code && sourceSpan ? { code: code.trim(), source_span: sourceSpan.trim() } : null;
}

function gpuEvidence(detail) {
  const data = detail?.data || detail || {};
  const line = typeof data.line === 'string' ? data.line : '';
  const runtime = data.runtimeError || data.runtime_error || {};
  const marker = [data.device_marker, data.deviceMarker, data.device, data.target].find((value) => typeof value === 'string' && value.trim());
  const fingerprint = [data.error_fingerprint, data.errorFingerprint, runtime.kind, line].find((value) => typeof value === 'string' && value.trim());
  if (!marker || !fingerprint) return null;
  const state = [data.lastEvent, data.reloadPlan, runtime.kind, line].find((value) => typeof value === 'string' && value.trim());
  return {
    device_marker: marker.trim(),
    error_fingerprint: fingerprint.trim(),
    frame_state: state?.trim() || null,
    launch_parameters: Object.fromEntries(Object.entries({
      reloadPlan: data.reloadPlan,
      snapshotTier: data.snapshotTier,
      snapshotMs: data.snapshotMs,
    }).filter(([, value]) => value !== null && value !== undefined)),
  };
}

/**
 * Subscribes to the runtime event bus and returns normalized, bounded evidence
 * from actual HMR/compiler/GPU producers. Consumers can call snapshot(kind)
 * immediately before capture; unsupported or incomplete signals remain absent.
 */
export function installFailureDistillerRuntimeEvidence(onChange) {
  const state = { hmr: [], native: [], gpu: [] };
  const publish = () => onChange?.({ ...state, hmr: [...state.hmr], native: [...state.native], gpu: [...state.gpu] });
  const hmr = (event) => {
    const status = statusFrom(event.detail);
    if (!status) return;
    state.hmr = append(state.hmr, status);
    publish();
  };
  const native = (event) => {
    const diagnostic = diagnosticFrom(event.detail);
    if (!diagnostic) return;
    state.native = append(state.native, diagnostic);
    publish();
  };
  const gpu = (event) => {
    const evidence = gpuEvidence(event.detail);
    if (!evidence) return;
    state.gpu = append(state.gpu, evidence);
    publish();
  };
  window.addEventListener('synthi:hmr-status', hmr);
  window.addEventListener('synthi:compile-diagnostics', native);
  window.addEventListener('synthi:gpu-hmr-status', gpu);
  return {
    snapshot(kind) {
      if (kind === 'hmr') return state.hmr.length ? { kind, hmr_events: [...state.hmr] } : null;
      if (kind === 'native') {
        const diagnostic = state.native.at(-1);
        return diagnostic ? { kind, diagnostic, compiler_flags: [] } : null;
      }
      if (kind === 'gpu') {
        const latest = state.gpu.at(-1);
        return latest ? { kind, device_marker: latest.device_marker, error_fingerprint: latest.error_fingerprint, frame_states: state.gpu.map((item) => item.frame_state).filter(Boolean), launch_parameters: latest.launch_parameters } : null;
      }
      return null;
    },
    dispose() {
      window.removeEventListener('synthi:hmr-status', hmr);
      window.removeEventListener('synthi:compile-diagnostics', native);
      window.removeEventListener('synthi:gpu-hmr-status', gpu);
    },
  };
}
