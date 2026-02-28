// src/components/healing/AIHealingPanel.jsx
// Main panel for AI-powered healing.  Shows pending AI fixes,
// controls for triggering analysis, and bulk actions.
//
// Intended to sit beside the editor — similar to HealingPendingPanel
// but focused on the richer AI-detected fixes.
'use client';

import { useCallback, useMemo, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import {
  selectAIEnabled,
  selectAIMode,
  selectAIAnalyzing,
} from '@/redux/healingSelectors';
import {
  setAIEnabled,
  setAIMode,
  enqueueToast,
} from '@/redux/healingSlice';
import {
  Sparkles,
  RefreshCcw,
  CheckCheck,
  Trash2,
  Settings2,
  ChevronDown,
} from 'lucide-react';
import { AIFixCard } from './AIFixCard';
import { AIConfidenceGate } from './AIConfidenceGate';


/**
 * @param {Object}  props
 * @param {Object}  props.aiHealing  – object from useAIHealing()
 */
export function AIHealingPanel({ aiHealing }) {
  const dispatch = useDispatch();
  const aiEnabled = useSelector(selectAIEnabled);
  const aiMode = useSelector(selectAIMode);
  const isAnalyzing = aiHealing?.isAnalyzing ?? false;

  const [showSettings, setShowSettings] = useState(false);
  const [minConfidence, setMinConfidence] = useState(0.55);
  const [validateFixes, setValidateFixes] = useState(true);

  const fixes = aiHealing?.fixes ?? [];
  const fixCount = fixes.length;
  const safeCount = fixes.filter((f) => f.is_safe || f.isSafe).length;
  const error = aiHealing?.error;

  // ── Trigger analysis ────────────────────────────────────────────────
  const handleAnalyze = useCallback(() => {
    aiHealing?.analyze({ minConfidence, validateFixes });
  }, [aiHealing, minConfidence, validateFixes]);

  // ── Apply all safe ──────────────────────────────────────────────────
  const handleApplyAllSafe = useCallback(() => {
    const count = aiHealing?.applyAllSafe?.() ?? 0;
    if (count === 0) {
      dispatch(enqueueToast({
        message: 'No safe AI fixes to apply',
        type: 'info',
      }));
    }
  }, [aiHealing, dispatch]);

  // ── Dismiss all ─────────────────────────────────────────────────────
  const handleDismissAll = useCallback(() => {
    aiHealing?.dismissAll?.();
  }, [aiHealing]);

  // ── Toggle enable/disable ───────────────────────────────────────────
  const handleToggleEnabled = useCallback(() => {
    dispatch(setAIEnabled(!aiEnabled));
  }, [dispatch, aiEnabled]);

  // ── Mode switch ─────────────────────────────────────────────────────
  const handleModeChange = useCallback((e) => {
    dispatch(setAIMode(e.target.value));
  }, [dispatch]);

  if (!aiEnabled) {
    return (
      <div className="p-4 text-center text-white/40 text-sm">
        <Sparkles size={20} className="mx-auto mb-2 text-white/20" />
        <p>AI Healing is disabled</p>
        <button
          onClick={handleToggleEnabled}
          className="mt-2 text-xs text-blue-400 hover:text-blue-300 underline"
        >
          Enable
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-between p-3 border-b border-white/10">
        <div className="flex items-center gap-2">
          <Sparkles size={16} className="text-purple-400" />
          <span className="text-sm font-medium text-white/90">AI Healing</span>
          {fixCount > 0 && (
            <span className="text-[10px] bg-purple-500/20 text-purple-300 px-1.5 py-0.5 rounded-full">
              {fixCount}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setShowSettings((s) => !s)}
            className="p-1 rounded hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors"
            title="Settings"
          >
            <Settings2 size={14} />
          </button>
          <button
            onClick={handleToggleEnabled}
            className="p-1 rounded hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors"
            title="Disable AI Healing"
          >
            <span className="text-[10px]">OFF</span>
          </button>
        </div>
      </div>

      {/* ── Settings drawer ─────────────────────────────────────── */}
      {showSettings && (
        <div className="p-3 border-b border-white/10 bg-white/5 space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <label className="text-white/60">Mode</label>
            <select
              value={aiMode}
              onChange={handleModeChange}
              className="bg-white/10 text-white/80 text-xs px-2 py-1 rounded border border-white/10"
            >
              <option value="ai">AI only</option>
              <option value="hybrid">Hybrid (regex + AI)</option>
            </select>
          </div>
          <div className="flex items-center justify-between">
            <label className="text-white/60">Min confidence</label>
            <input
              type="range"
              min={0.3}
              max={0.95}
              step={0.05}
              value={minConfidence}
              onChange={(e) => setMinConfidence(parseFloat(e.target.value))}
              className="w-24 accent-purple-500"
            />
            <span className="text-white/50 font-mono w-10 text-right">
              {Math.round(minConfidence * 100)}%
            </span>
          </div>
          <div className="flex items-center justify-between">
            <label className="text-white/60">Validate fixes (2nd LLM pass)</label>
            <input
              type="checkbox"
              checked={validateFixes}
              onChange={(e) => setValidateFixes(e.target.checked)}
              className="accent-purple-500"
            />
          </div>
        </div>
      )}

      {/* ── Action bar ──────────────────────────────────────────── */}
      <div className="flex items-center gap-2 p-2 border-b border-white/5">
        <button
          onClick={handleAnalyze}
          disabled={isAnalyzing}
          className={`flex items-center gap-1.5 text-xs px-3 py-1.5 rounded transition-colors ${
            isAnalyzing
              ? 'bg-purple-500/20 text-purple-300 cursor-wait'
              : 'bg-purple-600/30 hover:bg-purple-600/50 text-purple-300'
          }`}
        >
          <RefreshCcw size={12} className={isAnalyzing ? 'animate-spin' : ''} />
          {isAnalyzing ? 'Analyzing…' : 'Analyze'}
        </button>

        {safeCount > 0 && (
          <button
            onClick={handleApplyAllSafe}
            className="flex items-center gap-1 text-xs bg-green-600/20 hover:bg-green-600/40 text-green-300 px-2.5 py-1.5 rounded transition-colors"
            title={`Apply ${safeCount} safe fix${safeCount === 1 ? '' : 'es'}`}
          >
            <CheckCheck size={12} />
            Apply safe ({safeCount})
          </button>
        )}

        {fixCount > 0 && (
          <button
            onClick={handleDismissAll}
            className="flex items-center gap-1 text-xs bg-white/5 hover:bg-white/10 text-white/40 hover:text-white/60 px-2 py-1.5 rounded transition-colors"
            title="Dismiss all"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>

      {/* ── Error ───────────────────────────────────────────────── */}
      {error && (
        <div className="px-3 py-2 text-xs text-red-400 bg-red-500/10 border-b border-red-500/20">
          {error}
        </div>
      )}

      {/* ── Fix list ────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto p-2" role="list">
        {fixCount === 0 && !isAnalyzing && (
          <div className="text-center text-white/30 text-xs py-8">
            <Sparkles size={24} className="mx-auto mb-2 text-white/15" />
            <p>No AI issues detected</p>
            <p className="text-white/20 mt-1">Click Analyze to scan the current file</p>
          </div>
        )}

        {isAnalyzing && fixCount === 0 && (
          <div className="text-center text-purple-300/60 text-xs py-8">
            <RefreshCcw size={20} className="mx-auto mb-2 animate-spin" />
            <p>Analyzing with AI…</p>
          </div>
        )}

        {fixes.map((fix, i) => (
          <AIConfidenceGate
            key={fix.fix_id || fix.id || `ai-fix-${i}`}
            confidence={fix.confidence ?? 0}
          >
            <AIFixCard
              fix={fix}
              index={i}
              onApply={aiHealing.applyFix}
              onDismiss={aiHealing.dismissFix}
              onSuppressRule={aiHealing.suppressRule}
            />
          </AIConfidenceGate>
        ))}
      </div>

      {/* ── Footer stats ────────────────────────────────────────── */}
      {fixCount > 0 && (
        <div className="px-3 py-2 border-t border-white/10 text-[10px] text-white/30 flex justify-between">
          <span>{fixCount} issue{fixCount === 1 ? '' : 's'}</span>
          <span>{safeCount} safe</span>
          {aiHealing?.lastAnalyzedAt && (
            <span>{new Date(aiHealing.lastAnalyzedAt).toLocaleTimeString()}</span>
          )}
        </div>
      )}
    </div>
  );
}
