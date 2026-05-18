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
 * Shell icons mapped by shell key. Colors read from CSS variables
 * (--shell-*) defined in globals.css, so theme overrides can rebalance
 * contrast without touching JSX.
 */
const SHELL_META = {
  powershell: { icon: '⚡',  color: 'var(--shell-powershell)', label: 'PowerShell' },
  pwsh:       { icon: '⚡',  color: 'var(--shell-powershell)', label: 'PowerShell 7' },
  cmd:        { icon: '▪',  color: 'var(--shell-cmd)',        label: 'Command Prompt' },
  bash:       { icon: '$',  color: 'var(--shell-bash)',       label: 'Bash' },
  gitbash:    { icon: '$',  color: 'var(--shell-gitbash)',    label: 'Git Bash' },
  zsh:        { icon: '%',  color: 'var(--shell-zsh)',        label: 'Zsh' },
  fish:       { icon: '><>', color: 'var(--shell-fish)',      label: 'Fish' },
  sh:         { icon: '#',  color: 'var(--shell-sh)',         label: 'sh' },
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
        side="bottom"
        align="end"
        sideOffset={4}
        className="min-w-[180px] p-1"
        style={{
          background: 'var(--bg-elevated)',
          borderColor: 'var(--border-subtle)',
        }}
      >
        <DropdownMenuLabel className="text-[10px] font-semibold uppercase tracking-wider px-2 py-1" style={{ color: 'var(--text-muted)' }}>
          New Terminal
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="my-0.5" />

        {loading ? (
          <div className="px-2 py-3 text-[11px] text-center" style={{ color: 'var(--text-muted)' }}>
            Detecting shells…
          </div>
        ) : (
          shells.map((shell) => {
            const meta = SHELL_META[shell.key] || { icon: '>', color: 'var(--shell-default)', label: shell.label };
            const isDefault = shell.key === defaultShell;
            const isUserDefault = shell.key === currentDefault;
            return (
              <DropdownMenuItem
                key={shell.key}
                className="flex items-center gap-2 px-2 py-1.5 text-[11px] cursor-pointer rounded-sm group/item"
                style={{ color: 'var(--text-primary)' }}
                onSelect={() => handleSelect(shell.key)}
              >
                {/* Shell icon — color-mix gives a soft tinted background
                    from the same brand token as the foreground glyph. */}
                <span
                  className="w-4 h-4 flex items-center justify-center rounded text-[9px] font-bold flex-shrink-0"
                  style={{ background: `color-mix(in srgb, ${meta.color} 14%, transparent)`, color: meta.color }}
                >
                  {meta.icon}
                </span>

                {/* Label */}
                <span className="flex-1">{meta.label}</span>

                {/* Badges */}
                {isUserDefault && (
                  <span
                    className="text-[9px] px-1 py-0 rounded font-medium leading-tight"
                    style={{ background: 'var(--accent-primary)', color: 'white', opacity: 0.8 }}
                  >
                    Default
                  </span>
                )}
                {isDefault && !isUserDefault && (
                  <span
                    className="text-[9px] px-1 py-0 rounded font-medium leading-tight"
                    style={{ color: 'var(--text-muted)', background: 'var(--bg-sidebar)' }}
                  >
                    System
                  </span>
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
  return SHELL_META[shellKey] || { icon: '>', color: 'var(--shell-default)', label: shellKey || 'Terminal' };
}
