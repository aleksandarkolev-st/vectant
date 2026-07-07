'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useConfirmDialog } from '@/components/ui/useConfirmDialog';
import { Bookmark, CheckCircle2, Loader2, RotateCcw, Undo2, X, XCircle } from 'lucide-react';

const DEFAULT_AI_ENGINE_BASE = '/api/provenance';

const sectionStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 78%, transparent)',
};

const mutedCardStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-editor) 72%, transparent)',
};

function statusTone(status) {
  switch (status) {
    case 'passed':
      return 'var(--accent-success)';
    case 'warned':
      return 'var(--accent-warning)';
    case 'failed':
      return 'var(--accent-danger)';
    case 'repaired':
      return 'var(--accent-secondary)';
    default:
      return 'var(--text-muted)';
  }
}

function badgeStyle(accent) {
  return {
    color: accent,
    borderColor: `color-mix(in srgb, ${accent} 32%, transparent)`,
    background: `color-mix(in srgb, ${accent} 10%, transparent)`,
  };
}

/**
 * Change Provenance Overlay
 * 
 * Displays provenance information for generated changes including:
 * - Prompt used
 * - Model information
 * - Verification status
 * - Change history
 * 
 * NOW WITH ACTION HOOKS:
 * - One-click rollback to previous state
 * - Pin known-good outputs
 * - Revert to specific versions
 */

export function ProvenanceOverlay({
  recordId,
  filePath,
  isOpen,
  onClose,
  apiBaseUrl = DEFAULT_AI_ENGINE_BASE,
  onRollback,      // Callback when rollback is requested
  onPin,           // Callback when output is pinned
  onRevert,        // Callback when specific version revert is requested
}) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);  // Track which action is loading
  const [actionError, setActionError] = useState(null);
  const [pinnedRecords, setPinnedRecords] = useState(new Set());
  const { confirm, confirmDialog } = useConfirmDialog();

  // ==========================================================================
  // ACTION HANDLERS - One-click rollback, pin, revert
  // ==========================================================================
  
  const handleRollback = useCallback(async (record) => {
    if (!record || actionLoading) return;
    
    setActionLoading('rollback');
    setActionError(null);
    
    try {
      // Call API to rollback
      const response = await fetch(`${apiBaseUrl}/${record.record_id}/rollback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || 'Rollback failed');
      }
      
      const result = await response.json();
      
      // Call parent callback if provided
      if (onRollback) {
        onRollback(record, result);
      }
      
      // Refresh records
      setRecords(prev => prev.map(r => 
        r.record_id === record.record_id 
          ? { ...r, rolled_back: true, rolled_back_at: Date.now() / 1000 }
          : r
      ));
      
    } catch (e) {
      setActionError(e.message);
    } finally {
      setActionLoading(null);
    }
  }, [apiBaseUrl, actionLoading, onRollback]);

  const handlePin = useCallback(async (record) => {
    if (!record || actionLoading) return;
    
    setActionLoading('pin');
    setActionError(null);
    
    try {
      const response = await fetch(`${apiBaseUrl}/${record.record_id}/pin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || 'Pin failed');
      }
      
      setPinnedRecords(prev => new Set([...prev, record.record_id]));
      
      if (onPin) {
        onPin(record);
      }
      
    } catch (e) {
      setActionError(e.message);
    } finally {
      setActionLoading(null);
    }
  }, [apiBaseUrl, actionLoading, onPin]);

  const handleRevert = useCallback(async (record) => {
    if (!record || actionLoading) return;
    
    const confirmed = await confirm({
      title: 'Revert to this version?',
      message: `This restores the code to ${record.timestamp_iso}.\nChange type: ${record.change_type}`,
      confirmLabel: 'Revert version',
      tone: 'danger',
    });
    
    if (!confirmed) return;
    
    setActionLoading('revert');
    setActionError(null);
    
    try {
      const response = await fetch(`${apiBaseUrl}/${record.record_id}/revert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      
      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.detail || 'Revert failed');
      }
      
      const result = await response.json();
      
      if (onRevert) {
        onRevert(record, result);
      }
      
    } catch (e) {
      setActionError(e.message);
    } finally {
      setActionLoading(null);
    }
  }, [apiBaseUrl, actionLoading, confirm, onRevert]);

  useEffect(() => {
    if (!isOpen) return;

    const fetchRecords = async () => {
      setLoading(true);
      setError(null);

      try {
        let url;
        if (recordId) {
          url = `${apiBaseUrl}/${recordId}`;
          const response = await fetch(url);
          if (!response.ok) throw new Error('Failed to fetch provenance');
          const data = await response.json();
          setRecords([data]);
          setSelectedRecord(data);
        } else if (filePath) {
          url = `${apiBaseUrl}/file/${encodeURIComponent(filePath)}`;
          const response = await fetch(url);
          if (!response.ok) throw new Error('Failed to fetch provenance');
          const data = await response.json();
          setRecords(data);
          if (data.length > 0) setSelectedRecord(data[0]);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Unknown error');
      } finally {
        setLoading(false);
      }
    };

    fetchRecords();
  }, [isOpen, recordId, filePath, apiBaseUrl]);

  if (!isOpen) return null;

  const formatTime = (timestamp) => {
    return new Date(timestamp * 1000).toLocaleString();
  };

  const isPinned = (record) => pinnedRecords.has(record?.record_id);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-3 backdrop-blur-sm"
      style={{ background: 'color-mix(in srgb, var(--bg-app) 72%, transparent)' }}
    >
      <div className="vt-dialog-surface flex max-h-[84vh] w-[920px] max-w-full flex-col overflow-hidden">
        <div aria-hidden="true" className="h-px w-full" style={{ background: 'var(--brand-gradient-horizontal)' }} />
        <div className="flex items-center gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              Change provenance
            </h2>
            <p className="mt-0.5 truncate text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {filePath || selectedRecord?.target_file || 'Workspace change ledger'}
            </p>
          </div>
              <span
                className="rounded-[var(--radius-control)] border px-2 py-1 text-[10px] font-semibold uppercase tracking-wide"
            style={badgeStyle('var(--attention-purple)')}
          >
            audit trail
          </span>
          <button
            onClick={onClose}
            className="vt-icon-button th-focus-ring"
            aria-label="Close provenance overlay"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="flex-1 overflow-auto p-4">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-10" style={{ color: 'var(--text-secondary)' }}>
              <Loader2 className="h-4 w-4 animate-spin" />
              <span className="text-xs">Opening audit ledger...</span>
            </div>
          )}

          {error && (
            <div className="rounded-[var(--radius-panel)] border p-3" style={badgeStyle('var(--accent-danger)')}>
              <p className="text-xs font-medium">{error}</p>
            </div>
          )}

          {!loading && !error && records.length === 0 && (
            <div className="vt-empty-state rounded-[var(--radius-panel)] border px-4 py-10 text-center text-xs" style={mutedCardStyle}>
              No recorded changes for this scope.
            </div>
          )}

          {!loading && !error && selectedRecord && (
            <div className="space-y-4">
              {records.length > 1 && (
                <div className="flex gap-2 overflow-x-auto pb-2">
                  {records.map((record) => (
                    <button
                      key={record.record_id}
                      onClick={() => setSelectedRecord(record)}
                      className="th-focus-ring rounded-[var(--radius-control)] border px-3 py-1.5 text-[11px] font-medium whitespace-nowrap"
                      style={selectedRecord.record_id === record.record_id
                        ? badgeStyle('var(--accent-primary)')
                        : { borderColor: 'var(--border-subtle)', color: 'var(--text-secondary)', background: 'transparent' }}
                    >
                      {record.change_type} - {record.record_id.slice(0, 8)}
                    </button>
                  ))}
                </div>
              )}

              <div className="grid overflow-hidden rounded-[var(--radius-panel)] border sm:grid-cols-2 lg:grid-cols-4" style={mutedCardStyle}>
                <InfoCard title="Change Type" value={selectedRecord.change_type} />
                <InfoCard title="Language" value={selectedRecord.target_language} />
                <InfoCard title="Target File" value={selectedRecord.target_file || 'N/A'} />
                <InfoCard title="Timestamp" value={selectedRecord.timestamp_iso} />
              </div>

              {selectedRecord.model_info && (
                <div className="rounded-[var(--radius-panel)] border border-l-2 p-4" style={{ ...sectionStyle, borderLeftColor: 'var(--accent-primary)' }}>
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Runtime
                  </h3>
                  <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>Provider</span>
                      <div className="mt-1 font-mono" style={{ color: 'var(--text-primary)' }}>{selectedRecord.model_info.provider}</div>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>Model</span>
                      <div className="mt-1 truncate font-mono" style={{ color: 'var(--text-primary)' }}>{selectedRecord.model_info.model_name}</div>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>Tokens</span>
                      <div className="mt-1 font-mono" style={{ color: 'var(--text-primary)' }}>{selectedRecord.model_info.actual_tokens_used}</div>
                    </div>
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>Latency</span>
                      <div className="mt-1 font-mono" style={{ color: 'var(--text-primary)' }}>{selectedRecord.model_info.latency_ms.toFixed(0)}ms</div>
                    </div>
                  </div>
                </div>
              )}

              {selectedRecord.verifier_info && (
                <div className="rounded-[var(--radius-panel)] border border-l-2 p-4" style={{ ...sectionStyle, borderLeftColor: statusTone(selectedRecord.verifier_info.status) }}>
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Verification
                  </h3>
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className="rounded-[var(--radius-control)] border px-2 py-1 text-[11px] font-semibold uppercase tracking-wide"
                      style={badgeStyle(statusTone(selectedRecord.verifier_info.status))}
                    >
                      {selectedRecord.verifier_info.status.toUpperCase()}
                    </span>
                    {selectedRecord.verifier_info.auto_repaired && (
                      <span className="rounded-[var(--radius-control)] border px-2 py-1 text-[11px] font-semibold" style={badgeStyle('var(--accent-secondary)')}>
                        Auto-repaired
                      </span>
                    )}
                    <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      ({selectedRecord.verifier_info.duration_ms.toFixed(1)}ms)
                    </span>
                  </div>
                  
                  {selectedRecord.verifier_info.violations.length > 0 && (
                    <div className="mt-2">
                      <p className="mb-1 text-xs" style={{ color: 'var(--text-muted)' }}>Violations</p>
                      <ul className="list-disc list-inside text-xs" style={{ color: 'var(--accent-danger)' }}>
                        {selectedRecord.verifier_info.violations.map((v, i) => (
                          <li key={i}>{v}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="mt-3 grid gap-1 rounded-[var(--radius-control)] border p-2 text-[11px] font-mono" style={mutedCardStyle}>
                    <div>Original: {selectedRecord.verifier_info.original_hash}</div>
                    <div>Verified: {selectedRecord.verifier_info.verified_hash}</div>
                  </div>
                </div>
              )}

              {selectedRecord.prompt_info && (
                <div className="rounded-[var(--radius-panel)] border border-l-2 p-4" style={{ ...sectionStyle, borderLeftColor: 'var(--attention-purple)' }}>
                  <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    Request context
                  </h3>
                  {selectedRecord.prompt_info.user_prompt_preview && (
                    <div className="mb-2">
                      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>Operator request preview</p>
                      <p className="mt-1 rounded-[var(--radius-control)] border p-2 text-xs font-mono" style={mutedCardStyle}>
                        {selectedRecord.prompt_info.user_prompt_preview}...
                      </p>
                    </div>
                  )}
                  <div className="grid gap-1 text-xs" style={{ color: 'var(--text-secondary)' }}>
                    <div>Context files: {selectedRecord.prompt_info.context_files.length}</div>
                    <div>Context size: {(selectedRecord.prompt_info.context_size_bytes / 1024).toFixed(1)} KB</div>
                    {selectedRecord.prompt_info.focus_file && (
                      <div>Focus: {selectedRecord.prompt_info.focus_file}</div>
                    )}
                  </div>
                </div>
              )}

              <div className="flex items-center gap-4 border-t pt-3" style={{ borderColor: 'var(--border-subtle)' }}>
                {selectedRecord.accepted ? (
                  <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--accent-success)' }}>
                    <CheckCircle2 className="h-4 w-4" />
                    Accepted
                    {selectedRecord.applied_at && (
                      <span className="ml-2" style={{ color: 'var(--text-muted)' }}>
                        at {formatTime(selectedRecord.applied_at)}
                      </span>
                    )}
                  </span>
                ) : selectedRecord.rejected_reason ? (
                  <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--accent-danger)' }}>
                    <XCircle className="h-4 w-4" />
                    Rejected: {selectedRecord.rejected_reason}
                  </span>
                ) : (
                  <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Pending</span>
                )}
              </div>
              
              <div className="flex flex-wrap items-center gap-2 border-t pt-4" style={{ borderColor: 'var(--border-subtle)' }}>
                <button
                  onClick={() => handleRollback(selectedRecord)}
                  disabled={actionLoading !== null || selectedRecord.rolled_back}
                  className="th-focus-ring flex h-8 items-center gap-2 rounded-[var(--radius-control)] border px-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                  style={badgeStyle('var(--accent-danger)')}
                >
                  {actionLoading === 'rollback' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Undo2 className="h-3.5 w-3.5" />
                  )}
                  {selectedRecord.rolled_back ? 'Rolled Back' : 'Rollback'}
                </button>

                <button
                  onClick={() => handlePin(selectedRecord)}
                  disabled={actionLoading !== null || isPinned(selectedRecord)}
                  className="th-focus-ring flex h-8 items-center gap-2 rounded-[var(--radius-control)] border px-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                  style={isPinned(selectedRecord) ? badgeStyle('var(--accent-warning)') : { borderColor: 'var(--border-medium)', color: 'var(--text-secondary)', background: 'transparent' }}
                >
                  {actionLoading === 'pin' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Bookmark className="h-3.5 w-3.5" fill={isPinned(selectedRecord) ? 'currentColor' : 'none'} />
                  )}
                  {isPinned(selectedRecord) ? 'Pinned' : 'Pin'}
                </button>

                <button
                  onClick={() => handleRevert(selectedRecord)}
                  disabled={actionLoading !== null}
                  className="th-focus-ring flex h-8 items-center gap-2 rounded-[var(--radius-control)] border px-3 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50"
                  style={badgeStyle('var(--accent-secondary)')}
                >
                  {actionLoading === 'revert' ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RotateCcw className="h-3.5 w-3.5" />
                  )}
                  Revert
                </button>
              </div>

              {actionError && (
                <div className="mt-2 rounded-[var(--radius-panel)] border p-3" style={badgeStyle('var(--accent-danger)')}>
                  <p className="text-xs">
                    <strong>Action failed:</strong> {actionError}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
      {confirmDialog}
    </div>
  );
}

function InfoCard({ title, value }) {
  return (
    <div className="min-w-0 border-b border-r p-3 last:border-r-0 sm:[&:nth-child(2n)]:border-r-0 lg:[&:nth-child(2n)]:border-r lg:[&:nth-child(4n)]:border-r-0 lg:border-b-0" style={{ borderColor: 'var(--border-subtle)' }}>
      <p className="text-[10px] font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{title}</p>
      <p className="mt-1 truncate text-xs font-mono" style={{ color: 'var(--text-primary)' }}>{value}</p>
    </div>
  );
}

export default ProvenanceOverlay;
