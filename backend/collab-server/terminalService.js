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
  // Unix: respect $SHELL, fall back to /bin/bash then /bin/sh
  return process.env.SHELL || '/bin/bash';
}

// ─── Shell Registry ─────────────────────────────────────────────────────────

/**
 * Known shell types mapped to their executable names per platform.
 * Each entry has { win32, unix, args, label }.
 */
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
    win32: 'bash.exe',  // Git Bash or WSL
    unix: '/bin/bash',
    args: { win32: [], unix: ['--login'] },
    label: 'Bash',
  },
  gitbash: {
    win32: 'C:\\Program Files\\Git\\bin\\bash.exe',
    unix: null,
    args: { win32: ['--login', '-i'], unix: [] },
    label: 'Git Bash',
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
  const executable = entry[platform];
  if (!executable) return null;

  const args = entry.args?.[platform] || [];
  return { executable, args, label: entry.label };
}

/**
 * Detect which shells are available on the current system.
 * Returns an array of { key, label, executable } for shells that exist on disk.
 */
function getAvailableShells() {
  const platform = os.platform() === 'win32' ? 'win32' : 'unix';
  const available = [];

  for (const [key, entry] of Object.entries(SHELL_REGISTRY)) {
    const executable = entry[platform];
    if (!executable) continue;

    // Check if the executable exists
    try {
      // Absolute paths: check directly. Relative names: rely on PATH
      if (path.isAbsolute(executable)) {
        if (fs.existsSync(executable)) {
          available.push({ key, label: entry.label, executable });
        }
      } else {
        // For non-absolute executables, assume available (they're on PATH)
        // A more thorough check would use `which` or `where`, but this is
        // fast enough for the common case.
        available.push({ key, label: entry.label, executable });
      }
    } catch (_) { /* skip */ }
  }

  return available;
}

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
  const shellArgs = resolved ? resolved.args : (os.platform() === 'win32' ? [] : ['--login']);

  // Build a clean environment: inherit process.env, add overrides, strip
  // anything that could leak server internals.
  const ptyEnv = Object.assign({}, process.env, env, {
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
  });

  // Prepend discovered SDK paths (Flutter, Dart, Android, etc.) to PATH
  const sdkPaths = getSdkPaths();
  if (sdkPaths.length > 0) {
    const sep = os.platform() === 'win32' ? ';' : ':';
    ptyEnv.PATH = sdkPaths.join(sep) + sep + (ptyEnv.PATH || '');
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

const REPOS_DIR = path.resolve(__dirname, 'repos');

/**
 * Resolve the on-disk working directory for a workspace slug.
 *
 * Local:  <collab-server>/repos/<slug>   (where gitService clones workspace files)
 * Cloud:  /workspace/<slug>              (mounted volume in the container)
 *
 * Set the WORKSPACE_ROOT env var to override the base path (useful for
 * Docker / K8s where the volume mount differs from the local layout).
 */
function resolveWorkspaceCwd(slug, userId) {
  const baseDir = process.env.WORKSPACE_ROOT || REPOS_DIR;

  if (slug) {
    // 1. Try per-user directory: repos/<slug>/<userId>  (matches gitService layout)
    if (userId) {
      const perUserDir = path.join(baseDir, slug, userId);
      try {
        if (fs.existsSync(perUserDir)) return perUserDir;
      } catch (_) { /* ignore */ }
    }
    // 2. Fall back to workspace root: repos/<slug>
    const wsDir = path.join(baseDir, slug);
    try {
      if (fs.existsSync(wsDir)) return wsDir;
    } catch (_) { /* ignore */ }
  }
  // 3. Fallback: base directory itself, then $HOME
  try {
    if (fs.existsSync(baseDir)) return baseDir;
  } catch (_) { /* ignore */ }
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
function createHeadlessSession(sessionId, slug, userId, cols = 120, rows = 30) {
  const cwd = resolveWorkspaceCwd(slug, userId);
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
  const wss = new WebSocket.Server({ noServer: true });

  wss.on('connection', (ws, req) => {
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
    const cwd = resolveWorkspaceCwd(workspaceSlug, requestedUserId);

    console.log(`[Terminal] New session ${sessionId} | workspace=${workspaceSlug} | userId=${requestedUserId} | cwd=${cwd}`);


    // ── Spawn PTY ───────────────────────────────────────────────────────
    let ptyProcess, shell;
    try {
      ({ ptyProcess, shell } = createPtyProcess({
        cwd,
        cols: initialCols,
        rows: initialRows,
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
