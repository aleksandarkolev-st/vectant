"use client";

import { memo, useDeferredValue } from 'react';
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
import { AlertCircle, AlertTriangle, Cpu, Zap, Loader2, Wifi, WifiOff, Radio, Users, Square, RotateCw } from 'lucide-react';
import { HealingIndicator } from '@/components/healing/HealingIndicator';
import OperatorStatusBarButton from './OperatorStatusBarButton';

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
  return (
    <div className="status-bar-root pointer-events-none absolute inset-x-0 bottom-3 z-30 px-3 flex items-end justify-center" style={{ background: 'transparent' }}>
      <div className="relative w-1/2 min-w-[640px] pointer-events-auto">
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
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-[-1px] rounded-full"
          style={{
            background: 'var(--brand-gradient-horizontal)',
            filter: 'blur(5px)',
            opacity: 0.16,
            transform: 'translateZ(0) scale(1.006)',
          }}
        />
        <div
          className="status-island relative z-10 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-x-3 h-7 px-4 rounded-full text-[11px] select-none font-[var(--font-ui)] whitespace-nowrap overflow-hidden"
          style={{
            background:
              'linear-gradient(var(--bg-elevated), var(--bg-elevated)) padding-box, var(--brand-gradient-horizontal) border-box',
            border: '1px solid transparent',
            boxShadow:
              '0 16px 40px -8px rgba(0,0,0,0.85), ' +
              'inset 0 1px 0 0 color-mix(in srgb, white 8%, transparent), ' +
              'inset 0 -1px 0 0 color-mix(in srgb, black 30%, transparent)',
            backdropFilter: 'blur(14px) saturate(160%)',
            WebkitBackdropFilter: 'blur(14px) saturate(160%)',
          }}
        >
      {/* ── LEFT ZONE — file/build state ─────────────────────────── */}
      <div className="flex min-w-0 items-center gap-1 justify-self-start">
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

      {/* ── CENTER ZONE — session / collaboration ────────────────── */}
      <div className="flex items-center gap-1 justify-self-center">
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

      {/* ── RIGHT ZONE — healing / extensions / cursor / language ── */}
      <div className="flex min-w-0 max-w-full items-center gap-1 justify-self-end mr-1">
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

        {/* Language — label hides below xl */}
        <div className="flex min-w-0 items-center gap-1.5 px-2 py-0.5 rounded-md cursor-pointer transition-all hover:bg-[color-mix(in_srgb,var(--text-primary)_4%,transparent)]" title={language}>
          <Zap className="w-3.5 h-3.5" style={{ color: 'var(--attention-purple)' }} strokeWidth={2} />
          <span className="hidden max-w-[10ch] truncate 2xl:inline font-medium capitalize" style={{ color: 'var(--text-secondary)' }}>{language}</span>
        </div>

        {/* AI-detected framework pill — most likely to be cramped, hides earliest */}
        {languageAndFramework && (
          <div
            className="flex min-w-0 items-center gap-1.5 px-2 py-0.5 rounded-md cursor-default transition-all"
            title={`Framework: ${languageAndFramework}`}
          >
            <Cpu className="w-3.5 h-3.5" style={{ color: 'var(--attention-purple)' }} strokeWidth={2} />
            <span className="hidden max-w-[14ch] truncate 2xl:inline font-medium" style={{ color: 'var(--text-secondary)' }}>{languageAndFramework}</span>
          </div>
        )}
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
