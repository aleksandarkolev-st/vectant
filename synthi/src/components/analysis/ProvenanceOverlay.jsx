'use client';

import React, { useState, useEffect, useCallback } from 'react';

const DEFAULT_AI_ENGINE_BASE = '/api/provenance';

/**
 * AI Change Provenance Overlay
 * 
 * Displays provenance information for AI-generated changes including:
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
    
    // Confirm before reverting
    const confirmed = window.confirm(
      `Revert to this version?\n\n` +
      `This will restore the code to the state from:\n` +
      `${record.timestamp_iso}\n\n` +
      `Change type: ${record.change_type}`
    );
    
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
  }, [apiBaseUrl, actionLoading, onRevert]);

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

  const getStatusColor = (status) => {
    switch (status) {
      case 'passed':
        return 'text-green-600 bg-green-100';
      case 'warned':
        return 'text-yellow-600 bg-yellow-100';
      case 'failed':
        return 'text-red-600 bg-red-100';
      case 'repaired':
        return 'text-blue-600 bg-blue-100';
      default:
        return 'text-gray-600 bg-gray-100';
    }
  };
  
  const isPinned = (record) => pinnedRecords.has(record?.record_id);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white dark:bg-gray-900 rounded-lg shadow-xl max-w-4xl w-full max-h-[80vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b dark:border-gray-700">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            AI Change Provenance
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-4">
          {loading && (
            <div className="flex items-center justify-center py-8">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
            </div>
          )}

          {error && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
              <p className="text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          {!loading && !error && records.length === 0 && (
            <div className="text-center py-8 text-gray-500">
              No provenance records found
            </div>
          )}

          {!loading && !error && selectedRecord && (
            <div className="space-y-4">
              {/* Record selector if multiple */}
              {records.length > 1 && (
                <div className="flex gap-2 overflow-x-auto pb-2">
                  {records.map((record) => (
                    <button
                      key={record.record_id}
                      onClick={() => setSelectedRecord(record)}
                      className={`px-3 py-1 rounded-full text-sm whitespace-nowrap ${
                        selectedRecord.record_id === record.record_id
                          ? 'bg-blue-600 text-white'
                          : 'bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300'
                      }`}
                    >
                      {record.change_type} - {record.record_id.slice(0, 8)}
                    </button>
                  ))}
                </div>
              )}

              {/* Basic Info */}
              <div className="grid grid-cols-2 gap-4">
                <InfoCard title="Change Type" value={selectedRecord.change_type} />
                <InfoCard title="Language" value={selectedRecord.target_language} />
                <InfoCard title="Target File" value={selectedRecord.target_file || 'N/A'} />
                <InfoCard title="Timestamp" value={selectedRecord.timestamp_iso} />
              </div>

              {/* Model Info */}
              {selectedRecord.model_info && (
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
                  <h3 className="font-medium mb-2 text-gray-900 dark:text-gray-100">Model Information</h3>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">Provider:</span>
                      <span className="ml-2 font-mono">{selectedRecord.model_info.provider}</span>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">Model:</span>
                      <span className="ml-2 font-mono">{selectedRecord.model_info.model_name}</span>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">Tokens:</span>
                      <span className="ml-2 font-mono">{selectedRecord.model_info.actual_tokens_used}</span>
                    </div>
                    <div>
                      <span className="text-gray-500 dark:text-gray-400">Latency:</span>
                      <span className="ml-2 font-mono">{selectedRecord.model_info.latency_ms.toFixed(0)}ms</span>
                    </div>
                  </div>
                </div>
              )}

              {/* Verification Info */}
              {selectedRecord.verifier_info && (
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
                  <h3 className="font-medium mb-2 text-gray-900 dark:text-gray-100">Verification Result</h3>
                  <div className="flex items-center gap-2 mb-2">
                    <span className={`px-2 py-1 rounded text-sm font-medium ${getStatusColor(selectedRecord.verifier_info.status)}`}>
                      {selectedRecord.verifier_info.status.toUpperCase()}
                    </span>
                    {selectedRecord.verifier_info.auto_repaired && (
                      <span className="px-2 py-1 rounded text-sm bg-blue-100 text-blue-600">
                        Auto-repaired
                      </span>
                    )}
                    <span className="text-sm text-gray-500">
                      ({selectedRecord.verifier_info.duration_ms.toFixed(1)}ms)
                    </span>
                  </div>
                  
                  {selectedRecord.verifier_info.violations.length > 0 && (
                    <div className="mt-2">
                      <p className="text-sm text-gray-500 dark:text-gray-400 mb-1">Violations:</p>
                      <ul className="list-disc list-inside text-sm text-red-600 dark:text-red-400">
                        {selectedRecord.verifier_info.violations.map((v, i) => (
                          <li key={i}>{v}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  <div className="mt-2 text-xs font-mono text-gray-500 dark:text-gray-400">
                    <div>Original: {selectedRecord.verifier_info.original_hash}</div>
                    <div>Verified: {selectedRecord.verifier_info.verified_hash}</div>
                  </div>
                </div>
              )}

              {/* Prompt Info */}
              {selectedRecord.prompt_info && (
                <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-4">
                  <h3 className="font-medium mb-2 text-gray-900 dark:text-gray-100">Prompt Information</h3>
                  {selectedRecord.prompt_info.user_prompt_preview && (
                    <div className="mb-2">
                      <p className="text-sm text-gray-500 dark:text-gray-400">User prompt preview:</p>
                      <p className="text-sm font-mono bg-gray-100 dark:bg-gray-700 p-2 rounded mt-1">
                        {selectedRecord.prompt_info.user_prompt_preview}...
                      </p>
                    </div>
                  )}
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    <div>Context files: {selectedRecord.prompt_info.context_files.length}</div>
                    <div>Context size: {(selectedRecord.prompt_info.context_size_bytes / 1024).toFixed(1)} KB</div>
                    {selectedRecord.prompt_info.focus_file && (
                      <div>Focus: {selectedRecord.prompt_info.focus_file}</div>
                    )}
                  </div>
                </div>
              )}

              {/* Status */}
              <div className="flex items-center gap-4 pt-2 border-t dark:border-gray-700">
                {selectedRecord.accepted ? (
                  <span className="flex items-center gap-1 text-green-600">
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                    </svg>
                    Accepted
                    {selectedRecord.applied_at && (
                      <span className="text-sm text-gray-500 ml-2">
                        at {formatTime(selectedRecord.applied_at)}
                      </span>
                    )}
                  </span>
                ) : selectedRecord.rejected_reason ? (
                  <span className="flex items-center gap-1 text-red-600">
                    <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" />
                    </svg>
                    Rejected: {selectedRecord.rejected_reason}
                  </span>
                ) : (
                  <span className="text-gray-500">Pending</span>
                )}
              </div>
              
              {/* ============================================================ */}
              {/* ACTION BUTTONS - Rollback, Pin, Revert */}
              {/* ============================================================ */}
              <div className="flex flex-wrap items-center gap-2 pt-4 border-t dark:border-gray-700">
                {/* Rollback Button - One-click undo */}
                <button
                  onClick={() => handleRollback(selectedRecord)}
                  disabled={actionLoading !== null || selectedRecord.rolled_back}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
                    selectedRecord.rolled_back
                      ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                      : 'bg-red-100 text-red-700 hover:bg-red-200 dark:bg-red-900/30 dark:text-red-400 dark:hover:bg-red-900/50'
                  }`}
                >
                  {actionLoading === 'rollback' ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-red-600" />
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
                    </svg>
                  )}
                  {selectedRecord.rolled_back ? 'Rolled Back' : 'Rollback'}
                </button>

                {/* Pin Button - Mark as known-good */}
                <button
                  onClick={() => handlePin(selectedRecord)}
                  disabled={actionLoading !== null || isPinned(selectedRecord)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-colors ${
                    isPinned(selectedRecord)
                      ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700'
                  }`}
                >
                  {actionLoading === 'pin' ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-600" />
                  ) : (
                    <svg className="w-4 h-4" fill={isPinned(selectedRecord) ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                    </svg>
                  )}
                  {isPinned(selectedRecord) ? 'Pinned' : 'Pin as Good'}
                </button>

                {/* Revert Button - Restore to this specific version */}
                <button
                  onClick={() => handleRevert(selectedRecord)}
                  disabled={actionLoading !== null}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg font-medium bg-blue-100 text-blue-700 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-400 dark:hover:bg-blue-900/50 transition-colors"
                >
                  {actionLoading === 'revert' ? (
                    <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600" />
                  ) : (
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  )}
                  Revert to This
                </button>
              </div>

              {/* Action Error Display */}
              {actionError && (
                <div className="mt-2 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg">
                  <p className="text-sm text-red-600 dark:text-red-400">
                    <strong>Action failed:</strong> {actionError}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function InfoCard({ title, value }) {
  return (
    <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
      <p className="text-xs text-gray-500 dark:text-gray-400">{title}</p>
      <p className="font-medium text-gray-900 dark:text-gray-100 truncate">{value}</p>
    </div>
  );
}

export default ProvenanceOverlay;
