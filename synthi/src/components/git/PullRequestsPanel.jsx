'use client';
import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  fetchGithubInfo, fetchPRList, setActivePR, setPRListState,
} from '@/redux/prSlice';
import { GitHubTokenModal } from './GitHubTokenModal';
import { CreatePRForm } from './CreatePRForm';
import { PRDetail } from './PRDetail';
import {
  GitPullRequest, RefreshCw, Plus, Key, AlertCircle,
  GitMerge, XCircle, Circle, Clock, MessageSquare, Filter,
  ChevronDown, ExternalLink, GitBranch,
} from 'lucide-react';
import { ContextMenu, useContextMenu } from '@/components/docking-wm/components/ContextMenu';
import { toast } from 'sonner';

// ── Helpers ────────────────────────────────────────────────────────────────────

function prStatePill(pr) {
  // PR state pills use a calm slate-violet baseline with semantic
  // accents.  Merged earns the brand-purple stop (this is the
  // "shipped" moment, the signature outcome).  Closed → danger.
  // Draft → calm muted.  Open → accent-success ring.
  if (pr.merged) return {
    label: 'Merged',
    style: {
      background: 'color-mix(in srgb, var(--brand-stop-3) 14%, transparent)',
      color: 'var(--brand-stop-3)',
    },
    icon: GitMerge,
  };
  if (pr.state === 'closed') return {
    label: 'Closed',
    style: {
      background: 'color-mix(in srgb, var(--accent-danger) 12%, transparent)',
      color: 'var(--accent-danger)',
    },
    icon: XCircle,
  };
  if (pr.draft) return {
    label: 'Draft',
    style: {
      background: 'color-mix(in srgb, var(--text-muted) 12%, transparent)',
      color: 'var(--text-muted)',
    },
    icon: Circle,
  };
  return {
    label: 'Open',
    style: {
      background: 'color-mix(in srgb, var(--accent-success) 12%, transparent)',
      color: 'var(--accent-success)',
    },
    icon: GitPullRequest,
  };
}

function relativeTime(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}d ago` : new Date(dateStr).toLocaleDateString();
}

// ── PR list item ───────────────────────────────────────────────────────────────
function PRListItem({ pr, onClick, onContextMenu }) {
  const pill = prStatePill(pr);
  const Icon = pill.icon;

  return (
    <button
      onClick={onClick}
      onContextMenu={onContextMenu}
      className="vt-workflow-row group w-full px-3 py-2.5 text-left"
    >
      <div className="flex items-start gap-2.5">
        {/* State icon */}
        <div className="mt-0.5 flex-shrink-0">
          <Icon className="w-3.5 h-3.5" style={{ color: pill.style.color }} />
        </div>

        {/* Main content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-1">
            <p className="flex-1 text-xs font-medium leading-snug text-[var(--text-primary)] group-hover:underline">
              {pr.title}
            </p>
            <span className="mt-0.5 flex-shrink-0 font-mono text-[9px] text-[var(--text-muted)]">
              #{pr.number}
            </span>
          </div>

          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {/* Author */}
            <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
              <img src={pr.user?.avatar_url} alt={pr.user?.login} className="w-3 h-3 rounded-full" />
              {pr.user?.login}
            </span>

            {/* Branch */}
            <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
              <GitBranch className="w-3 h-3" />
              <span className="font-mono truncate max-w-[80px]">{pr.head?.ref}</span>
              <span className="opacity-50">→</span>
              <span className="font-mono truncate max-w-[80px]">{pr.base?.ref}</span>
            </span>

            {/* Time */}
            <span className="ml-auto text-[10px] text-[var(--text-muted)]">
              {relativeTime(pr.updated_at)}
            </span>
          </div>

          {/* Labels */}
          {pr.labels?.length > 0 && (
            <div className="flex gap-1 mt-1.5 flex-wrap">
              {pr.labels.map(label => (
                <span
                  key={label.id}
                  className="vt-workflow-chip text-[9px]"
                  style={{ '--chip-color': `#${label.color}` }}
                >
                  {label.name}
                </span>
              ))}
            </div>
          )}

          {/* Stats (comments) */}
          {pr.comments > 0 && (
            <span className="mt-1 flex items-center gap-0.5 text-[10px] text-[var(--text-muted)]">
              <MessageSquare className="w-3 h-3" />
              {pr.comments}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

// ── No-token state ──────────────────────────────────────────────────────────────
function NoTokenState({ onSetup, loading }) {
  return (
    <div className="vt-empty-state m-3 flex h-[calc(100%-24px)] flex-col items-center justify-center px-4 py-8 text-center">
      <div className="vt-agent-card mb-4 flex h-12 w-12 items-center justify-center">
        <Key className="w-5 h-5 text-[var(--attention-purple)]" />
      </div>
      <h3 className="mb-1 text-sm font-semibold text-[var(--text-primary)]">
        Connect to GitHub
      </h3>
      <p className="mb-4 max-w-[220px] text-xs text-[var(--text-muted)]">
        Add a GitHub Personal Access Token to create and manage pull requests.
      </p>
      <button
        onClick={onSetup}
        disabled={loading}
        className="th-focus-ring th-btn-primary flex items-center gap-2 px-4 py-2 text-xs font-semibold disabled:opacity-50"
      >
        <Key className="w-3.5 h-3.5" />
        Add Token
      </button>
    </div>
  );
}

// ── No-remote state ─────────────────────────────────────────────────────────────
function NoRemoteState() {
  return (
    <div className="vt-empty-state m-3 flex h-[calc(100%-24px)] flex-col items-center justify-center px-4 py-8 text-center">
      <div className="vt-workflow-alert vt-workflow-alert--danger mb-4 flex h-12 w-12 items-center justify-center rounded-[var(--radius-panel)]">
        <AlertCircle className="w-5 h-5 text-[var(--accent-danger)]" />
      </div>
      <h3 className="mb-1 text-sm font-semibold text-[var(--text-primary)]">
        No GitHub Remote
      </h3>
      <p className="mb-2 max-w-[220px] text-xs text-[var(--text-muted)]">
        This workspace does not have a GitHub remote configured.
      </p>
      <p className="text-xs text-[var(--text-muted)]">
        Clone or push to a GitHub repository to use Pull Requests.
      </p>
    </div>
  );
}

// ── ProviderBadge ───────────────────────────────────────────────────────────────
function ProviderBadge({ provider, owner, repo, htmlUrl }) {
  if (!provider || provider === 'unknown') return null;
  if (provider !== 'github') {
    return (
      <span
        className="vt-workflow-chip text-[9px]"
        style={{ '--chip-color': 'var(--accent-danger)' }}
      >
        {provider} — PRs for GitHub only
      </span>
    );
  }
  return (
    <a
      href={htmlUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="vt-state-pill hover:text-[var(--text-primary)]"
    >
      {owner}/{repo}
      <ExternalLink className="w-2.5 h-2.5" />
    </a>
  );
}

// ── Main panel ─────────────────────────────────────────────────────────────────

export function PullRequestsPanel({ slug }) {
  const dispatch = useDispatch();
  const {
    githubInfo,
    githubInfoLoading,
    githubInfoError,
    hasToken,
    prList,
    prListLoading,
    prListError,
    prListState,
    activePR,
  } = useSelector(s => s.pr);

  // Panel state machine: 'list' | 'create' | 'detail'
  const [view, setView] = useState('list');
  const [showTokenModal, setShowTokenModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const { owner, repo, provider } = githubInfo || {};
  const isGitHub = provider === 'github';

  // ── Initialise ───────────────────────────────────────────────────────────────
  // Token state (pr.hasToken) is owned by <SessionTokenHydrator/>, so we only
  // need to fetch the workspace's GitHub info here. The PR-list effect below
  // (keyed on hasToken) auto-fires the moment the token becomes available,
  // whether on first session load or after the user saves a PAT in Settings.
  useEffect(() => {
    dispatch(fetchGithubInfo(slug));
  }, [slug, dispatch]);

  // Load PRs when we have both token and repo info
  useEffect(() => {
    if (hasToken && owner && repo && isGitHub) {
      dispatch(fetchPRList({ owner, repo, state: prListState, slug }));
    }
  }, [hasToken, owner, repo, isGitHub, prListState, slug, dispatch]);

  // Listen for external actions (e.g., "create" from SCM panel)
  useEffect(() => {
    const handleAction = (e) => {
      if (e.detail === 'create') setView('create');
    };
    window.addEventListener('synthi:pr-action', handleAction);
    return () => window.removeEventListener('synthi:pr-action', handleAction);
  }, []);

  // When activePR is set externally (e.g., from SCM panel), switch to detail view
  useEffect(() => {
    if (activePR && view === 'list') {
      setView('detail');
    }
  }, [activePR]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-refresh PR list every 60 seconds when in list view
  useEffect(() => {
    if (view !== 'list' || !hasToken || !owner || !repo || !isGitHub) return;
    const interval = setInterval(() => {
      dispatch(fetchPRList({ owner, repo, state: prListState, slug }));
    }, 60_000);
    return () => clearInterval(interval);
  }, [view, hasToken, owner, repo, isGitHub, prListState, slug, dispatch]);

  const handleSelectPR = useCallback((pr) => {
    dispatch(setActivePR(pr));
    setView('detail');
  }, [dispatch]);

  const handleBack = useCallback(() => {
    if (view === 'detail' || view === 'create') {
      dispatch(setActivePR(null));
      setView('list');
      // Refresh PR list when coming back
      if (owner && repo && hasToken) {
        dispatch(fetchPRList({ owner, repo, state: prListState, slug }));
      }
    }
  }, [view, dispatch, owner, repo, hasToken, prListState, slug]);

  const handleCreated = useCallback((pr) => {
    dispatch(setActivePR(pr));
    setView('detail');
  }, [dispatch]);

  const handleRefresh = () => {
    if (owner && repo && hasToken) {
      dispatch(fetchPRList({ owner, repo, state: prListState, slug }));
    }
  };

  const { menuState, openMenu, closeMenu } = useContextMenu();

  const copyToClipboard = useCallback((text, label) => {
    if (!text) return;
    navigator.clipboard.writeText(text).then(
      () => toast.success(`Copied ${label}`),
      () => toast.error('Copy failed'),
    );
  }, []);

  const handlePRContextMenu = useCallback((e, pr) => {
    const url = pr.html_url || (owner && repo ? `https://github.com/${owner}/${repo}/pull/${pr.number}` : null);
    openMenu(e, [
      {
        id: 'open',
        label: 'Open',
        action: () => handleSelectPR(pr),
      },
      {
        id: 'open-github',
        label: 'Open on GitHub',
        disabled: !url,
        dividerAfter: true,
        action: () => {
          if (url) window.open(url, '_blank', 'noopener,noreferrer');
        },
      },
      {
        id: 'copy-url',
        label: 'Copy URL',
        disabled: !url,
        action: () => copyToClipboard(url, 'PR URL'),
      },
      {
        id: 'copy-branch',
        label: 'Copy Branch Name',
        disabled: !pr.head?.ref,
        action: () => copyToClipboard(pr.head?.ref, `"${pr.head?.ref}"`),
      },
      {
        id: 'copy-title',
        label: 'Copy Title',
        dividerAfter: true,
        action: () => copyToClipboard(pr.title || '', 'title'),
      },
      {
        id: 'refresh',
        label: 'Refresh List',
        action: handleRefresh,
      },
    ]);
  }, [openMenu, handleSelectPR, copyToClipboard, owner, repo, handleRefresh]);

  // Filter PRs by search query
  const filteredPRs = searchQuery.trim()
    ? prList.filter(pr =>
        pr.title?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        String(pr.number).includes(searchQuery) ||
        pr.user?.login?.toLowerCase().includes(searchQuery.toLowerCase()) ||
        pr.head?.ref?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : prList;

  // ── Render sub-views ─────────────────────────────────────────────────────────
  if (view === 'detail' && activePR) {
    return (
      <div className="h-full flex flex-col">
        <PRDetail slug={slug} onBack={handleBack} />
      </div>
    );
  }

  if (view === 'create') {
    return (
      <div className="h-full flex flex-col">
        <CreatePRForm slug={slug} onBack={handleBack} onCreated={handleCreated} />
      </div>
    );
  }

  // ── List view ────────────────────────────────────────────────────────────────
  return (
    <div className="flex h-full min-h-0 flex-col rounded-none border-0 text-[var(--text-primary)]">
      <div className="vt-panel-header flex-shrink-0">
        <GitPullRequest className="w-4 h-4 flex-shrink-0 text-[var(--attention-purple)]" strokeWidth={1.5} />
        <span className="vt-panel-title flex-1">Pull Requests</span>

        {githubInfo && isGitHub && (
          <ProviderBadge provider={provider} owner={owner} repo={repo} htmlUrl={githubInfo.htmlUrl} />
        )}

        <div className="flex items-center gap-1 ml-auto">
          {hasToken && (
            <button
              onClick={handleRefresh}
              disabled={prListLoading}
              className="vt-icon-button th-focus-ring h-7 min-w-7 disabled:opacity-30"
              title="Refresh"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${prListLoading ? 'animate-spin' : ''}`} />
            </button>
          )}
          <button
            onClick={() => setShowTokenModal(true)}
            className={`vt-icon-button th-focus-ring h-7 min-w-7 ${!hasToken ? 'th-btn-active' : ''}`}
            title={hasToken ? 'Manage GitHub token' : 'Add GitHub token'}
          >
            <Key className="w-3.5 h-3.5" />
          </button>
          {hasToken && isGitHub && (
            <button
              onClick={() => setView('create')}
              className="vt-icon-button th-focus-ring h-7 min-w-7 text-[var(--attention-purple)]"
              title="Create Pull Request"
            >
              <Plus className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Main content */}
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
        {/* Loading github info */}
        {githubInfoLoading && (
          <div className="flex items-center justify-center py-8 text-xs text-[var(--text-muted)]">
            <RefreshCw className="w-4 h-4 animate-spin mr-2" /> Detecting repository…
          </div>
        )}

        {/* No remote */}
        {!githubInfoLoading && (githubInfoError || (githubInfo && !owner)) && (
          <NoRemoteState />
        )}

        {/* Non-GitHub remote */}
        {!githubInfoLoading && githubInfo && owner && !isGitHub && (
          <div className="vt-empty-state m-3 flex h-[calc(100%-24px)] flex-col items-center justify-center px-4 py-8 text-center">
            <GitPullRequest className="mb-3 h-8 w-8 text-[var(--text-muted)] opacity-50" />
            <p className="mb-1 text-xs font-medium text-[var(--text-primary)]">GitHub only</p>
            <p className="text-xs text-[var(--text-muted)]">
              Pull request management is currently supported for GitHub repositories.
            </p>
          </div>
        )}

        {/* No token */}
        {!githubInfoLoading && githubInfo && isGitHub && !hasToken && (
          <NoTokenState onSetup={() => setShowTokenModal(true)} />
        )}

        {/* PR list */}
        {githubInfo && isGitHub && hasToken && (
          <>
            {/* State filter + search */}
            <div className="flex-shrink-0 border-b border-[var(--border-subtle)] bg-[color-mix(in_srgb,var(--bg-panel)_78%,var(--bg-app)_22%)]">
              {/* State tabs */}
              <div className="flex gap-1 px-2 pt-2">
                {[
                  { value: 'open', label: 'Open' },
                  { value: 'closed', label: 'Closed' },
                  { value: 'all', label: 'All' },
                ].map(tab => (
                  <button
                    key={tab.value}
                    onClick={() => {
                      dispatch(setPRListState(tab.value));
                      dispatch(fetchPRList({ owner, repo, state: tab.value, slug }));
                    }}
                    className={`th-focus-ring flex-1 rounded-[var(--radius-control)] px-2 py-1.5 text-xs font-medium transition ${prListState === tab.value ? 'th-btn-active' : 'th-btn-ghost'}`}
                  >
                    {tab.label}
                    {tab.value === prListState && prList.length > 0 && (
                      <span className="ml-1 text-[9px] opacity-70">({prList.length})</span>
                    )}
                  </button>
                ))}
              </div>

              {/* Search */}
              {prList.length > 0 && (
                <div className="px-2 py-1.5">
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    placeholder="Filter by title, number, author…"
                    className="th-input w-full rounded-[var(--radius-control)] border px-2.5 py-1 text-xs outline-none"
                  />
                </div>
              )}
            </div>

            {/* PR list content */}
            {prListLoading && prList.length === 0 ? (
              <div className="px-3 py-2 space-y-2">
                {[1, 2, 3].map(i => (
                  <div key={i} className="vt-workflow-card p-2.5">
                    <div className="vt-skeleton h-3 w-3/4 rounded mb-2" />
                    <div className="vt-skeleton h-2 w-1/2 rounded" />
                  </div>
                ))}
              </div>
            ) : prListError ? (
              <div className="vt-workflow-alert vt-workflow-alert--danger mx-3 mt-3 p-3 text-xs text-[var(--accent-danger)]">
                <AlertCircle className="w-3.5 h-3.5 inline mr-1" />{prListError}
              </div>
            ) : filteredPRs.length === 0 ? (
              <div className="vt-empty-state m-3 flex flex-1 flex-col items-center justify-center px-4 py-10 text-center">
                <div className="vt-agent-card mb-3 flex h-11 w-11 items-center justify-center">
                  <GitPullRequest className="w-5 h-5 text-[var(--accent-secondary)]" />
                </div>
                <p className="mb-1 text-[13px] font-medium text-[var(--text-primary)]">
                  {searchQuery ? 'No matching pull requests' : `No ${prListState === 'all' ? '' : prListState} pull requests`}
                </p>
                {!searchQuery && prListState === 'open' && (
                  <>
                    <p className="mb-4 max-w-[220px] text-[11px] text-[var(--text-muted)]">
                      Create a pull request to propose changes from one branch to another.
                    </p>
                    <button
                      onClick={() => setView('create')}
                      className="th-focus-ring th-btn-primary flex items-center gap-1.5 px-3.5 py-1.5 text-[11px] font-semibold"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      New Pull Request
                    </button>
                  </>
                )}
                {!searchQuery && prListState === 'closed' && (
                  <p className="max-w-[220px] text-[11px] text-[var(--text-muted)]">
                    No closed pull requests found. Try switching to "Open" or "All".
                  </p>
                )}
              </div>
            ) : (
              <div className="flex-1">
                {filteredPRs.map(pr => (
                  <PRListItem
                    key={pr.id}
                    pr={pr}
                    onClick={() => handleSelectPR(pr)}
                    onContextMenu={(e) => handlePRContextMenu(e, pr)}
                  />
                ))}
                {prListLoading && prList.length > 0 && (
                  <div className="flex items-center justify-center py-2 text-[10px] text-[var(--text-muted)]">
                    <RefreshCw className="w-3 h-3 animate-spin mr-1.5" /> Refreshing…
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Token modal — purely informational; once the user saves a PAT in
          Settings, <SessionTokenHydrator/> updates pr.hasToken and the
          fetchPRList effect re-fires automatically. */}
      {showTokenModal && (
        <GitHubTokenModal onClose={() => setShowTokenModal(false)} />
      )}

      {menuState && <ContextMenu {...menuState} onClose={closeMenu} />}
    </div>
  );
}
