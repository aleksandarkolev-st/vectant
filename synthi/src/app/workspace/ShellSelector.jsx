'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';

/**
 * Shell icons mapped by shell key.
 * Uses distinct colors per shell type for visual differentiation.
 */
const SHELL_META = {
  powershell: { icon: '⚡', color: '#5391FE', label: 'PowerShell' },
  pwsh:       { icon: '⚡', color: '#5391FE', label: 'PowerShell 7' },
  cmd:        { icon: '▪',  color: '#cccccc', label: 'Command Prompt' },
  bash:       { icon: '$',  color: '#4EAA25', label: 'Bash' },
  gitbash:    { icon: '$',  color: '#F05032', label: 'Git Bash' },
  zsh:        { icon: '%',  color: '#c678dd', label: 'Zsh' },
  fish:       { icon: '><>', color: '#E44D26', label: 'Fish' },
  sh:         { icon: '#',  color: '#888888', label: 'sh' },
};

/**
 * Fallback shell definitions for when the server is unreachable.
 */
const FALLBACK_SHELLS = [
  { key: 'powershell', label: 'PowerShell', executable: 'powershell.exe' },
  { key: 'cmd', label: 'Command Prompt', executable: 'cmd.exe' },
  { key: 'bash', label: 'Bash', executable: 'bash.exe' },
  { key: 'gitbash', label: 'Git Bash', executable: 'bash.exe' },
];

/**
 * ShellSelector — shadcn DropdownMenu that lets users choose which shell to open.
 * Has a flipping chevron animation matching the AI chat selectors.
 */
export default function ShellSelector({ onSelect, onSetDefault, currentDefault, collabServerUrl = 'http://localhost:1234', className = '' }) {
  const [shells, setShells] = useState([]);
  const [defaultShell, setDefaultShell] = useState(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);

  // Fetch available shells from server
  useEffect(() => {
    let cancelled = false;
    async function fetchShells() {
      try {
        const res = await fetch(`${collabServerUrl}/available-shells`);
        if (!res.ok) throw new Error('Failed to fetch shells');
        const data = await res.json();
        if (!cancelled) {
          setShells(data.shells || []);
          setDefaultShell(data.default || null);
          setLoading(false);
        }
      } catch (_) {
        if (!cancelled) {
          setShells(FALLBACK_SHELLS);
          setDefaultShell('powershell');
          setLoading(false);
        }
      }
    }
    fetchShells();
    return () => { cancelled = true; };
  }, [collabServerUrl]);

  const handleSelect = useCallback((shellKey) => {
    if (onSelect) onSelect(shellKey);
  }, [onSelect]);

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          className={`w-6 h-8 flex items-center justify-center rounded th-btn-ghost transition-colors ${className}`}
          title="Select Shell Type"
        >
          <ChevronDown
            className={`w-3.5 h-3.5 transition-transform duration-300 ${open ? 'rotate-180' : 'rotate-0'}`}
            strokeWidth={2}
          />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        side="top"
        align="start"
        sideOffset={6}
        className="min-w-[220px]"
        style={{
          background: 'var(--bg-elevated)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-muted)' }}>
          New Terminal
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {loading ? (
          <div className="px-3 py-4 text-xs text-center" style={{ color: 'var(--text-muted)' }}>
            Detecting shells…
          </div>
        ) : (
          shells.map((shell) => {
            const meta = SHELL_META[shell.key] || { icon: '>', color: '#888', label: shell.label };
            const isDefault = shell.key === defaultShell;
            const isUserDefault = shell.key === currentDefault;
            return (
              <DropdownMenuItem
                key={shell.key}
                className="flex items-center gap-3 px-2 py-2 text-xs cursor-pointer group/item"
                style={{ color: 'var(--text-primary)' }}
                onSelect={() => handleSelect(shell.key)}
              >
                {/* Shell icon */}
                <span
                  className="w-5 h-5 flex items-center justify-center rounded text-[10px] font-bold flex-shrink-0"
                  style={{ background: `${meta.color}20`, color: meta.color }}
                >
                  {meta.icon}
                </span>

                {/* Label */}
                <span className="flex-1">{meta.label}</span>

                {/* Badges */}
                {isUserDefault && (
                  <span
                    className="text-[9px] px-1.5 py-0.5 rounded font-medium"
                    style={{ background: 'var(--accent-primary)', color: 'white', opacity: 0.8 }}
                  >
                    Default
                  </span>
                )}
                {isDefault && !isUserDefault && (
                  <span
                    className="text-[9px] px-1.5 py-0.5 rounded font-medium"
                    style={{ color: 'var(--text-muted)', background: 'var(--bg-sidebar)' }}
                  >
                    System
                  </span>
                )}

                {/* Set as default — appears on hover */}
                {!isUserDefault && onSetDefault && (
                  <button
                    className="text-[9px] px-1 rounded opacity-0 group-hover/item:opacity-100 transition-opacity"
                    style={{ color: 'var(--text-muted)' }}
                    onClick={(e) => { e.stopPropagation(); e.preventDefault(); onSetDefault(shell.key); }}
                    title={`Set ${meta.label} as default`}
                  >
                    Set Default
                  </button>
                )}
              </DropdownMenuItem>
            );
          })
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Get the display metadata for a shell key.
 */
export function getShellMeta(shellKey) {
  return SHELL_META[shellKey] || { icon: '>', color: '#888', label: shellKey || 'Terminal' };
}
