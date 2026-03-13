"use client";

import { memo, useDeferredValue } from 'react';
import { useSelector } from 'react-redux';
import { BranchSelector } from '@/components/git/BranchSelector';
import { selectCursorPosition } from '@/redux/uiSlice';
import { selectActiveFile } from '@/redux/workspaceSlice';
import { getMonacoLanguage } from '@/utils/languageMapper';
import { useCollabStatus } from '@/hooks/useCollabStatus';
import { useCollabSession } from '@/hooks/useCollabSession';
import { useWorkspacePresence } from '@/hooks/useWorkspacePresence';
import { AlertCircle, AlertTriangle, Cpu, Zap, Loader2, Wifi, WifiOff, Radio, Users } from 'lucide-react';
import { HealingIndicator } from '@/components/healing/HealingIndicator';

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
    <div className="flex items-center gap-1 px-2 py-0.5 rounded-md cursor-pointer transition-colors">
      <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>Ln {position.lineNumber}</span>
      <span style={{ color: 'var(--text-dim)' }}>:</span>
      <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>Col {position.column}</span>
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
}) {
  // PERF: Defer all Redux reads so StatusBar never blocks the editor
  const currentBranchRaw = useSelector(state => state.git?.currentBranch);
  const currentBranch = useDeferredValue(currentBranchRaw);
  const activeFileRaw = useSelector(selectActiveFile);
  const activeFile = useDeferredValue(activeFileRaw);

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
  const otherUserCount = activeUsers ? activeUsers.filter(u => u.userId !== position?.userId).length : 0;
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

  return (
    <div className="h-7 flex-shrink-0 flex items-center justify-between px-3 border-t-2 text-[12px] select-none font-[var(--font-ui)]" style={{ background: 'var(--bg-app)', borderColor: 'var(--border-subtle)' }}>
      {/* Left Section - Grouped info */}
      <div className="flex items-center gap-3">
        {/* Branch Selector - Compact with pill style */}
        <div className="flex items-center rounded-md px-1">
          <BranchSelector slug={slug} />
        </div>
        
        <div className="w-px h-4" style={{ background: 'var(--border-subtle)' }}></div>
        
        {/* Problems Indicator - Clickable to toggle problems panel */}
        <div 
          onClick={onProblemsClick}
          className={`flex items-center gap-2 px-2 py-0.5 rounded-md cursor-pointer transition-all`}
          style={hasProblems ? { background: 'color-mix(in srgb, var(--accent-danger) 3%, transparent)' } : {}}
        >
          {deferredIsAnalyzing ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: 'var(--text-secondary)' }} strokeWidth={2} />
              <span style={{ color: 'var(--text-secondary)' }}>Analyzing...</span>
            </>
          ) : (
            <>
              <AlertCircle 
                className="w-3.5 h-3.5" 
                style={{ color: deferredSummary.errors > 0 ? 'var(--accent-danger)' : 'var(--text-muted)' }}
                strokeWidth={2} 
              />
              <span style={deferredSummary.errors > 0 ? { color: 'var(--accent-danger)', fontWeight: 600 } : { color: 'var(--text-secondary)' }}>
                {deferredSummary.errors}
              </span>
              <AlertTriangle 
                className="w-3.5 h-3.5" 
                style={{ color: deferredSummary.warnings > 0 ? 'var(--accent-warning)' : 'var(--text-muted)' }}
                strokeWidth={2} 
              />
              <span style={deferredSummary.warnings > 0 ? { color: 'var(--accent-warning)', fontWeight: 600 } : { color: 'var(--text-secondary)' }}>
                {deferredSummary.warnings}
              </span>
            </>
          )}
        </div>
        
        <div className="w-px h-4" style={{ background: 'var(--border-subtle)' }}></div>
        
        {/* Compiler Status - Pill/Badge shaped indicator with better contrast */}
        <div className={`flex items-center gap-2 px-2.5 py-1 transition-all cursor-default`}>
          <Cpu className="w-3.5 h-3.5" style={statusStyle.textStyle} strokeWidth={2} />
          <div className={`w-2 h-2 rounded-full ${statusStyle.dotCls || ''}`} style={statusStyle.dotStyle} />
          <span className="font-semibold" style={statusStyle.textStyle}>{statusStyle.text}</span>
        </div>
        
        <div className="w-px h-4 bg-[#1a1b24]"></div>
        
        {/* Collab Sync Status - green/yellow/red indicator */}
        <div className="flex items-center gap-2 px-2.5 py-1 transition-all cursor-default" title={`Collaboration: ${collabStyle.text}`}>
          <collabStyle.Icon className={`w-3.5 h-3.5 ${collabStyle.textColor}`} strokeWidth={2} />
          <div className={`w-2 h-2 rounded-full ${collabStyle.dot}`} />
          <span className={`${collabStyle.textColor} font-semibold`}>{collabStyle.text}</span>
          {otherUserCount > 0 && (
            <span className="flex items-center gap-1 ml-1" title={`${otherUserCount} other user${otherUserCount > 1 ? 's' : ''} online`}>
              <Users className="w-3 h-3 text-[#7c80a0]" strokeWidth={2} />
              <span className="text-[#9ba2b8] font-semibold">{otherUserCount}</span>
            </span>
          )}
        </div>

        {/* Session Sharing Indicator */}
        {isHost && (
          <>
            <div className="w-px h-4 bg-[#1a1b24]"></div>
            <div className="flex items-center gap-2 px-2.5 py-1 cursor-default" title={`Live session — ${guests.length} guest(s)`}>
              <Radio className="w-3.5 h-3.5 text-[#ff5757]" strokeWidth={2} />
              <span className="w-2 h-2 rounded-full bg-[#ff5757] animate-pulse" />
              <span className="text-[#ff5757] font-semibold">LIVE</span>
            </div>
          </>
        )}
        {isGuest && (
          <>
            <div className="w-px h-4 bg-[#1a1b24]"></div>
            <div className="flex items-center gap-2 px-2.5 py-1 cursor-default" title={`Connected to ${session?.hostName || 'Host'}'s session`}>
              <Users className="w-3.5 h-3.5 text-[#fbbf24]" strokeWidth={2} />
              <span className="text-[#fbbf24] font-semibold">Guest</span>
            </div>
          </>
        )}
      </div>
      
      {/* Right Section - Better grouped */}
      <div className="flex items-center gap-3 mr-1">
        {/* Self-Healing indicator */}
        <HealingIndicator />
        <div className="w-px h-4" style={{ background: 'var(--border-subtle)' }}></div>

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
        {extensionStatusBarItems.length > 0 && (
          <div className="w-px h-4" style={{ background: 'var(--border-subtle)' }}></div>
        )}

        {/* VS Code Server status */}
        {vscodeServerState !== 'disconnected' && (
          <>
            <div
              className={`flex items-center gap-1.5 px-2 py-0.5 rounded-md cursor-default transition-colors`}
              style={vscodeServerState === 'running'
                ? { background: 'color-mix(in srgb, var(--accent-success) 3%, transparent)' }
                : vscodeServerState === 'error'
                ? { background: 'color-mix(in srgb, var(--accent-danger) 3%, transparent)' }
                : {}}
              title={`VS Code Server: ${vscodeServerState}`}
            >
              <div
                className={`w-2 h-2 rounded-full ${vscodeServerState === 'connecting' ? 'animate-pulse' : ''}`}
                style={{
                  background: vscodeServerState === 'running' ? 'var(--accent-success)'
                    : vscodeServerState === 'connecting' ? 'var(--accent-warning)'
                    : vscodeServerState === 'error' ? 'var(--accent-danger)'
                    : 'var(--text-muted)'
                }}
              />
              <span
                className="font-medium text-[11px]"
                style={{
                  color: vscodeServerState === 'running' ? 'var(--accent-success)'
                    : vscodeServerState === 'connecting' ? 'var(--accent-warning)'
                    : vscodeServerState === 'error' ? 'var(--accent-danger)'
                    : 'var(--text-muted)'
                }}
              >
                {vscodeServerState === 'running'
                  ? 'Server'
                  : vscodeServerState === 'connecting'
                  ? 'Server...'
                  : 'Server ✖'}
              </span>
            </div>
            <div className="w-px h-4" style={{ background: 'var(--border-subtle)' }}></div>
          </>
        )}

        {/* Line/Column - Clearer */}
        <StatusBarCursorInfo />
        
        <div className="w-px h-4" style={{ background: 'var(--border-subtle)' }}></div>
        
        {/* Language - Pill style with accent on hover */}
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md cursor-pointer transition-all">
          <Zap className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary)' }} strokeWidth={2} />
          <span className="font-medium capitalize" style={{ color: 'var(--text-secondary)' }}>{language}</span>
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
