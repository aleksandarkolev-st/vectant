/**
 * Git UI utility functions.
 *
 * Pure helpers used by the Source Control panel — credential masking,
 * host-icon detection, date bucketing, conventional-commit parsing,
 * and commit-graph layout.
 */

// ─── Credential masking ──────────────────────────────────────────

/** Regex that catches common PAT prefixes embedded in remote URLs. */
const PAT_PATTERNS = [
  // GitHub: ghp_, gho_, ghs_, ghr_, github_pat_
  /ghp_[A-Za-z0-9_]+/g,
  /gho_[A-Za-z0-9_]+/g,
  /ghs_[A-Za-z0-9_]+/g,
  /ghr_[A-Za-z0-9_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  // GitLab: glpat-
  /glpat-[A-Za-z0-9_-]+/g,
  // Bitbucket app password (no prefix, but appears in user:pass@)
  // Generic token-in-URL: https://TOKEN@host  or  https://user:TOKEN@host
  /https?:\/\/([^:@/]+):([^@/]+)@/g,
  /https?:\/\/([^@/]{20,})@/g, // bare long token before @
];

/**
 * Return true if the URL contains what looks like a raw access token.
 */
export function urlContainsToken(url) {
  if (!url) return false;
  const s = String(url);
  // Quick check: ghp_, glpat-, user:token@
  if (/gh[pors]_|github_pat_|glpat-/i.test(s)) return true;
  // token-in-url pattern
  if (/https?:\/\/[^@/]{20,}@/.test(s)) return true;
  if (/https?:\/\/[^:@/]+:[^@/]+@/.test(s)) return true;
  return false;
}

/**
 * Mask embedded credentials in a URL for safe display.
 * `https://ghp_abc123@github.com/o/r` → `https://****@github.com/o/r`
 */
export function maskRemoteUrl(url) {
  if (!url) return url;
  let masked = String(url);
  // Replace https://TOKEN@  or  https://user:TOKEN@
  masked = masked.replace(/https?:\/\/([^:@/]+):([^@/]+)@/, (m, user, _pass) => {
    return m.replace(`${user}:${_pass}@`, `${user}:****@`);
  });
  masked = masked.replace(/https?:\/\/([^@/]{8,})@/, (_m, token) => {
    return _m.replace(token, '****');
  });
  return masked;
}

// ─── Host / provider detection ──────────────────────────────────

/**
 * Detect the git hosting provider from a remote URL.
 * Returns 'github' | 'gitlab' | 'bitbucket' | 'azure' | 'unknown'.
 */
export function detectProvider(url) {
  if (!url) return 'unknown';
  const lower = url.toLowerCase();
  if (lower.includes('github.com') || lower.includes('github.')) return 'github';
  if (lower.includes('gitlab.com') || lower.includes('gitlab.')) return 'gitlab';
  if (lower.includes('bitbucket.org') || lower.includes('bitbucket.')) return 'bitbucket';
  if (lower.includes('dev.azure.com') || lower.includes('visualstudio.com')) return 'azure';
  return 'unknown';
}

/**
 * Extract a human-readable host label from a URL.
 * `https://github.com/owner/repo.git` → `github.com/owner/repo`
 */
export function humanRemoteUrl(url) {
  if (!url) return '';
  try {
    const u = new URL(url.replace(/\.git$/, ''));
    return `${u.host}${u.pathname}`;
  } catch {
    // SSH-style: git@host:owner/repo.git
    const m = url.match(/@([^:]+):(.+?)(?:\.git)?$/);
    if (m) return `${m[1]}/${m[2]}`;
    return url;
  }
}

/**
 * Get the web URL for a commit on the hosting provider.
 */
export function commitWebUrl(remoteUrl, hash) {
  if (!remoteUrl || !hash) return null;
  const provider = detectProvider(remoteUrl);
  let base = remoteUrl.replace(/\.git$/, '');
  // Strip tokens
  base = base.replace(/https?:\/\/[^@/]+@/, (m) => m.replace(/\/\/[^@]+@/, '//'));
  if (provider === 'github' || provider === 'gitlab') {
    return `${base}/commit/${hash}`;
  }
  if (provider === 'bitbucket') {
    return `${base}/commits/${hash}`;
  }
  return `${base}/commit/${hash}`;
}

/**
 * Extract an embedded access token from a remote URL.
 * Returns the raw token string, or null if none found.
 *
 *   https://ghp_abc123@github.com/o/r  →  'ghp_abc123'
 *   https://user:TOKEN@github.com/o/r  →  'TOKEN'
 */
export function extractTokenFromUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (parsed.password) return decodeURIComponent(parsed.password);
    if (parsed.username && parsed.username !== 'git' && parsed.username !== 'oauth2' && parsed.username !== 'x-access-token') {
      return decodeURIComponent(parsed.username);
    }
  } catch { /* not a valid URL */ }
  return null;
}

/**
 * Strip embedded credentials from a URL, returning a clean HTTPS URL.
 *   https://ghp_abc123@github.com/o/r  →  https://github.com/o/r
 */
export function stripTokenFromUrl(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

// ─── Conventional commits ───────────────────────────────────────

const CC_REGEX = /^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(\([^)]*\))?(!)?:\s*/i;

/**
 * Parse a conventional-commit message.
 * Returns { type, scope, breaking, subject } or null if not a CC message.
 */
export function parseConventionalCommit(message) {
  if (!message) return null;
  const m = message.match(CC_REGEX);
  if (!m) return null;
  return {
    type: m[1].toLowerCase(),
    scope: m[2] ? m[2].slice(1, -1) : null,
    breaking: !!m[3],
    subject: message.slice(m[0].length),
  };
}

/** Map CC type → tailwind colour classes for the badge. */
const CC_COLORS = {
  feat:     'bg-emerald-500/20 text-emerald-400',
  fix:      'bg-red-500/20 text-red-400',
  docs:     'bg-blue-500/20 text-blue-400',
  style:    'bg-purple-500/20 text-purple-300',
  refactor: 'bg-amber-500/20 text-amber-400',
  perf:     'bg-cyan-500/20 text-cyan-400',
  test:     'bg-teal-500/20 text-teal-300',
  build:    'bg-orange-500/20 text-orange-400',
  ci:       'bg-indigo-500/20 text-indigo-400',
  chore:    'bg-zinc-500/20 text-zinc-400',
  revert:   'bg-rose-500/20 text-rose-400',
};

export function ccColor(type) {
  return CC_COLORS[type] || 'bg-zinc-500/20 text-zinc-400';
}

// ─── Date bucketing ─────────────────────────────────────────────

/**
 * Given a date string (ISO or git-style), return a bucket label.
 */
export function dateBucket(dateStr) {
  if (!dateStr) return 'Older';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return 'Older';

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfLastWeek = new Date(startOfToday);
  startOfLastWeek.setDate(startOfLastWeek.getDate() - 7);

  if (d >= startOfToday) return 'Today';
  if (d >= startOfYesterday) return 'Yesterday';
  if (d >= startOfLastWeek) return 'Last 7 Days';
  return 'Older';
}

/**
 * Group an array of commits into date buckets (preserving original order).
 * Returns [ { label, commits: [...] }, ... ] in display order.
 */
export function groupCommitsByDate(commits) {
  const order = ['Today', 'Yesterday', 'Last 7 Days', 'Older'];
  const map = {};
  order.forEach(label => { map[label] = []; });

  (commits || []).forEach(c => {
    const bucket = dateBucket(c.date);
    map[bucket].push(c);
  });

  return order.filter(l => map[l].length > 0).map(label => ({ label, commits: map[label] }));
}

// ─── Commit graph (simple linear + merge detection) ─────────────

/**
 * Build a simple SVG-friendly commit graph structure.
 *
 * Each commit gets { col, color, isMerge, parents, nodeY }.
 * This is a simplified rail-assignment algorithm suitable for the
 * flat log most workspaces produce.
 */
const GRAPH_COLORS = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ec4899', // pink
  '#8b5cf6', // violet
  '#06b6d4', // cyan
  '#f43f5e', // rose
  '#84cc16', // lime
];

export function buildCommitGraph(commits) {
  if (!commits || commits.length === 0) return [];

  // Assign columns using a simple lane allocator
  const lanes = [];           // ordered list of active commit hashes occupying each lane
  const result = [];
  const hashToRow = new Map(); // hash → row index for parent lookups

  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    const hash = c.hash;
    const parents = (c.parents || '').split(/\s+/).filter(Boolean);
    const isMerge = parents.length > 1;

    hashToRow.set(hash, i);

    // Find or assign lane for this commit
    let col = lanes.indexOf(hash);
    if (col === -1) {
      // New branch — find first empty lane
      col = lanes.indexOf(null);
      if (col === -1) {
        col = lanes.length;
        lanes.push(hash);
      } else {
        lanes[col] = hash;
      }
    }

    // Track lanes that are being freed / merged at this row
    const closingLanes = [];

    // Replace the current lane with first parent (continuation)
    if (parents.length > 0) {
      lanes[col] = parents[0];
    } else {
      lanes[col] = null; // root commit — free lane
    }

    // Additional parents (merge): allocate lanes for them if not already present
    const mergeFromCols = [];
    for (let p = 1; p < parents.length; p++) {
      let pcol = lanes.indexOf(parents[p]);
      if (pcol === -1) {
        pcol = lanes.indexOf(null);
        if (pcol === -1) {
          pcol = lanes.length;
          lanes.push(parents[p]);
        } else {
          lanes[pcol] = parents[p];
        }
      }
      mergeFromCols.push(pcol);
    }

    // Detect closing lanes — lanes occupied by the same parent hash as current
    // This happens when a branch merges back
    for (let li = 0; li < lanes.length; li++) {
      if (li !== col && lanes[li] === hash) {
        closingLanes.push(li);
        lanes[li] = null;
      }
    }

    // Compact empty trailing lanes
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();

    result.push({
      hash,
      col,
      color: GRAPH_COLORS[col % GRAPH_COLORS.length],
      isMerge,
      mergeFromCols,
      closingLanes,
      activeLanes: [...lanes],
      laneCount: lanes.length,
    });
  }

  return result;
}

// ─── Relative time ──────────────────────────────────────────────

/**
 * Format a date string as a short relative time, e.g. "3m ago", "2h ago",
 * "5d ago", or a date for anything older than 30 days.
 */
export function relativeTime(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const now = Date.now();
  const diffMs = now - d.getTime();
  const diffS = Math.floor(diffMs / 1000);
  if (diffS < 60) return 'just now';
  const diffM = Math.floor(diffS / 60);
  if (diffM < 60) return `${diffM}m ago`;
  const diffH = Math.floor(diffM / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.floor(diffH / 24);
  if (diffD < 30) return `${diffD}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}
