"use client";

import { useSelector } from 'react-redux';
import { BranchSelector } from '@/components/git/BranchSelector';
import { selectCursorPosition } from '@/redux/uiSlice';
import { selectActiveFile } from '@/redux/workspaceSlice';
import { getMonacoLanguage } from '@/utils/languageMapper';
import { AlertCircle, AlertTriangle, Cpu, Zap, Loader2 } from 'lucide-react';

/**
 * StatusBar Component - Synthi styled bottom status bar
 * Contains: Branch selector, Compiler status, Line/Column info, etc.
 * Features pill/badge shaped status indicators
 */
export default function StatusBar({ 
  slug,
  compilerStatus = 'disconnected',
  diagnosticSummary = { errors: 0, warnings: 0, total: 0 },
  isAnalyzing = false,
  onProblemsClick,
  extensionStatusBarItems = [],
  vscodeServerState = 'disconnected',
}) {
  const currentBranch = useSelector(state => state.git?.currentBranch);
  const position = useSelector(selectCursorPosition);
  const activeFile = useSelector(selectActiveFile);
  
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
          dotStyle: { background: 'var(--text-disabled)' }, 
          text: 'Disconnected',
          pillBorder: { borderColor: 'var(--border-medium)' },
          textStyle: { color: 'var(--text-disabled)' }
        };
    }
  };
  
  const statusStyle = getCompilerStatusStyle();
  
  // Determine if there are problems to show
  const hasProblems = diagnosticSummary.errors > 0 || diagnosticSummary.warnings > 0;

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
          {isAnalyzing ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" style={{ color: 'var(--text-secondary)' }} strokeWidth={2} />
              <span style={{ color: 'var(--text-secondary)' }}>Analyzing...</span>
            </>
          ) : (
            <>
              <AlertCircle 
                className="w-3.5 h-3.5" 
                style={{ color: diagnosticSummary.errors > 0 ? 'var(--accent-danger)' : 'var(--text-disabled)' }}
                strokeWidth={2} 
              />
              <span style={diagnosticSummary.errors > 0 ? { color: 'var(--accent-danger)', fontWeight: 600 } : { color: 'var(--text-secondary)' }}>
                {diagnosticSummary.errors}
              </span>
              <AlertTriangle 
                className="w-3.5 h-3.5" 
                style={{ color: diagnosticSummary.warnings > 0 ? 'var(--accent-warning)' : 'var(--text-disabled)' }}
                strokeWidth={2} 
              />
              <span style={diagnosticSummary.warnings > 0 ? { color: 'var(--accent-warning)', fontWeight: 600 } : { color: 'var(--text-secondary)' }}>
                {diagnosticSummary.warnings}
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
      </div>
      
      {/* Right Section - Better grouped */}
      <div className="flex items-center gap-3 mr-1">
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
                    : 'var(--text-disabled)'
                }}
              />
              <span
                className="font-medium text-[11px]"
                style={{
                  color: vscodeServerState === 'running' ? 'var(--accent-success)'
                    : vscodeServerState === 'connecting' ? 'var(--accent-warning)'
                    : vscodeServerState === 'error' ? 'var(--accent-danger)'
                    : 'var(--text-disabled)'
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
        <div className="flex items-center gap-1 px-2 py-0.5 rounded-md cursor-pointer transition-colors">
          <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>Ln {position.lineNumber}</span>
          <span style={{ color: 'var(--text-disabled)' }}>:</span>
          <span className="font-medium" style={{ color: 'var(--text-secondary)' }}>Col {position.column}</span>
        </div>
        
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
