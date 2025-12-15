"use client";

import { useSelector } from 'react-redux';
import { BranchSelector } from '@/components/git/BranchSelector';
import { selectCursorPosition } from '@/redux/uiSlice';
import { selectActiveFile } from '@/redux/workspaceSlice';
import { getMonacoLanguage } from '@/utils/languageMapper';
import { Cpu, Zap } from 'lucide-react';

/**
 * StatusBar Component - Synthi styled bottom status bar
 * Contains: Branch selector, Compiler status, Line/Column info, etc.
 * Features pill/badge shaped status indicators
 */
export default function StatusBar({ 
  slug,
  compilerStatus = 'disconnected',
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

  return (
    <div className="h-7 flex-shrink-0 flex items-center justify-between px-3 bg-[#08090d] border-t-2 border-[#1a1b24] text-[12px] select-none font-[var(--font-ui)]">
      {/* Left Section - Grouped info */}
      <div className="flex items-center gap-3">
        {/* Branch Selector - Compact with pill style */}
        <div className="flex items-center rounded-md px-1">
          <BranchSelector slug={slug} />
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
