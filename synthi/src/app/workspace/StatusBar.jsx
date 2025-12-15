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
  
  // Determine compiler status styling with Synthi brand colors
  const getCompilerStatusStyle = () => {
    switch (compilerStatus) {
      case 'connected':
        return { 
          dot: 'bg-[#4ade80]', 
          text: 'Connected',
          pillBorder: 'border-[#4ade8040]',
          textColor: 'text-[#4ade80]'
        };
      case 'connecting':
        return { 
          dot: 'bg-[#fbbf24] animate-pulse', 
          text: 'Connecting...',
          pillBorder: 'border-[#fbbf2440]',
          textColor: 'text-[#fbbf24]'
        };
      case 'error':
        return { 
          dot: 'bg-[#ff5757]', 
          text: 'Error',
          pillBorder: 'border-[#ff575740]',
          textColor: 'text-[#ff5757]'
        };
      case 'disconnected':
      default:
        return { 
          dot: 'bg-[#6b7089]', 
          text: 'Disconnected',
          pillBorder: 'border-[#32334a]',
          textColor: 'text-[#6b7089]'
        };
    }
  };
  
  const statusStyle = getCompilerStatusStyle();

  return (
    <div className="h-6 flex-shrink-0 flex items-center justify-between px-2 bg-[#0a0b10] border-t border-[#1c1d26] text-[11px] select-none font-[var(--font-ui)]">
      {/* Left Section */}
      <div className="flex items-center gap-2">
        {/* Branch Selector - Compact with pill style */}
        <div className="flex items-center rounded-full px-1">
          <BranchSelector slug={slug} />
        </div>
        
        <div className="w-px h-3 bg-[#1c1d26]"></div>
        
        {/* Compiler Status - Pill/Badge shaped indicator */}
        <div className={`flex items-center gap-1.5 px-2.5 py-0.5 ${statusStyle.pillBg} transition-all cursor-default`}>
          <Cpu className={`w-3 h-3 ${statusStyle.textColor}`} strokeWidth={2} />
          <div className={`w-1.5 h-1.5 rounded-full ${statusStyle.dot}`} />
          <span className={`${statusStyle.textColor} font-medium`}>{statusStyle.text}</span>
        </div>
      </div>
      
      {/* Right Section */}
      <div className="flex items-center mr-1">
        {/* Line/Column - Pill style */}
        <div className="flex items-center gap-1 px-2.5 py-0.5 rounded-full cursor-pointer hover:border-[#32746440] transition-colors">
          <span className="text-[#a8adc0]">Ln {position.lineNumber}, Col {position.column}</span>
        </div>
        
        {/* Language - Pill style with accent on hover */}
        <div className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full cursor-pointer hover:border-[#32746440] hover:bg-[#32746410] transition-all">
          <Zap className="w-3 h-3 text-[#327464]" strokeWidth={2} />
          <span className="text-[#a8adc0] capitalize">{language}</span>
        </div>
      </div>
    </div>
  );
}
