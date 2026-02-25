'use client';
import React, { useState, useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  createPR, fetchRepoBranches, fetchRepoLabels, clearCreatePRError
} from '@/redux/prSlice';
import {
  GitPullRequest, ChevronLeft, AlertCircle, CheckCircle2,
  Tag, ChevronDown
} from 'lucide-react';

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
      <div
        className="flex items-center gap-2 px-3 py-2.5 border-b flex-shrink-0"
        style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-panel)' }}
      >
        <button
          onClick={onBack}
          className="p-1 rounded-md hover:opacity-70 transition"
          style={{ color: 'var(--text-muted)' }}
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <GitPullRequest className="w-4 h-4" style={{ color: 'var(--accent-primary)' }} strokeWidth={1.5} />
        <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
          New Pull Request
        </span>
        <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>
          {owner}/{repo}
        </span>
      </div>

      <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-3 space-y-3">
        {/* Branch selectors */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>
              FROM (head)
            </label>
            <BranchSelect
              value={head}
              onChange={setHead}
              branches={repoBranches}
              placeholder="head branch"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>
              INTO (base)
            </label>
            <BranchSelect
              value={base}
              onChange={setBase}
              branches={repoBranches}
              placeholder="base branch"
            />
          </div>
        </div>

        {/* Title */}
        <div>
          <label className="block text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>
            TITLE *
          </label>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="PR title…"
            required
            className="w-full px-2.5 py-1.5 rounded-lg text-sm border outline-none transition"
            style={{
              background: 'var(--bg-app)',
              borderColor: 'var(--border-medium)',
              color: 'var(--text-primary)',
            }}
          />
        </div>

        {/* Description */}
        <div>
          <label className="block text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>
            DESCRIPTION
          </label>
          <textarea
            value={body}
            onChange={e => setBody(e.target.value)}
            placeholder="Describe your changes…"
            rows={6}
            className="w-full px-2.5 py-1.5 rounded-lg text-sm border outline-none transition resize-y min-h-[80px]"
            style={{
              background: 'var(--bg-app)',
              borderColor: 'var(--border-medium)',
              color: 'var(--text-primary)',
            }}
          />
        </div>

        {/* Labels */}
        {repoLabels.length > 0 && (
          <div>
            <label className="block text-[10px] font-semibold mb-1" style={{ color: 'var(--text-muted)' }}>
              LABELS
            </label>
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowLabelPicker(v => !v)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs border w-full text-left"
                style={{ background: 'var(--bg-app)', borderColor: 'var(--border-medium)', color: 'var(--text-secondary)' }}
              >
                <Tag className="w-3 h-3" />
                {selectedLabels.length > 0
                  ? selectedLabels.map(l => l.name).join(', ')
                  : 'Add labels'}
                <ChevronDown className="w-3 h-3 ml-auto" />
              </button>
              {showLabelPicker && (
                <div
                  className="absolute top-full mt-1 left-0 right-0 z-20 rounded-lg border shadow-xl overflow-y-auto max-h-40"
                  style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-medium)' }}
                >
                  {repoLabels.map(label => {
                    const isSelected = selectedLabels.find(l => l.name === label.name);
                    return (
                      <button
                        key={label.id}
                        type="button"
                        onClick={() => toggleLabel(label)}
                        className="flex items-center gap-2 w-full px-2.5 py-1.5 text-xs hover:opacity-80 transition text-left"
                        style={{ color: 'var(--text-primary)', background: isSelected ? 'color-mix(in srgb, var(--accent-primary) 10%, transparent)' : 'transparent' }}
                      >
                        <span
                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                          style={{ background: `#${label.color}` }}
                        />
                        {label.name}
                        {isSelected && <CheckCircle2 className="w-3 h-3 ml-auto" style={{ color: 'var(--accent-primary)' }} />}
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
          <div className="flex items-center gap-2 text-xs text-red-400 p-2 rounded-lg" style={{ background: 'rgba(239,68,68,0.08)' }}>
            <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />
            {createPRError}
          </div>
        )}

        {/* Submit */}
        <button
          type="submit"
          disabled={createPRLoading || !title.trim() || !head || !base || head === base}
          className="w-full py-2 rounded-lg text-sm font-semibold transition disabled:opacity-50"
          style={{ background: 'var(--accent-primary)', color: '#fff' }}
        >
          {createPRLoading ? 'Creating…' : 'Create Pull Request'}
        </button>

        {head && base && head === base && (
          <p className="text-xs text-center" style={{ color: 'var(--text-muted)' }}>
            Head and base branch must be different.
          </p>
        )}
      </form>
    </div>
  );
}

function BranchSelect({ value, onChange, branches, placeholder }) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className="w-full px-2 py-1.5 rounded-lg text-xs border outline-none transition"
      style={{
        background: 'var(--bg-app)',
        borderColor: 'var(--border-medium)',
        color: 'var(--text-primary)',
      }}
    >
      {!value && <option value="">{placeholder}</option>}
      {branches.map(b => (
        <option key={b} value={b}>{b}</option>
      ))}
    </select>
  );
}
