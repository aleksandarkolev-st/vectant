"use client";

import { memo, useCallback, useDeferredValue, useEffect, useRef, useState } from 'react';
import { useSelector } from 'react-redux';
import { BranchSelector } from '@/components/git/BranchSelector';
import { selectCursorPosition } from '@/redux/uiSlice';
import { selectActiveFile } from '@/redux/workspaceSlice';
import { selectLanguageAndFramework } from '@/redux/compileManifestSlice';
import { getMonacoLanguage } from '@/utils/languageMapper';
import { useCollabStatus } from '@/hooks/useCollabStatus';
import { useCollabSession } from '@/hooks/useCollabSession';
import { useWorkspacePresence } from '@/hooks/useWorkspacePresence';
import { getCurrentUser } from '@/services/userIdentity';
import { AlertCircle, AlertTriangle, Cpu, Zap, Loader2, Wifi, WifiOff, Radio, Users, Square, RotateCw, GripVertical } from 'lucide-react';
import { HealingIndicator } from '@/components/healing/HealingIndicator';
import OperatorStatusBarButton from './OperatorStatusBarButton';

const STATUS_ISLAND_OFFSET_KEY = 'synthi:status-island-offset';
// Mouse must travel ≥5px from the mousedown point before we promote a
// press-and-hold into a drag — small enough that intentional drags feel
// responsive, large enough that a sloppy click never moves the island.
const DRAG_THRESHOLD_PX = 5;

/**
 * StatusBar Component - Synthi styled bottom status bar
 * Contains: Branch selector, Compiler status, Line/Column info, etc.
 * Features pill/badge shaped status indicators
 *
 * PERF: All selectors are deferred via useDeferredValue so the StatusBar
 *       never blocks Monaco's critical rendering path. React will schedule
 *       StatusBar re-renders in a lower-priority lane.
 */

const StatusBarCursorInfo = memo(function StatusBarCursorInfo() {
  const positionRaw = useSelector(selectCursorPosition);
  const position = useDeferredValue(positionRaw);
  return (
    <div className="flex items-center gap-1 px-2 py-0.5 rounded-md cursor-pointer transition-colors" title={`Line ${position.lineNumber}, Column ${position.column}`}>
      {/* Wide form: "Ln 6 : Col 29" — only when the island can spare the room */}
      <span className="hidden 2xl:inline font-medium" style={{ color: 'var(--text-secondary)' }}>Ln {position.lineNumber}</span>
      <span className="hidden 2xl:inline" style={{ color: 'var(--text-dim)' }}>:</span>
      <span className="hidden 2xl:inline font-medium" style={{ color: 'var(--text-secondary)' }}>Col {position.column}</span>
      {/* Compact form: "6:29" — default on narrower islands */}
      <span className="2xl:hidden font-medium tabular-nums" style={{ color: 'var(--text-secondary)' }}>
        {position.lineNumber}:{position.column}
      </span>
    </div>
  );
});

// Total duration of the first-mount entrance animation (shape morph +
// content stagger + tail). Keep this aligned with the CSS timing so the
// entrance classes are removed right after the motion settles instead of
// hanging around and making the pill feel jittery.
const STATUS_ISLAND_ENTRANCE_MS = 980;

function StatusBarInner({
  slug,
  compilerStatus = 'disconnected',
  diagnosticSummary = { errors: 0, warnings: 0, total: 0 },
  isAnalyzing = false,
  onProblemsClick,
  extensionStatusBarItems = [],
  vscodeServerState = 'disconnected',
  // Build-controls island (desktop): renders Stop + Restart while a build
  // is running. Hidden when isRunning is falsy. On mobile these controls
  // live in the TopNav instead (sm:hidden vs hidden sm:flex).
  isRunning = false,
  onStop,
  onReload,
}) {
  // Entrance animation gate. The island enters as a small circular seed
  // in the centre, then unfurls horizontally into the pill. We only
  // animate on first mount — once the timer elapses we drop the
  // entrance class so React re-renders don't replay the keyframes when
  // unrelated state (cursor position, build status, …) changes.
  const [isEntering, setIsEntering] = useState(true);
  useEffect(() => {
    const timer = window.setTimeout(() => setIsEntering(false), STATUS_ISLAND_ENTRANCE_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // ── Draggable island position ────────────────────────────────────
  // The pill sits centred at the bottom of the workspace by default,
  // but the user can drag it via the grip handle to reposition. The
  // offset is persisted to localStorage so the position survives
  // reloads. A 5-px drag threshold (DRAG_THRESHOLD_PX) prevents a
  // missed click on the handle from accidentally moving the island.
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const [isDragging, setIsDragging] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const saved = window.localStorage?.getItem(STATUS_ISLAND_OFFSET_KEY);
      if (!saved) return;
      const parsed = JSON.parse(saved);
      if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') {
        setOffset({ x: parsed.x, y: parsed.y });
      }
    } catch {
      // Ignore malformed JSON or storage access failures.
    }
  }, []);

  const persistOffset = useCallback((next) => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage?.setItem(STATUS_ISLAND_OFFSET_KEY, JSON.stringify(next));
    } catch {
      // Storage is best-effort; the in-memory offset still works.
    }
  }, []);

  const handleDragMouseDown = useCallback((event) => {
    if (event.button !== 0) return; // left button only
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    const startOffset = offsetRef.current;
    let promoted = false;
    let pendingOffset = startOffset;

    const handleMouseMove = (moveEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      if (!promoted) {
        if (Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) {
          return;
        }
        promoted = true;
        setIsDragging(true);
        document.body.style.cursor = 'grabbing';
      }
      pendingOffset = { x: startOffset.x + dx, y: startOffset.y + dy };
      setOffset(pendingOffset);
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      if (promoted) {
        setIsDragging(false);
        persistOffset(pendingOffset);
      }
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  }, [persistOffset]);

  const handleDragDoubleClick = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    setOffset({ x: 0, y: 0 });
    if (typeof window !== 'undefined') {
      try {
        window.localStorage?.removeItem(STATUS_ISLAND_OFFSET_KEY);
      } catch {
        // Ignore — the in-memory reset already happened.
      }
    }
  }, []);

  const hasOffset = offset.x !== 0 || offset.y !== 0;
  // PERF: Defer all Redux reads so StatusBar never blocks the editor
  const currentBranchRaw = useSelector(state => state.git?.currentBranch);
  const currentBranch = useDeferredValue(currentBranchRaw);
  const activeFileRaw = useSelector(selectActiveFile);
  const activeFile = useDeferredValue(activeFileRaw);
  // ULTRAPLAN Phase 8: show the AI-detected framework alongside the
  // file-extension-derived language. Parsed from the arch cache at
  // dispatch time so this read is O(1). Null when no compile has
  // run yet or the arch cache didn't contain a "Language & Framework"
  // section.
  const languageAndFrameworkRaw = useSelector(selectLanguageAndFramework);
  const languageAndFramework = useDeferredValue(languageAndFrameworkRaw);

  // Defer props that change frequently during typing
  const deferredSummary = useDeferredValue(diagnosticSummary);
  const deferredIsAnalyzing = useDeferredValue(isAnalyzing);
  
  // Detect language from active file extension
  const language = activeFile?.name ? getMonacoLanguage(activeFile.name) : 'plaintext';
  
  // Determine compiler status styling with better contrast for critical states
  const getCompilerStatusStyle = () => {
    switch (compilerStatus) {
      case 'connected':
        return { 
          dotStyle: { background: 'var(--accent-success)' }, 
          text: 'Connected',
          pillBorder: { borderColor: 'color-mix(in srgb, var(--accent-success) 30%, transparent)' },
          textStyle: { color: 'var(--accent-success)' }
        };
      case 'connecting':
        return { 
          dotCls: 'animate-pulse', 
          dotStyle: { background: 'var(--accent-warning)' }, 
          text: 'Connecting...',
          pillBorder: { borderColor: 'color-mix(in srgb, var(--accent-warning) 30%, transparent)' },
          textStyle: { color: 'var(--accent-warning)' }
        };
      case 'error':
        return { 
          dotCls: 'animate-pulse', 
          dotStyle: { background: 'var(--accent-danger)' }, 
          text: 'Error',
          pillBorder: { borderColor: 'color-mix(in srgb, var(--accent-danger) 30%, transparent)' },
          textStyle: { color: 'var(--accent-danger)', fontWeight: 600 }
        };
      case 'disconnected':
      default:
        return { 
          dotStyle: { background: 'var(--text-muted)' }, 
          text: 'Disconnected',
          pillBorder: { borderColor: 'var(--border-medium)' },
          textStyle: { color: 'var(--text-muted)' }
        };
    }
  };
  
  const statusStyle = getCompilerStatusStyle();
  
  // Aggregated collaboration WebSocket status
  const collabStatus = useCollabStatus();
  const { role: sessionRole, guests, isHost, isGuest, session } = useCollabSession();
  const { activeUsers } = useWorkspacePresence(slug);
  const currentUserId = getCurrentUser()?.id;
  const otherUserCount = activeUsers ? activeUsers.filter(u => u.userId !== currentUserId).length : 0;
  const getCollabStyle = () => {
    switch (collabStatus) {
      case 'connected':
        return { dot: 'bg-[#4ade80]', text: 'Synced', textColor: 'text-[#4ade80]', Icon: Wifi };
      case 'connecting':
        return { dot: 'bg-[#fbbf24] animate-pulse', text: 'Syncing…', textColor: 'text-[#fbbf24]', Icon: Wifi };
      case 'disconnected':
      default:
        return { dot: 'bg-[#ff5757]', text: 'Offline', textColor: 'text-[#ff5757]', Icon: WifiOff };
    }
  };
  const collabStyle = getCollabStyle();
  
  // Determine if there are problems to show (use deferred values)
  const hasProblems = deferredSummary.errors > 0 || deferredSummary.warnings > 0;

  // Floating "island" status bar — three zones inside a single
  // rounded frosted-glass pill that hovers above the editor.
  // The outer .status-bar-root keeps reserved vertical space in the
  // workspace flex column; the inner .status-island is the visible
  // floating surface.
  // The stage sizes to its content (the pill) so the halo's inset-[-1px]
  // hugs the actual gradient ring instead of stretching across the
  // wrapper's reserved min-w. The wrapper still reserves layout width
  // via min-w-[640px] outside the stage.
  const stageClassName = 'relative inline-block';

  const dragHandle = (
    <button
      type="button"
      className={[
        'status-island-drag-handle',
        isDragging ? 'is-dragging' : '',
        hasOffset ? 'status-island-drag-handle--moved' : '',
      ].filter(Boolean).join(' ')}
      onMouseDown={handleDragMouseDown}
      onDoubleClick={handleDragDoubleClick}
      title={hasOffset ? 'Drag to move • double-click to reset' : 'Drag to move'}
      aria-label="Drag to reposition the status island"
    >
      <GripVertical className="w-3 h-3" strokeWidth={2} />
    </button>
  );

  return (
    <div className="status-bar-root pointer-events-none absolute inset-x-0 bottom-3 z-30 px-3 flex items-end justify-center" style={{ background: 'transparent' }}>
      <div
        className="status-island-positioner pointer-events-auto"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px)` }}
      >
        <div className="relative w-auto min-w-[640px] max-w-[min(1100px,_calc(100vw-32px))]">
          {/* Build-controls island — hugs the right edge of the status island
              wrapper, vertically centered. Floats just outside the status pill
              so the status pill remains exactly centered on the page. Hidden
              on mobile (the inline TopNav stop/restart handles that case). */}
          {isRunning && (
            <div className="absolute left-full ml-2 top-1/2 -translate-y-1/2 hidden sm:block z-20">
              <div
                className="flex items-center gap-1 h-7 px-1.5 rounded-full"
                style={{
                  background: 'var(--bg-elevated)',
                  border: '1px solid color-mix(in srgb, var(--attention-purple) 38%, transparent)',
                  boxShadow:
                    '0 16px 40px -8px rgba(0,0,0,0.85), ' +
                    '0 0 18px -4px color-mix(in srgb, var(--attention-purple) 30%, transparent), ' +
                    'inset 0 1px 0 0 color-mix(in srgb, white 8%, transparent)',
                  backdropFilter: 'blur(14px) saturate(160%)',
                  WebkitBackdropFilter: 'blur(14px) saturate(160%)',
                }}
              >
                <button
                  type="button"
                  onClick={onStop}
                  title="Stop"
                  className="h-5 w-5 rounded-md flex items-center justify-center transition-all hover:scale-110 cursor-pointer"
                  style={{ color: '#ff5757' }}
                >
                  <Square className="w-3 h-3 fill-current" strokeWidth={2} />
                </button>
                <button
                  type="button"
                  onClick={onReload}
                  title="Restart"
                  className="h-5 w-5 rounded-md flex items-center justify-center transition-all hover:scale-110 cursor-pointer"
                  style={{ color: '#3d6dff' }}
                >
                  <RotateCw className="w-3 h-3" strokeWidth={2.25} />
                </button>
              </div>
            </div>
          )}
          {/* Stage — owns the entrance scaleX. Wraps halo + pill so they
              morph together and the gradient on the pill scales with its
              silhouette (so the rounded ends carry brand colour at every
              frame, instead of being cut off by a clip-path). */}
          <div className={stageClassName}>
            <div
              aria-hidden="true"
              className={`pointer-events-none absolute inset-[-1px] rounded-full ${isEntering ? 'status-island-entrance-halo' : ''}`}
              style={{
                background: 'var(--brand-gradient-horizontal)',
                filter: 'blur(5px)',
                opacity: isEntering ? 0 : 0.16,
                transform: isEntering ? 'translateZ(0) scale(0.92)' : 'translateZ(0) scale(1.006)',
              }}
            />
            {isEntering && (
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 rounded-full status-island-entrance-shadow"
                style={{
                  boxShadow: '0 16px 40px -8px rgba(0,0,0,0.85)',
                }}
              />
            )}
            <div
              className={`status-island relative z-10 h-7 rounded-full text-[11px] select-none font-[var(--font-ui)] whitespace-nowrap ${isEntering ? 'status-island-entrance-shell' : ''}`}
              style={{
                background:
                  'linear-gradient(var(--bg-elevated), var(--bg-elevated)) padding-box, var(--brand-gradient-horizontal) border-box',
                border: '1px solid transparent',
                boxShadow:
                  (isEntering
                    ? 'inset 0 1px 0 0 color-mix(in srgb, white 8%, transparent), ' +
                      'inset 0 -1px 0 0 color-mix(in srgb, black 30%, transparent)'
                    : '0 16px 40px -8px rgba(0,0,0,0.85), ' +
                      'inset 0 1px 0 0 color-mix(in srgb, white 8%, transparent), ' +
                      'inset 0 -1px 0 0 color-mix(in srgb, black 30%, transparent)'),
                backdropFilter: 'blur(14px) saturate(160%)',
                WebkitBackdropFilter: 'blur(14px) saturate(160%)',
              }}
            >
              <div className={`flex h-full items-center gap-x-3 px-4 ${isEntering ? 'status-island-entrance-content' : ''}`}>
              {/* ── LEFT ZONE — file/build state. flex-shrink-0 so a long
            language name in the right zone can't squeeze branch / problems
            into truncation. */}
      <div className="flex shrink-0 items-center gap-1">
        {/* Drag handle — the ONLY surface that initiates a drag. The
            5-px threshold inside handleDragMouseDown means a sloppy
            click can never accidentally reposition the island. */}
        {dragHandle}
        {/* Branch */}
        <div className="flex items-center rounded-md px-1">
          <BranchSelector slug={slug} />
        </div>

        {/* Problems */}
        <div
          onClick={onProblemsClick}
          className="flex items-center gap-1.5 px-2 py-0.5 rounded-md cursor-pointer transition-all hover:bg-[color-mix(in_srgb,var(--text-primary)_5%,transparent)]"
          style={hasProblems ? { background: 'color-mix(in srgb, var(--accent-danger) 4%, transparent)' } : {}}
        >
          {deferredIsAnalyzing ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: 'var(--text-secondary)' }} strokeWidth={2} />
              <span style={{ color: 'var(--text-secondary)' }}>Analyzing</span>
            </>
          ) : (
            <>
              <AlertCircle className="w-3.5 h-3.5" style={{ color: deferredSummary.errors > 0 ? 'var(--accent-danger)' : 'var(--text-muted)' }} strokeWidth={2} />
              <span style={deferredSummary.errors > 0 ? { color: 'var(--accent-danger)', fontWeight: 600 } : { color: 'var(--text-secondary)' }}>
                {deferredSummary.errors}
              </span>
              <AlertTriangle className="w-3.5 h-3.5 ml-0.5" style={{ color: deferredSummary.warnings > 0 ? 'var(--accent-warning)' : 'var(--text-muted)' }} strokeWidth={2} />
              <span style={deferredSummary.warnings > 0 ? { color: 'var(--accent-warning)', fontWeight: 600 } : { color: 'var(--text-secondary)' }}>
                {deferredSummary.warnings}
              </span>
            </>
          )}
        </div>

        {/* Compiler — keep the status encoded in the icon colour + tooltip
            so the island stays compact. */}
        <div className="flex items-center px-1.5 py-0.5 rounded-md transition-all cursor-default" title={`Compiler: ${statusStyle.text}`}>
          <Cpu className="w-3.5 h-3.5" style={statusStyle.textStyle} strokeWidth={2} />
        </div>
      </div>

      {/* ── CENTER ZONE — session / collaboration.
            Lives in the flex flow with flex-1 + justify-center so it sits
            in the available middle space without ever overlapping the
            side zones. Dead-centre would require absolute positioning,
            but the resulting overlap was strictly worse than a slight
            visual offset when side widths differ. */}
      <div className="flex-1 flex items-center justify-center gap-1 min-w-0">
        {/* Collab status — label hides below xl */}
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md transition-all cursor-default" title={`Collaboration: ${collabStyle.text}`}>
          <collabStyle.Icon className={`w-3.5 h-3.5 ${collabStyle.textColor}`} strokeWidth={2} />
          <div className={`w-1.5 h-1.5 rounded-full ${collabStyle.dot}`} />
          <span className={`${collabStyle.textColor} hidden 2xl:inline font-semibold`}>{collabStyle.text}</span>
          {otherUserCount > 0 && (
            <span className="flex items-center gap-1 ml-1" title={`${otherUserCount} other user${otherUserCount > 1 ? 's' : ''} online`}>
              <Users className="w-3 h-3" style={{ color: 'var(--text-muted)' }} strokeWidth={2} />
              <span className="font-semibold" style={{ color: 'var(--text-secondary)' }}>{otherUserCount}</span>
            </span>
          )}
        </div>

        {/* Operator */}
        <div className="flex items-center">
          <OperatorStatusBarButton sessionId={slug} />
        </div>

        {/* LIVE / Guest — keep the label even when cramped; this is a critical state */}
        {isHost && (
          <div
            className="vt-brand-pulse flex items-center gap-1.5 px-2 py-0.5 rounded-md cursor-default ml-1"
            title={`Live session — ${guests.length} guest(s)`}
            style={{
              background: 'color-mix(in srgb, var(--brand-stop-2) 8%, transparent)',
              border: '1px solid color-mix(in srgb, var(--brand-stop-2) 24%, transparent)',
            }}
          >
            <Radio className="w-3.5 h-3.5" style={{ color: 'var(--brand-stop-2)' }} strokeWidth={2} />
            <span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: 'var(--brand-stop-2)' }} />
            <span className="font-semibold" style={{ color: 'var(--brand-stop-2)' }}>LIVE</span>
          </div>
        )}
        {isGuest && (
          <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md cursor-default ml-1" title={`Connected to ${session?.hostName || 'Host'}'s session`}>
            <Users className="w-3.5 h-3.5" style={{ color: 'var(--accent-warning)' }} strokeWidth={2} />
            <span className="hidden 2xl:inline font-semibold" style={{ color: 'var(--accent-warning)' }}>Guest</span>
          </div>
        )}
      </div>

      {/* ── RIGHT ZONE — healing / extensions / cursor / language.
            shrink-0 so the language/framework labels stay readable in
            full instead of being truncated to "J…". */}
      <div className="flex shrink-0 items-center gap-1 mr-1">
        {/* Healing */}
        <HealingIndicator />

        {/* Extension-contributed status bar items */}
        {extensionStatusBarItems.filter(i => i.text).map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-1 px-2 py-0.5 rounded-md cursor-default transition-colors"
            title={item.tooltip || item.text}
          >
            <span className="font-medium text-[11px]" style={{ color: 'var(--text-secondary)' }}>{item.text}</span>
          </div>
        ))}

        {/* VS Code Server status */}
        {vscodeServerState !== 'disconnected' && (
          <div
            className="flex items-center gap-1.5 px-2 py-0.5 rounded-md cursor-default transition-colors"
            style={vscodeServerState === 'running'
              ? { background: 'color-mix(in srgb, var(--accent-success) 4%, transparent)' }
              : vscodeServerState === 'error'
              ? { background: 'color-mix(in srgb, var(--accent-danger) 4%, transparent)' }
              : {}}
            title={`VS Code Server: ${vscodeServerState}`}
          >
            <div
              className={`w-1.5 h-1.5 rounded-full ${vscodeServerState === 'connecting' ? 'animate-pulse' : ''}`}
              style={{
                background: vscodeServerState === 'running' ? 'var(--accent-success)'
                  : vscodeServerState === 'connecting' ? 'var(--accent-warning)'
                  : vscodeServerState === 'error' ? 'var(--accent-danger)'
                  : 'var(--text-muted)'
              }}
            />
            <span
              className="hidden 2xl:inline font-medium"
              style={{
                color: vscodeServerState === 'running' ? 'var(--accent-success)'
                  : vscodeServerState === 'connecting' ? 'var(--accent-warning)'
                  : vscodeServerState === 'error' ? 'var(--accent-danger)'
                  : 'var(--text-muted)'
              }}
            >
              {vscodeServerState === 'running' ? 'Server' : vscodeServerState === 'connecting' ? 'Server…' : 'Server ✖'}
            </span>
          </div>
        )}

        {/* Cursor position */}
        <StatusBarCursorInfo />

        {/* Language — at the end of the right zone, always displays in
            full (no truncate, no shrinking). The lightning-bolt icon is
            our signature mark for the detected language. */}
        <div className="flex shrink-0 items-center gap-1.5 px-2 py-0.5 rounded-md cursor-pointer transition-all hover:bg-[color-mix(in_srgb,var(--text-primary)_4%,transparent)]" title={language}>
          <Zap className="w-3.5 h-3.5" style={{ color: 'var(--attention-purple)' }} strokeWidth={2} />
          <span className="font-medium capitalize" style={{ color: 'var(--text-secondary)' }}>{language}</span>
        </div>

        {/* AI-detected framework pill — also at the tail; full readout */}
        {languageAndFramework && (
          <div
            className="flex shrink-0 items-center gap-1.5 px-2 py-0.5 rounded-md cursor-default transition-all"
            title={`Framework: ${languageAndFramework}`}
          >
            <Cpu className="w-3.5 h-3.5" style={{ color: 'var(--attention-purple)' }} strokeWidth={2} />
            <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>{languageAndFramework}</span>
          </div>
        )}
            </div>
      </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// PERF: Memoize StatusBar — it re-renders only when props genuinely change.
// Combined with useDeferredValue on Redux reads, this ensures StatusBar
// never forces a synchronous repaint during Monaco keystroke processing.
const StatusBar = memo(StatusBarInner);
export default StatusBar;
