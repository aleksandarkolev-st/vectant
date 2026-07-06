'use client';
import React, { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  createPR, fetchRepoBranches, fetchRepoLabels, clearCreatePRError
} from '@/redux/prSlice';
import {
  GitPullRequest, ChevronLeft, AlertCircle, CheckCircle2,
  Tag, ChevronDown, RefreshCw, ArrowRight
} from 'lucide-react';
import { MarkdownEditor } from './MarkdownRenderer';

/**
 * Form for creating a new Pull Request.
 * Pre-fills the head branch with the current git branch.
 */
export function CreatePRForm({ slug, onBack, onCreated }) {
  const dispatch = useDispatch();
  const { githubInfo, createPRLoading, createPRError, repoBranches, repoLabels } = useSelector(s => s.pr);
  const currentBranch = useSelector(s => s.git.status?.current || s.git.currentBranch || 'main');

  const { owner, repo } = githubInfo || {};

  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [head, setHead] = useState(currentBranch || '');
  const [base, setBase] = useState('main');
  const [draft, setDraft] = useState(false);
  const [selectedLabels, setSelectedLabels] = useState([]);
  const [showLabelPicker, setShowLabelPicker] = useState(false);
  const [titleTouched, setTitleTouched] = useState(false);

  // Auto-fill title from branch name if user hasn't touched it
  useEffect(() => {
    if (!titleTouched && head) {
      // Convert branch name like "feature/add-login-page" → "Add login page"
      const branchPart = head.replace(/^(feature|fix|bugfix|hotfix|chore|refactor|docs|feat)\//i, '');
      const humanized = branchPart
        .replace(/[-_]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (humanized) {
        setTitle(humanized.charAt(0).toUpperCase() + humanized.slice(1));
      }
    }
  }, [head, titleTouched]);

  useEffect(() => {
    if (owner && repo) {
      dispatch(fetchRepoBranches({ owner, repo, slug }));
      dispatch(fetchRepoLabels({ owner, repo, slug }));
    }
    return () => dispatch(clearCreatePRError());
  }, [owner, repo, slug, dispatch]);

  // Auto-set base to default branch (main / master)
  useEffect(() => {
    if (repoBranches.length > 0) {
      const defaultBranch = repoBranches.find(b => b === 'main' || b === 'master') || repoBranches[0];
      setBase(defaultBranch);
    }
  }, [repoBranches]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!title.trim() || !head || !base) return;
    const result = await dispatch(createPR({
      owner,
      repo,
      slug,
      title: title.trim(),
      body,
      head,
      base,
      draft,
    }));
    if (createPR.fulfilled.match(result)) {
      onCreated?.(result.payload);
    }
  };

  const toggleLabel = (label) => {
    setSelectedLabels(prev =>
      prev.find(l => l.name === label.name)
        ? prev.filter(l => l.name !== label.name)
        : [...prev, label]
    );
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Header */}
      <div className="vt-panel-header flex-shrink-0">
        <button
          onClick={onBack}
          className="vt-icon-button th-focus-ring h-7 min-w-7"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <GitPullRequest className="w-4 h-4 text-[var(--attention-purple)]" strokeWidth={1.5} />
        <span className="vt-panel-title">
          New Pull Request
        </span>
        <span className="vt-state-pill ml-auto">
          {owner}/{repo}
        </span>
      </div>

      <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Branch selectors */}
        <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-end">
          <div>
            <label className="vt-panel-kicker mb-1 block">
              FROM (head)
            </label>
            <BranchSelect
              value={head}
              onChange={setHead}
              branches={repoBranches}
              placeholder="head branch"
              loading={repoBranches.length === 0}
            />
          </div>
          <div className="flex items-center justify-center pb-1">
            <ArrowRight className="w-4 h-4 text-[var(--text-muted)]" />
          </div>
          <div>
            <label className="vt-panel-kicker mb-1 block">
              INTO (base)
            </label>
            <BranchSelect
              value={base}
              onChange={setBase}
              branches={repoBranches}
              placeholder="base branch"
              loading={repoBranches.length === 0}
            />
          </div>
        </div>
        {head && base && head === base && (
          <div className="-mt-1 flex items-center gap-1.5 text-[10px] text-[var(--accent-warning)]">
            <AlertCircle className="w-3 h-3 flex-shrink-0" strokeWidth={2} />
            Head and base branches must be different
          </div>
        )}
        {repoBranches.length === 0 && (
          <div className="-mt-1 flex items-center gap-1.5 text-[10px] text-[var(--text-muted)]">
            <RefreshCw className="w-3 h-3 animate-spin" /> Loading branches…
          </div>
        )}

        {/* Title */}
        <div>
          <label className="vt-panel-kicker mb-1 block">
            TITLE *
          </label>
          <input
            type="text"
            value={title}
            onChange={e => { setTitle(e.target.value); setTitleTouched(true); }}
            placeholder="PR title…"
            required
            className="th-input w-full rounded-[var(--radius-control)] border px-2.5 py-1.5 text-sm outline-none"
          />
        </div>

        {/* Description */}
        <div>
          <label className="vt-panel-kicker mb-1 block">
            DESCRIPTION
          </label>
          <MarkdownEditor
            value={body}
            onChange={setBody}
            placeholder="Describe your changes…"
            rows={6}
          />
        </div>

        {/* Labels */}
        {repoLabels.length > 0 && (
          <div>
            <label className="vt-panel-kicker mb-1 block">
              LABELS
            </label>
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowLabelPicker(v => !v)}
                className="th-focus-ring th-input flex w-full items-center gap-1.5 rounded-[var(--radius-control)] border px-2.5 py-1.5 text-left text-xs text-[var(--text-secondary)]"
              >
                <Tag className="w-3 h-3" />
                {selectedLabels.length > 0
                  ? selectedLabels.map(l => l.name).join(', ')
                  : 'Add labels'}
                <ChevronDown className="w-3 h-3 ml-auto" />
              </button>
              {showLabelPicker && (
                <div className="vt-command-popover absolute left-0 right-0 top-full z-20 mt-1 max-h-40 overflow-y-auto p-1">
                  {repoLabels.map(label => {
                    const isSelected = selectedLabels.find(l => l.name === label.name);
                    return (
                      <button
                        key={label.id}
                        type="button"
                        onClick={() => toggleLabel(label)}
                        className={`vt-command-item flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs ${isSelected ? 'th-btn-active' : ''}`}
                      >
                        <span
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                          style={{ background: `#${label.color}` }}
                        />
                        {label.name}
                        {isSelected && <CheckCircle2 className="ml-auto h-3 w-3 text-[var(--attention-purple)]" />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Draft checkbox */}
        <label className="flex items-center gap-2 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={draft}
            onChange={e => setDraft(e.target.checked)}
            className="rounded"
          />
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            Create as draft
          </span>
        </label>

        {/* Error */}
        {createPRError && (
          <div className="vt-workflow-alert vt-workflow-alert--danger flex items-center gap-2 p-2 text-xs text-[var(--accent-danger)]">
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" strokeWidth={2} />
            {createPRError}
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={createPRLoading || !title.trim() || !head || !base || head === base}
          className="th-focus-ring th-btn-primary w-full py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50"
        >
          {createPRLoading ? 'Creating…' : 'Create Pull Request'}
        </button>
      </form>
    </div>
  );
}

function BranchSelect({ value, onChange, branches, placeholder, loading }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      disabled={loading}
      className="th-input w-full rounded-[var(--radius-control)] border px-2 py-1.5 text-xs outline-none transition disabled:opacity-50"
    >
      {!value && <option value="">{loading ? 'Loading…' : placeholder}</option>}
      {branches.map(b => (
        <option key={b} value={b}>{b}</option>
      ))}
    </select>
  );
}
