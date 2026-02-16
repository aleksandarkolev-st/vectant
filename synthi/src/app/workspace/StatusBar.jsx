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
          dot: 'bg-[#4ade80]', 
          text: 'Connected',
          pillBorder: 'border-[#4ade8050]',
          textColor: 'text-[#4ade80]'
        };
      case 'connecting':
        return { 
          dot: 'bg-[#fbbf24] animate-pulse', 
          text: 'Connecting...',
          pillBorder: 'border-[#fbbf2450]',
          textColor: 'text-[#fbbf24]'
        };
      case 'error':
        return { 
          dot: 'bg-[#ff5757] animate-pulse', 
          text: 'Error',
          pillBorder: 'border-[#ff575750]',
          textColor: 'text-[#ff5757] font-semibold'
        };
      case 'disconnected':
      default:
        return { 
          dot: 'bg-[#5a6178]', 
          text: 'Disconnected',
          pillBorder: 'border-[#2a2b38]',
          textColor: 'text-[#5a6178]'
        };
    }
  };
  
  const statusStyle = getCompilerStatusStyle();
  
  // Determine if there are problems to show
  const hasProblems = diagnosticSummary.errors > 0 || diagnosticSummary.warnings > 0;

  return (
    <div className="h-7 flex-shrink-0 flex items-center justify-between px-3 bg-[#08090d] border-t-2 border-[#1a1b24] text-[12px] select-none font-[var(--font-ui)]">
      {/* Left Section - Grouped info */}
      <div className="flex items-center gap-3">
        {/* Branch Selector - Compact with pill style */}
        <div className="flex items-center rounded-md px-1">
          <BranchSelector slug={slug} />
        </div>
        
        <div className="w-px h-4 bg-[#1a1b24]"></div>
        
        {/* Problems Indicator - Clickable to toggle problems panel */}
        <div 
          onClick={onProblemsClick}
          className={`flex items-center gap-2 px-2 py-0.5 rounded-md cursor-pointer transition-all ${
            hasProblems 
              ? 'hover:bg-[#ff575715] bg-[#ff575708]' 
              : 'hover:bg-[#101118]'
          }`}
        >
          {isAnalyzing ? (
            <>
              <Loader2 className="w-3.5 h-3.5 text-[#9ba2b8] animate-spin" strokeWidth={2} />
              <span className="text-[#9ba2b8]">Analyzing...</span>
            </>
          ) : (
            <>
              <AlertCircle 
                className={`w-3.5 h-3.5 ${diagnosticSummary.errors > 0 ? 'text-[#ff5757]' : 'text-[#5a6178]'}`} 
                strokeWidth={2} 
              />
              <span className={diagnosticSummary.errors > 0 ? 'text-[#ff5757] font-semibold' : 'text-[#9ba2b8]'}>
                {diagnosticSummary.errors}
              </span>
              <AlertTriangle 
                className={`w-3.5 h-3.5 ${diagnosticSummary.warnings > 0 ? 'text-[#fbbf24]' : 'text-[#5a6178]'}`} 
                strokeWidth={2} 
              />
              <span className={diagnosticSummary.warnings > 0 ? 'text-[#fbbf24] font-semibold' : 'text-[#9ba2b8]'}>
                {diagnosticSummary.warnings}
              </span>
            </>
          )}
        </div>
        
        <div className="w-px h-4 bg-[#1a1b24]"></div>
        
        {/* Compiler Status - Pill/Badge shaped indicator with better contrast */}
        <div className={`flex items-center gap-2 px-2.5 py-1 ${statusStyle.pillBg} transition-all cursor-default`}>
          <Cpu className={`w-3.5 h-3.5 ${statusStyle.textColor}`} strokeWidth={2} />
          <div className={`w-2 h-2 rounded-full ${statusStyle.dot}`} />
          <span className={`${statusStyle.textColor} font-semibold`}>{statusStyle.text}</span>
        </div>
      </div>
      
      {/* Right Section - Better grouped */}
      <div className="flex items-center gap-3 mr-1">
        {/* Extension-contributed status bar items */}
        {extensionStatusBarItems.filter(i => i.text).map((item) => (
          <div
            key={item.id}
            className="flex items-center gap-1 px-2 py-0.5 rounded-md cursor-default hover:bg-[#101118] transition-colors"
            title={item.tooltip || item.text}
          >
            <span className="text-[#9ba2b8] font-medium text-[11px]">{item.text}</span>
          </div>
        ))}
        {extensionStatusBarItems.length > 0 && (
          <div className="w-px h-4 bg-[#1a1b24]"></div>
        )}

        {/* VS Code Server status */}
        {vscodeServerState !== 'disconnected' && (
          <>
            <div
              className={`flex items-center gap-1.5 px-2 py-0.5 rounded-md cursor-default transition-colors ${
                vscodeServerState === 'running'
                  ? 'bg-[#4ade8008]'
                  : vscodeServerState === 'error'
                  ? 'bg-[#ff575708]'
                  : ''
              }`}
              title={`VS Code Server: ${vscodeServerState}`}
            >
              <div
                className={`w-2 h-2 rounded-full ${
                  vscodeServerState === 'running'
                    ? 'bg-[#4ade80]'
                    : vscodeServerState === 'connecting'
                    ? 'bg-[#fbbf24] animate-pulse'
                    : vscodeServerState === 'error'
                    ? 'bg-[#ff5757]'
                    : 'bg-[#5a6178]'
                }`}
              />
              <span
                className={`font-medium text-[11px] ${
                  vscodeServerState === 'running'
                    ? 'text-[#4ade80]'
                    : vscodeServerState === 'connecting'
                    ? 'text-[#fbbf24]'
                    : vscodeServerState === 'error'
                    ? 'text-[#ff5757]'
                    : 'text-[#5a6178]'
                }`}
              >
                {vscodeServerState === 'running'
                  ? 'Server'
                  : vscodeServerState === 'connecting'
                  ? 'Server...'
                  : 'Server ✖'}
              </span>
            </div>
            <div className="w-px h-4 bg-[#1a1b24]"></div>
          </>
        )}

        {/* Line/Column - Clearer */}
        <div className="flex items-center gap-1 px-2 py-0.5 rounded-md cursor-pointer hover:bg-[#101118] transition-colors">
          <span className="text-[#9ba2b8] font-medium">Ln {position.lineNumber}</span>
          <span className="text-[#5a6178]">:</span>
          <span className="text-[#9ba2b8] font-medium">Col {position.column}</span>
        </div>
        
        <div className="w-px h-4 bg-[#1a1b24]"></div>
        
        {/* Language - Pill style with accent on hover */}
        <div className="flex items-center gap-1.5 px-2 py-0.5 rounded-md cursor-pointer hover:bg-[#3a857415] transition-all">
          <Zap className="w-3.5 h-3.5 text-[#3a8574]" strokeWidth={2} />
          <span className="text-[#9ba2b8] font-medium capitalize">{language}</span>
        </div>
      </div>
    </div>
  );
}
