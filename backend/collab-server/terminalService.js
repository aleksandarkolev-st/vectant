/**
 * terminalService.js — PTY Terminal Service for Synthi IDE
 *
 * Spawns real shell sessions via node-pty and bridges them to WebSocket
 * clients. Each session is identified by a unique ID and bound to a
 * workspace directory.
 *
 * Protocol (over a single WebSocket connection):
 *   Text messages  → JSON control frames
 *   Binary messages → raw PTY stdin bytes
 *   Server sends text for PTY output (hot path, zero-parse overhead)
 *
 * Control frames (client → server):
 *   { type: "resize", cols: Number, rows: Number }
 *   { type: "ping" }
 *
 * Control frames (server → client):
 *   { type: "ready", sessionId, shell, cwd, pid }
 *   { type: "exit",  code: Number }
 *   { type: "error", message: String }
 *   { type: "pong" }
 *
 * Design notes:
 *   - The spawn logic is isolated behind createPtyProcess() so it can be
 *     swapped for a `docker exec` wrapper without touching the rest.
 *   - One PTY per WebSocket connection. Reconnection creates a new session.
 *   - All user input is forwarded verbatim to the PTY — no shell metachar
 *     injection risk because we never construct commands from user data;
 *     the user IS the shell operator.
 */

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');
const { watchWorkspace } = require('./fsWatcherService');

// node-pty is a native add-on. Fail fast with a clear message if missing.
let pty;
try {
  pty = require('node-pty');
} catch (err) {
  console.error(
    '[Terminal] node-pty is not installed or failed to load.\n' +
    '  Run: npm install node-pty\n' +
    '  On Windows you may need: npm install --global windows-build-tools\n',
    err.message
  );
  // Export a no-op so the server can still start without terminal support.
  module.exports = {
    createTerminalWSS: () => ({ handleUpgrade: () => {} }),
    activeSessions: new Map(),
  };
  return;
}

// ─── Session Store ──────────────────────────────────────────────────────────

/** @type {Map<string, { pty: IPty, ws: WebSocket, cwd: string, shell: string }>} */
const activeSessions = new Map();

// ─── Shell Detection ────────────────────────────────────────────────────────

function shellExists(shellPath) {
  if (!shellPath) return false;
  try {
    // On Unix, a file can exist without being executable (e.g. mounted
    // read-only or misconfigured).  Require X_OK so we never try to spawn
    // a non-executable file.  On Windows, fs.accessSync with X_OK still
    // succeeds for regular files, so falling back to existsSync is fine.
    if (os.platform() === 'win32') {
      return fs.existsSync(shellPath);
    }
    fs.accessSync(shellPath, fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Determine the default shell for the current platform.
 */
function getDefaultShell() {
  if (os.platform() === 'win32') {
    // Prefer PowerShell 7+ if available, fall back to Windows PowerShell
    return process.env.COMSPEC
      ? 'powershell.exe'
      : 'cmd.exe';
  }
  // Unix: respect $SHELL when it exists, otherwise prefer bash and finally sh.
  const candidates = [process.env.SHELL, '/bin/bash', '/bin/sh'].filter(Boolean);
  for (const candidate of candidates) {
    if (shellExists(candidate)) return candidate;
  }
  return '/bin/sh';
}

function getDefaultShellArgs(shell) {
  if (os.platform() === 'win32') return [];
  const shellName = path.basename(shell || '');
  return ['bash', 'zsh', 'fish'].includes(shellName) ? ['--login'] : [];
}

// ─── Shell Registry ─────────────────────────────────────────────────────────

/**
 * Known shell types mapped to their executable names per platform.
 * Each entry has { win32, unix, args, label }.
 */
// ─── Git Bash Discovery (Windows) ───────────────────────────────────────────

/** Cache for the discovered Git Bash executable path */
let _gitBashPath = undefined; // undefined = not yet searched, null = not found
/** Promise for async Git Bash discovery (resolved once, reused forever) */
let _gitBashPromise = null;

const { exec: _exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(_exec);

/**
 * Find the Git Bash executable on Windows — **async, non-blocking**.
 * Uses the same discovery strategy as VS Code:
 *   1. Windows Registry (HKLM\SOFTWARE\GitForWindows — most reliable)
 *   2. Common install paths (Program Files, scoop, etc.)
 *   3. `where git` to derive the install root
 */
async function findGitBashAsync() {
  if (_gitBashPath !== undefined) return _gitBashPath;

  const fsp = require('fs').promises;

  // 1. Windows Registry — most reliable, this is how VS Code finds Git
  try {
    const { stdout: regOutput } = await execAsync(
      'REG QUERY "HKLM\\SOFTWARE\\GitForWindows" /v InstallPath',
      { encoding: 'utf-8', timeout: 3000, windowsHide: true }
    );
    const match = regOutput.match(/InstallPath\s+REG_SZ\s+(.+)/i);
    if (match) {
      const bashPath = path.join(match[1].trim(), 'bin', 'bash.exe');
      try { await fsp.access(bashPath); _gitBashPath = bashPath; console.log(`[Terminal] Git Bash found via Registry: ${bashPath}`); return bashPath; } catch (_) {}
    }
  } catch (_) { /* Registry query failed */ }

  // 2. Common install locations
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Git', 'bin', 'bash.exe'),
    path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'Git', 'bin', 'bash.exe'),
    path.join(os.homedir(), 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
    'C:\\Git\\bin\\bash.exe',
  ];
  for (const p of candidates) {
    try { await fsp.access(p); _gitBashPath = p; console.log(`[Terminal] Git Bash found at: ${p}`); return p; } catch (_) { /* skip */ }
  }

  // 3. `where git` fallback — derive install root from git.exe location
  try {
    const { stdout } = await execAsync('where git', { encoding: 'utf-8', timeout: 3000, windowsHide: true });
    const gitPath = stdout.split('\n')[0].trim();
    if (gitPath) {
      const gitRoot = path.dirname(path.dirname(gitPath));
      const bashPath = path.join(gitRoot, 'bin', 'bash.exe');
      try { await fsp.access(bashPath); _gitBashPath = bashPath; console.log(`[Terminal] Git Bash found via \`where git\`: ${bashPath}`); return bashPath; } catch (_) {}
    }
  } catch (_) { /* where git failed */ }

  _gitBashPath = null;
  console.log('[Terminal] Git Bash not found on this system');
  return null;
}

/**
 * Synchronous accessor — returns cached result or null if discovery hasn't
 * finished yet.  The async discovery is kicked off at module load time via
 * _initShellDiscovery(), so by the time a terminal is opened it's resolved.
 */
function findGitBash() {
  return _gitBashPath !== undefined ? _gitBashPath : null;
}

/** Cache for discovered bash executable path (WSL / PATH-based) */
let _bashPath = undefined;

/**
 * Find a working bash.exe on Windows — **async, non-blocking**.
 * Filters out the WindowsApps WSL stub (which fails if WSL is not installed).
 * Falls back to Git Bash's bash.exe if no other bash is available.
 */
async function findBashExeAsync() {
  if (_bashPath !== undefined) return _bashPath;

  const fsp = require('fs').promises;

  // `where bash.exe` may return multiple results, one per line
  try {
    const { stdout } = await execAsync('where bash.exe', { encoding: 'utf-8', timeout: 3000, windowsHide: true });
    const paths = stdout.split('\n').map(l => l.trim()).filter(Boolean);
    for (const p of paths) {
      // Skip the WindowsApps stub — it only works when WSL is actually installed
      if (p.toLowerCase().includes('windowsapps')) continue;
      try { await fsp.access(p); _bashPath = p; console.log(`[Terminal] bash.exe found in PATH: ${p}`); return p; } catch (_) {}
    }
  } catch (_) { /* where bash.exe failed */ }

  // Fall back to Git Bash's bash.exe
  const gitBash = await findGitBashAsync();
  if (gitBash) {
    _bashPath = gitBash;
    console.log(`[Terminal] bash.exe using Git Bash: ${gitBash}`);
    return gitBash;
  }

  _bashPath = null;
  console.log('[Terminal] No working bash.exe found');
  return null;
}

/**
 * Synchronous accessor — returns cached result or null.
 */
function findBashExe() {
  return _bashPath !== undefined ? _bashPath : null;
}

const SHELL_REGISTRY = {
  powershell: {
    win32: 'powershell.exe',
    unix: 'pwsh',
    args: { win32: [], unix: [] },
    label: 'PowerShell',
  },
  pwsh: {
    win32: 'pwsh.exe',
    unix: 'pwsh',
    args: { win32: [], unix: [] },
    label: 'PowerShell 7',
  },
  cmd: {
    win32: 'cmd.exe',
    unix: null,
    args: { win32: [], unix: [] },
    label: 'Command Prompt',
  },
  bash: {
    win32: null,  // Resolved dynamically — see resolveShellType()
    unix: '/bin/bash',
    args: { win32: ['--login'], unix: ['--login'] },
    label: 'Bash',
    dynamic: true, // needs runtime resolution on Windows
  },
  gitbash: {
    // Resolved dynamically — see resolveShellType()
    win32: null,
    unix: null,
    args: { win32: ['--login', '-i'], unix: [] },
    label: 'Git Bash',
    dynamic: true, // marker for dynamic resolution
  },
  zsh: {
    win32: null,
    unix: '/bin/zsh',
    args: { win32: [], unix: ['--login'] },
    label: 'Zsh',
  },
  fish: {
    win32: null,
    unix: '/usr/bin/fish',
    args: { win32: [], unix: ['--login'] },
    label: 'Fish',
  },
  sh: {
    win32: null,
    unix: '/bin/sh',
    args: { win32: [], unix: [] },
    label: 'sh',
  },
};

/**
 * Resolve a shell type key (e.g. 'bash', 'powershell') to an executable path
 * and arguments for the current platform. Returns null if the shell type is
 * not available on this platform.
 */
function resolveShellType(shellType) {
  if (!shellType) return null;
  const entry = SHELL_REGISTRY[shellType.toLowerCase()];
  if (!entry) return null;

  const platform = os.platform() === 'win32' ? 'win32' : 'unix';

  // Dynamic resolution on Windows
  if (entry.dynamic && platform === 'win32') {
    const key = shellType.toLowerCase();
    let exe = null;
    if (key === 'gitbash') {
      exe = findGitBash();
    } else if (key === 'bash') {
      exe = findBashExe();
    }
    if (!exe) return null;
    return { executable: exe, args: entry.args.win32 || [], label: entry.label };
  }

  const executable = entry[platform];
  if (!executable) return null;

  const args = entry.args?.[platform] || [];
  return { executable, args, label: entry.label };
}

/** Cached result of shell discovery */
let _availableShellsCache = null;
let _availableShellsPromise = null;

/**
 * Detect which shells are available on the current system — **async, non-blocking**.
 * Returns an array of { key, label, executable } for shells that exist on disk.
 */
async function getAvailableShellsAsync() {
  if (_availableShellsCache) return _availableShellsCache;

  const fsp = require('fs').promises;
  const platform = os.platform() === 'win32' ? 'win32' : 'unix';
  const available = [];

  for (const [key, entry] of Object.entries(SHELL_REGISTRY)) {
    // Dynamic entries — resolve at runtime
    if (entry.dynamic) {
      if (platform === 'win32') {
        let exe = null;
        if (key === 'gitbash') exe = await findGitBashAsync();
        else if (key === 'bash') exe = await findBashExeAsync();
        if (exe) {
          available.push({ key, label: entry.label, executable: exe });
        }
      } else if (entry.unix) {
        try { await fsp.access(entry.unix); available.push({ key, label: entry.label, executable: entry.unix }); } catch (_) {}
      }
      continue;
    }

    const executable = entry[platform];
    if (!executable) continue;

    // Check if the executable actually exists
    try {
      if (path.isAbsolute(executable)) {
        try { await fsp.access(executable); available.push({ key, label: entry.label, executable }); } catch (_) {}
      } else {
        // Verify non-absolute executables are actually in PATH
        const cmd = platform === 'win32' ? `where ${executable}` : `which ${executable}`;
        const { stdout } = await execAsync(cmd, { encoding: 'utf-8', timeout: 2000, windowsHide: true });
        if (stdout.trim()) {
          available.push({ key, label: entry.label, executable });
        }
      }
    } catch (_) { /* not in PATH — skip */ }
  }

  _availableShellsCache = available;
  return available;
}

/**
 * Synchronous accessor — returns cached result (populated at module load).
 * Falls back to an empty array if discovery hasn't completed yet.
 */
function getAvailableShells() {
  return _availableShellsCache || [];
}

// ─── Eager Initialization ───────────────────────────────────────────────────
// Kick off shell discovery at module load time. By the time
// the first HTTP request arrives, the caches are already warm.
async function _initShellDiscovery() {
  try {
    await findGitBashAsync();
    await findBashExeAsync();
    await getAvailableShellsAsync();
    console.log(`[Terminal] Shell discovery complete: ${(_availableShellsCache || []).length} shells found`);
  } catch (err) {
    console.error('[Terminal] Shell discovery failed:', err.message);
  }
}
_initShellDiscovery();

// ─── PTY Factory (swap-point for Docker in the future) ──────────────────────

// ─── SDK / Tool Path Discovery ──────────────────────────────────────────────

/**
 * Discover SDK bin directories (Flutter, Dart, Android, etc.) that exist on
 * disk but may not be in the server process's PATH. Returns an array of
 * absolute directory paths that should be prepended to PATH for the PTY.
 *
 * Checked in order: explicit env vars → common install locations per-platform.
 */
function discoverSdkPaths() {
  const found = [];
  const home = os.homedir();
  const isWin = os.platform() === 'win32';
  const sep = isWin ? ';' : ':';
  const currentPath = (process.env.PATH || '').split(sep).map(p => p.toLowerCase());

  /** Add `dir` if it exists and isn't already in PATH */
  function tryAdd(dir) {
    if (!dir) return;
    try {
      const resolved = path.resolve(dir);
      if (fs.existsSync(resolved) && !currentPath.includes(resolved.toLowerCase())) {
        found.push(resolved);
      }
    } catch (_) { /* skip */ }
  }

  // ── Flutter SDK ─────────────────────────────────────────────────────
  const flutterRoots = [
    process.env.FLUTTER_ROOT,
    process.env.FLUTTER_HOME,
    process.env.FLUTTER_SDK,
  ];
  if (isWin) {
    flutterRoots.push(
      path.join(home, 'flutter'),
      path.join(home, '.flutter'),
      path.join(home, 'dev', 'flutter'),
      'C:\\flutter',
      'C:\\src\\flutter',
      'C:\\tools\\flutter',
      'C:\\dev\\flutter',
      path.join(home, 'AppData', 'Local', 'Flutter'),
      // fvm (Flutter Version Manager)
      path.join(home, 'fvm', 'default'),
      path.join(home, '.fvm', 'default'),
    );
  } else {
    flutterRoots.push(
      path.join(home, 'flutter'),
      '/opt/flutter',
      '/usr/local/flutter',
      path.join(home, 'snap', 'flutter', 'common', 'flutter'),
      path.join(home, 'fvm', 'default'),
      path.join(home, '.fvm', 'default'),
    );
  }
  for (const root of flutterRoots) {
    if (root) {
      tryAdd(path.join(root, 'bin'));
      // Flutter bundles its own Dart SDK
      tryAdd(path.join(root, 'bin', 'cache', 'dart-sdk', 'bin'));
    }
  }

  // ── Standalone Dart SDK ─────────────────────────────────────────────
  const dartRoots = [process.env.DART_SDK, process.env.DART_HOME];
  if (isWin) {
    dartRoots.push(
      path.join(home, 'dart-sdk'),
      'C:\\tools\\dart-sdk',
      path.join(home, 'AppData', 'Local', 'Dart'),
    );
  } else {
    dartRoots.push(
      path.join(home, 'dart-sdk'),
      '/usr/lib/dart',
      '/opt/dart-sdk',
    );
  }
  for (const root of dartRoots) {
    if (root) tryAdd(path.join(root, 'bin'));
  }

  // ── Pub global packages (dart pub global activate) ──────────────────
  if (isWin) {
    tryAdd(path.join(home, 'AppData', 'Local', 'Pub', 'Cache', 'bin'));
  } else {
    tryAdd(path.join(home, '.pub-cache', 'bin'));
  }

  // ── Android SDK ─────────────────────────────────────────────────────
  const androidRoots = [
    process.env.ANDROID_SDK_ROOT,
    process.env.ANDROID_HOME,
    process.env.SYNTHI_ANDROID_SDK_ROOT,
  ];
  if (isWin) {
    androidRoots.push(
      path.join(home, 'AppData', 'Local', 'Android', 'Sdk'),
      'C:\\Android\\Sdk',
    );
  } else {
    androidRoots.push(
      path.join(home, 'Android', 'Sdk'),
      '/opt/android-sdk',
      '/usr/lib/android-sdk',
    );
  }
  for (const root of androidRoots) {
    if (root) {
      tryAdd(path.join(root, 'platform-tools'));
      tryAdd(path.join(root, 'emulator'));
      tryAdd(path.join(root, 'cmdline-tools', 'latest', 'bin'));
      tryAdd(path.join(root, 'tools', 'bin'));
    }
  }

  // ── Java / JDK ──────────────────────────────────────────────────────
  const javaHome = process.env.JAVA_HOME;
  if (javaHome) tryAdd(path.join(javaHome, 'bin'));

  // ── Gradle ──────────────────────────────────────────────────────────
  const gradleHome = process.env.GRADLE_HOME;
  if (gradleHome) tryAdd(path.join(gradleHome, 'bin'));

  if (found.length > 0) {
    console.log('[Terminal] Discovered SDK paths:', found);
  }

  return found;
}

// Cache the result — SDK locations don't change mid-process
let _cachedSdkPaths = null;
function getSdkPaths() {
  if (_cachedSdkPaths === null) {
    _cachedSdkPaths = discoverSdkPaths();
  }
  return _cachedSdkPaths;
}

// ─── Developer CLI Path Discovery ───────────────────────────────────────────

/**
 * Discover per-user bin directories where common developer CLIs install
 * (Claude Code, npm globals on Windows, ~/.local/bin from standalone
 * installers, bun, cargo, pnpm, yarn). Kept separate from discoverSdkPaths
 * so the SDK list stays untouched.
 *
 * In the deployed Alpine image, `npm install -g` lands binaries in
 * /usr/local/bin which is already on PATH — none of these candidates
 * exist there and tryAdd skips them silently. On developer laptops the
 * `claude` CLI commonly lives in ~/.local/bin (standalone installer) or
 * %APPDATA%\npm (Windows npm-global), neither of which collab-server's
 * inherited PATH is guaranteed to contain.
 *
 * Operator override: set CLAUDE_BIN_DIR to force-add a specific directory.
 */
function discoverDevCliPaths() {
  const found = [];
  const home = os.homedir();
  const isWin = os.platform() === 'win32';
  const sep = isWin ? ';' : ':';
  const currentPath = (process.env.PATH || '').split(sep).map(p => p.toLowerCase());

  function tryAdd(dir) {
    if (!dir) return;
    try {
      const resolved = path.resolve(dir);
      const lower = resolved.toLowerCase();
      if (
        fs.existsSync(resolved) &&
        !currentPath.includes(lower) &&
        !found.some(f => f.toLowerCase() === lower)
      ) {
        found.push(resolved);
      }
    } catch (_) { /* skip */ }
  }

  // Explicit override — operators can fix this without code changes.
  if (process.env.CLAUDE_BIN_DIR) tryAdd(process.env.CLAUDE_BIN_DIR);

  if (isWin) {
    // npm install -g on Windows drops claude.cmd / claude.ps1 here.
    if (process.env.APPDATA) tryAdd(path.join(process.env.APPDATA, 'npm'));
    // Standalone installers (e.g. the claude.ai install script) and other
    // XDG-ish locations now common on Windows too.
    tryAdd(path.join(home, '.local', 'bin'));
    tryAdd(path.join(home, '.bun', 'bin'));
    tryAdd(path.join(home, '.cargo', 'bin'));
    if (process.env.LOCALAPPDATA) {
      tryAdd(path.join(process.env.LOCALAPPDATA, 'pnpm'));
      tryAdd(path.join(process.env.LOCALAPPDATA, 'Yarn', 'bin'));
    }
  } else {
    tryAdd(path.join(home, '.local', 'bin'));
    tryAdd(path.join(home, '.npm-global', 'bin'));
    tryAdd(path.join(home, '.bun', 'bin'));
    tryAdd(path.join(home, '.cargo', 'bin'));
    tryAdd(path.join(home, '.local', 'share', 'pnpm'));
    tryAdd(path.join(home, '.yarn', 'bin'));
  }

  if (found.length > 0) {
    console.log('[Terminal] Discovered dev-CLI paths:', found);
  }

  return found;
}

let _cachedDevCliPaths = null;
function getDevCliPaths() {
  if (_cachedDevCliPaths === null) {
    _cachedDevCliPaths = discoverDevCliPaths();
  }
  return _cachedDevCliPaths;
}


/**
 * Spawn a PTY process. This is the single point to replace with
 * `docker exec -it <container> /bin/bash` when containerisation lands.
 *
 * @param {object} opts
 * @param {string} opts.cwd   - Working directory for the shell
 * @param {number} opts.cols  - Initial column count
 * @param {number} opts.rows  - Initial row count
 * @param {object} [opts.env] - Extra environment variables
 * @returns {{ ptyProcess: IPty, shell: string }}
 */
function createPtyProcess({ cwd, cols = 80, rows = 24, env = {}, shellType = null }) {
  // Resolve requested shell type, or fall back to platform default
  const resolved = shellType ? resolveShellType(shellType) : null;
  const shell = resolved ? resolved.executable : getDefaultShell();
  const shellArgs = resolved ? resolved.args : getDefaultShellArgs(shell);

  // Build a clean environment: inherit process.env, add overrides, strip
  // anything that could leak server internals.
  const ptyEnv = Object.assign({}, process.env, env, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  });

  const homeDir = os.homedir();
  if (!ptyEnv.HOME || !path.isAbsolute(ptyEnv.HOME) || !fs.existsSync(ptyEnv.HOME)) {
    ptyEnv.HOME = homeDir;
  }

  // Prepend discovered SDK paths (Flutter, Dart, Android, etc.) and per-user
  // dev-CLI bin dirs (Claude Code, npm-global on Windows, ~/.local/bin) to PATH.
  const extraPaths = getSdkPaths().concat(getDevCliPaths());
  if (extraPaths.length > 0) {
    const sep = os.platform() === 'win32' ? ';' : ':';
    ptyEnv.PATH = extraPaths.join(sep) + sep + (ptyEnv.PATH || '');
  }

  // Display the workspace cwd as "~" in the prompt so users don't see the
  // long /data/repos/<slug>/<userId> prefix on every line. We only inject a
  // PS1 for sh-family shells (ash on Alpine, bash, zsh, dash, ksh) — fish
  // uses a function, and Windows shells use their own prompt mechanism, so
  // we leave those alone. Operators can opt out with SYNTHI_NO_PS1=1.
  if (cwd && !process.env.SYNTHI_NO_PS1) {
    ptyEnv.WORKSPACE_DIR = cwd;
    const shellName = path.basename(shell || '').toLowerCase().replace(/\.exe$/, '');
    if (['sh', 'bash', 'dash', 'ash', 'zsh', 'ksh'].includes(shellName)) {
      // POSIX-safe: case + parameter expansion re-evaluated on every prompt.
      //   $WORKSPACE_DIR        → "~"
      //   $WORKSPACE_DIR/sub    → "~/sub"
      //   anywhere else         → absolute $PWD (so users can see when they
      //                           cd outside the workspace)
      ptyEnv.PS1 =
        '$(case "$PWD" in ' +
        '"$WORKSPACE_DIR") printf "~";; ' +
        '"$WORKSPACE_DIR"/*) printf "~%s" "${PWD#$WORKSPACE_DIR}";; ' +
        '*) printf "%s" "$PWD";; ' +
        'esac) $ ';
    }
  }

  // Remove sensitive server-side variables
  delete ptyEnv.DATABASE_URL;
  delete ptyEnv.GOOGLE_APPLICATION_CREDENTIALS;
  delete ptyEnv.GCS_BUCKET;

  const ptyProcess = pty.spawn(shell, shellArgs, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: ptyEnv,
    // On Windows, use ConPTY (default in modern node-pty)
    useConpty: os.platform() === 'win32',
  });

  return { ptyProcess, shell };
}

// ─── Workspace CWD Resolution ───────────────────────────────────────────────

// Import REPOS_DIR from the shared config so we honour the REPOS_DIR env
// var (matching gitService). Previously this module hard-coded
// `path.resolve(__dirname, 'repos')`, which silently diverged from
// gitService.baseDir in hosted environments where `process.env.REPOS_DIR`
// points at a mounted volume (e.g. `/data/repos`). That mismatch caused
// the terminal to spawn in the wrong directory (or fall back to $HOME)
// while the user's files lived elsewhere.
const { REPOS_DIR } = require('./config');

/**
 * Sanitise userId the same way gitService.getUserRepoPath does, so the
 * terminal and gitService agree on the per-user directory name even when
 * the userId contains characters outside the safe charset.
 */
function _safeUserId(userId) {
  if (!userId) return '';
  return String(userId).replace(/[^a-zA-Z0-9_@.\-]/g, '_');
}

/**
 * Resolve the on-disk working directory for a workspace slug.
 *
 * Local:  <collab-server>/repos/<slug>            (gitService default)
 * Cloud:  $WORKSPACE_ROOT/<slug> | $REPOS_DIR/<slug>
 *
 * If the workspace directory does not exist yet (brand-new workspace
 * with no files written, or fresh per-user clone not yet materialised),
 * we create it instead of falling back to $HOME. Falling back to $HOME
 * was the source of the long-standing "empty linux panel" complaint:
 * the terminal opened correctly but cd'd into the user's home dir, so
 * the AI's `npm install` / `ls` etc. could not see the workspace files.
 *
 * Set the WORKSPACE_ROOT env var to override the base path (useful for
 * Docker / K8s where the volume mount differs from the local layout).
 */
async function resolveWorkspaceCwd(slug, userId) {
  const fsp = require('fs').promises;
  // Env var priority — match every var the rest of the stack uses so
  // hosted deployments don't break just because the operator set the
  // var the *other* service expects:
  //   WORKSPACE_ROOT      → explicit override for the terminal
  //   REPOS_DIR           → collab-server canonical (config.js, gitService)
  //   SYNTHI_REPOS_PATH   → ai-engine convention (Python side)
  //   REPOS_DIR (default) → the resolved value baked at module load
  const baseDir =
    process.env.WORKSPACE_ROOT ||
    process.env.REPOS_DIR ||
    process.env.SYNTHI_REPOS_PATH ||
    REPOS_DIR;
  const safeId = _safeUserId(userId);

  if (slug) {
    // 1. Per-user directory: repos/<slug>/<userId>  (matches gitService layout)
    if (safeId) {
      const perUserDir = path.join(baseDir, slug, safeId);
      try {
        await fsp.access(perUserDir);
        console.log(`[Terminal] resolveWorkspaceCwd: per-user dir ${perUserDir}`);
        return perUserDir;
      } catch (_) {}
    }
    // 2. Workspace root: repos/<slug>
    const wsDir = path.join(baseDir, slug);
    try {
      await fsp.access(wsDir);
      console.log(`[Terminal] resolveWorkspaceCwd: shared workspace dir ${wsDir}`);
      return wsDir;
    } catch (_) {}

    // 3. Neither exists yet — create the per-user dir (preferred) or the
    //    slug dir. mkdir is recursive so the baseDir parent is created
    //    if absent. We log so disk-layout surprises are debuggable.
    const target = safeId ? path.join(baseDir, slug, safeId) : path.join(baseDir, slug);
    try {
      await fsp.mkdir(target, { recursive: true });
      console.log(`[Terminal] resolveWorkspaceCwd: created ${target} (was missing)`);
      return target;
    } catch (err) {
      console.warn(`[Terminal] resolveWorkspaceCwd: failed to create ${target}: ${err.message}`);
    }
  }
  // 4. Last resort: base directory itself, then $HOME (truly unrecoverable).
  // Log loudly — if you see this in container logs, your terminal is at
  // $HOME and nothing the AI runs will see workspace files.
  try {
    await fsp.access(baseDir);
    console.warn(`[Terminal] resolveWorkspaceCwd: FALLBACK to baseDir ${baseDir} (slug=${slug}, userId=${userId})`);
    return baseDir;
  } catch (_) {}
  console.error(`[Terminal] resolveWorkspaceCwd: FALLBACK TO $HOME — baseDir ${baseDir} does not exist (slug=${slug}, userId=${userId})`);
  return os.homedir();
}

// ─── Input Validation ───────────────────────────────────────────────────────

/**
 * Validate and parse a JSON control message from the client.
 * Returns null if the message is malformed.
 */
function parseControlMessage(raw) {
  try {
    const msg = JSON.parse(raw);
    if (!msg || typeof msg !== 'object' || !msg.type) return null;
    return msg;
  } catch (_) {
    return null;
  }
}

/**
 * Validate resize dimensions to prevent absurd values.
 */
function sanitizeResize(cols, rows) {
  const c = Math.max(1, Math.min(500, Math.floor(Number(cols) || 80)));
  const r = Math.max(1, Math.min(200, Math.floor(Number(rows) || 24)));
  return { cols: c, rows: r };
}

// ─── WebSocket Server Factory ───────────────────────────────────────────────

/**
 * Create a WebSocket.Server for the terminal service. The returned object
 * exposes `handleUpgrade(req, socket, head)` for integration with the main
 * HTTP server's `upgrade` event.
 *
 * @returns {{ wss: WebSocket.Server, handleUpgrade: Function }}
 */
/**
 * Create a headless PTY session (no WebSocket yet).
 * Used by /exec-terminal to run a command in a real PTY that the
 * frontend can later connect to and see.
 *
 * @param {string} sessionId - Pre-determined session ID
 * @param {string} slug      - Workspace slug
 * @param {number} cols      - Terminal columns (default 120)
 * @param {number} rows      - Terminal rows (default 30)
 * @returns {{ ptyProcess, shell, cwd, sessionId }}
 */
async function createHeadlessSession(sessionId, slug, userId, cols = 120, rows = 30) {
  const cwd = await resolveWorkspaceCwd(slug, userId);
  const { ptyProcess, shell } = createPtyProcess({ cwd, cols, rows });

  // Buffer output so we can replay it when the frontend connects
  const outputBuffer = [];
  const MAX_BUFFER = 100_000; // characters
  let bufferLen = 0;
  let bufferingActive = true; // Flag to stop buffering when WS connects
  const onData = (data) => {
    if (bufferingActive && bufferLen < MAX_BUFFER) {
      outputBuffer.push(data);
      bufferLen += data.length;
    }
  };
  ptyProcess.onData(onData);

  // Store in activeSessions — the WebSocket handler will detect this
  activeSessions.set(sessionId, {
    pty: ptyProcess,
    ws: null,           // No WebSocket yet — frontend will connect later
    cwd,
    shell,
    unwatchFs: () => {},
    headless: true,     // Flag so WSS handler knows to reattach
    outputBuffer,       // Buffered output for replay
    stopBuffering: () => { bufferingActive = false; }, // Stop buffering on WS connect
  });

  console.log(`[Terminal] Headless session ${sessionId} created | cwd=${cwd} | shell=${shell}`);
  return { ptyProcess, shell, cwd, sessionId };
}

function createTerminalWSS() {
  // PERF: Enable permessage-deflate — terminal output (ANSI sequences, build
  // logs) compresses extremely well.  Level 1 keeps CPU usage minimal.
  const wss = new WebSocket.Server({
    noServer: true,
    perMessageDeflate: {
      zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 1 },
      zlibInflateOptions: { chunkSize: 10 * 1024 },
      clientNoContextTakeover: true,
      serverNoContextTakeover: true,
      serverMaxWindowBits: 10,
      concurrencyLimit: 10,
      threshold: 128,
    },
  });

  wss.on('connection', async (ws, req) => {
    // ── Parse query parameters ──────────────────────────────────────────
    let parsedUrl;
    try {
      parsedUrl = new URL(req.url, 'http://localhost');
    } catch (_) {
      parsedUrl = new URL('/terminal', 'http://localhost');
    }

    const requestedSessionId = parsedUrl.searchParams.get('sessionId');
    const workspaceSlug = parsedUrl.searchParams.get('workspace') || '';
    const requestedUserId = parsedUrl.searchParams.get('userId') || '';
    const initialCols = parseInt(parsedUrl.searchParams.get('cols'), 10) || 80;
    const initialRows = parseInt(parsedUrl.searchParams.get('rows'), 10) || 24;
    const requestedShellType = parsedUrl.searchParams.get('shell') || null;

    // ── Check for existing headless session (AI-created terminal) ───────
    const existingSession = requestedSessionId && activeSessions.get(requestedSessionId);
    if (existingSession && existingSession.headless && existingSession.pty) {
      const sessionId = requestedSessionId;
      const { pty: ptyProcess, shell, cwd, outputBuffer, stopBuffering } = existingSession;

      console.log(`[Terminal] Reattaching WS to headless session ${sessionId} | cwd=${cwd} | buffered=${outputBuffer.length} chunks`);

      // Stop the headless buffer from growing now that we have a WS
      if (stopBuffering) stopBuffering();

      // Start filesystem watcher now that we have a WebSocket
      let unwatchFs = () => {};
      if (workspaceSlug) {
        unwatchFs = watchWorkspace(workspaceSlug, cwd, (fsMsg) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(fsMsg));
          }
        });
      }

      // Update session: replace headless state with full WebSocket session
      activeSessions.set(sessionId, { pty: ptyProcess, ws, cwd, shell, unwatchFs, headless: false });

      // Send ready acknowledgement
      ws.send(JSON.stringify({
        type: 'ready',
        sessionId,
        shell: path.basename(shell),
        cwd,
        pid: ptyProcess.pid,
      }));

      // Replay buffered output so the user sees what already happened
      if (outputBuffer && outputBuffer.length > 0) {
        const replay = outputBuffer.join('');
        ws.send(Buffer.from(replay, 'utf-8'), { binary: true });
      }

      // Signal the frontend that the replay is complete
      ws.send(JSON.stringify({ type: 'replay-done' }));

      // Attach the WS-forwarding listener for live output going forward
      // (the old headless buffering listener is stopped via stopBuffering)
      const onPtyData = (data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(Buffer.from(data, 'utf-8'), { binary: true });
        }
      };
      ptyProcess.onData(onPtyData);

      // ── PTY exit handler ──────────────────────────────────────────────
      ptyProcess.onExit(({ exitCode, signal }) => {
        console.log(`[Terminal] Session ${sessionId} exited (code=${exitCode}, signal=${signal})`);
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'exit', code: exitCode, signal }));
          ws.close(1000, 'PTY exited');
        }
        activeSessions.delete(sessionId);
      });

      // ── WebSocket → PTY (input) ──────────────────────────────────────
      ws.on('message', (rawData, isBinary) => {
        if (isBinary) {
          const str = Buffer.isBuffer(rawData) ? rawData.toString('utf-8') : rawData;
          ptyProcess.write(str);
          return;
        }
        const text = typeof rawData === 'string' ? rawData : rawData.toString('utf-8');
        const msg = parseControlMessage(text);
        if (!msg) { ptyProcess.write(text); return; }
        switch (msg.type) {
          case 'resize': {
            const { cols, rows } = sanitizeResize(msg.cols, msg.rows);
            try { ptyProcess.resize(cols, rows); } catch (_) {}
            break;
          }
          case 'ping':
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'pong' }));
            break;
          case 'input':
            if (typeof msg.data === 'string') ptyProcess.write(msg.data);
            break;
        }
      });

      ws.on('close', (code) => {
        console.log(`[Terminal] WS closed for reattached session ${sessionId} (code=${code})`);
        try { unwatchFs(); } catch (_) {}
        try { ptyProcess.kill(); } catch (_) {}
        activeSessions.delete(sessionId);
      });

      ws.on('error', (err) => {
        console.error(`[Terminal] WS error for reattached session ${sessionId}:`, err.message);
        try { unwatchFs(); } catch (_) {}
        try { ptyProcess.kill(); } catch (_) {}
        activeSessions.delete(sessionId);
      });

      return; // Done — skip normal session creation below
    }

    // ── Generate session ID ─────────────────────────────────────────────
    const sessionId = requestedSessionId || crypto.randomUUID();
    const cwd = await resolveWorkspaceCwd(workspaceSlug, requestedUserId);

    console.log(`[Terminal] New session ${sessionId} | workspace=${workspaceSlug} | userId=${requestedUserId} | cwd=${cwd} | shell=${requestedShellType || 'default'}`);


    // ── Spawn PTY ───────────────────────────────────────────────────────
    let ptyProcess, shell;
    try {
      ({ ptyProcess, shell } = createPtyProcess({
        cwd,
        cols: initialCols,
        rows: initialRows,
        shellType: requestedShellType,
      }));
    } catch (err) {
      console.error(`[Terminal] Failed to spawn PTY for session ${sessionId}:`, err.message);
      ws.send(JSON.stringify({ type: 'error', message: 'Failed to spawn shell: ' + err.message }));
      ws.close(1011, 'PTY spawn failed');
      return;
    }

    // ── Start filesystem watcher for this workspace ────────────────────
    let unwatchFs = () => {};
    if (workspaceSlug) {
      unwatchFs = watchWorkspace(workspaceSlug, cwd, (fsMsg) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(fsMsg));
        }
      });
    }

    // Register session
    activeSessions.set(sessionId, { pty: ptyProcess, ws, cwd, shell, unwatchFs });

    // ── Send ready acknowledgement ──────────────────────────────────────
    ws.send(JSON.stringify({
      type: 'ready',
      sessionId,
      shell: path.basename(shell),
      cwd,
      pid: ptyProcess.pid,
    }));

    // ── PTY → WebSocket (output hot path) ───────────────────────────────
    // node-pty fires 'data' with string chunks. We forward them as-is
    // (text WebSocket frames) for minimum latency — no JSON wrapping.
    const onPtyData = (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        // Send as binary for maximum throughput and to distinguish from
        // JSON control frames the client sends as text.
        ws.send(Buffer.from(data, 'utf-8'), { binary: true });
      }
    };
    ptyProcess.onData(onPtyData);

    // ── PTY exit ────────────────────────────────────────────────────────
    ptyProcess.onExit(({ exitCode, signal }) => {
      console.log(`[Terminal] Session ${sessionId} exited (code=${exitCode}, signal=${signal})`);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'exit', code: exitCode, signal }));
        ws.close(1000, 'PTY exited');
      }
      activeSessions.delete(sessionId);
    });

    // ── WebSocket → PTY (input) ─────────────────────────────────────────
    ws.on('message', (rawData, isBinary) => {
      // Binary frames = raw keystroke data → write directly to PTY
      if (isBinary) {
        const str = Buffer.isBuffer(rawData) ? rawData.toString('utf-8') : rawData;
        ptyProcess.write(str);
        return;
      }

      // Text frames = JSON control messages
      const text = typeof rawData === 'string' ? rawData : rawData.toString('utf-8');
      const msg = parseControlMessage(text);

      if (!msg) {
        // If it's not valid JSON, treat as raw input (defensive)
        ptyProcess.write(text);
        return;
      }

      switch (msg.type) {
        case 'resize': {
          const { cols, rows } = sanitizeResize(msg.cols, msg.rows);
          try {
            ptyProcess.resize(cols, rows);
          } catch (err) {
            console.warn(`[Terminal] Resize failed for ${sessionId}:`, err.message);
          }
          break;
        }

        case 'ping':
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'pong' }));
          }
          break;

        case 'input':
          // Alternative JSON-wrapped input path (for clients that prefer it)
          if (typeof msg.data === 'string') {
            ptyProcess.write(msg.data);
          }
          break;

        default:
          // Unknown control message — ignore silently
          break;
      }
    });

    // ── WebSocket close → kill PTY + stop watcher ────────────────────────
    ws.on('close', (code, reason) => {
      console.log(`[Terminal] WS closed for session ${sessionId} (code=${code})`);
      try { unwatchFs(); } catch (_) {}
      try { ptyProcess.kill(); } catch (_) { /* already dead */ }
      activeSessions.delete(sessionId);
    });

    ws.on('error', (err) => {
      console.error(`[Terminal] WS error for session ${sessionId}:`, err.message);
      try { unwatchFs(); } catch (_) {}
      try { ptyProcess.kill(); } catch (_) { /* ignore */ }
      activeSessions.delete(sessionId);
    });
  });

  // ── Upgrade handler for the main HTTP server ──────────────────────────
  function handleUpgrade(request, socket, head) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  }

  return { wss, handleUpgrade };
}

// ─── Exports ────────────────────────────────────────────────────────────────

/**
 * Broadcast a message to all connected terminal sessions.
 * Used by the proxy service to notify frontends about port changes.
 */
function broadcastToAll(message) {
  const payload = typeof message === 'string' ? message : JSON.stringify(message);
  for (const [, session] of activeSessions) {
    if (session.ws && session.ws.readyState === WebSocket.OPEN) {
      session.ws.send(payload);
    }
  }
}

module.exports = {
  createTerminalWSS,
  createHeadlessSession,
  activeSessions,
  broadcastToAll,
  getDefaultShell,
  getAvailableShells,
  resolveShellType,
  resolveWorkspaceCwd,
  SHELL_REGISTRY,
};
