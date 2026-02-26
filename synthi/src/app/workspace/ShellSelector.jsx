'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDown, Terminal, MonitorDot } from 'lucide-react';

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
 * Will be replaced by the real list from GET /available-shells.
 */
const FALLBACK_SHELLS = [
  { key: 'powershell', label: 'PowerShell', executable: 'powershell.exe' },
  { key: 'cmd', label: 'Command Prompt', executable: 'cmd.exe' },
  { key: 'bash', label: 'Bash', executable: 'bash.exe' },
  { key: 'gitbash', label: 'Git Bash', executable: 'bash.exe' },
];

/**
 * ShellSelector — A dropdown that lets users choose which shell to open.
 *
 * Props:
 *   onSelect(shellKey)   - Called when the user picks a shell. Pass null for default.
 *   collabServerUrl      - Base URL for the collab server (to fetch available shells)
 *   className            - Additional CSS classes
 */
export default function ShellSelector({ onSelect, onSetDefault, currentDefault, collabServerUrl = 'http://localhost:1234', className = '' }) {
  const [open, setOpen] = useState(false);
  const [shells, setShells] = useState([]);
  const [defaultShell, setDefaultShell] = useState(null);
  const [loading, setLoading] = useState(true);
  const dropdownRef = useRef(null);

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

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    function handleKey(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open]);

  const handleSelect = useCallback((shellKey) => {
    setOpen(false);
    if (onSelect) onSelect(shellKey);
  }, [onSelect]);

  return (
    <div ref={dropdownRef} className={`relative ${className}`}>
      {/* Trigger button — small dropdown arrow next to the + */}
      <button
        className="w-6 h-8 flex items-center justify-center rounded th-btn-ghost transition-colors"
        onClick={() => setOpen(prev => !prev)}
        title="Select Shell Type"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <ChevronDown className="w-3.5 h-3.5" strokeWidth={2} />
      </button>

      {/* Dropdown menu */}
      {open && (
        <div
          className="absolute bottom-full mb-1 left-0 z-50 min-w-[200px] rounded-md border shadow-lg overflow-hidden"
          style={{
            background: 'var(--bg-elevated)',
            borderColor: 'var(--border-subtle)',
          }}
          role="listbox"
        >
          {/* Header */}
          <div
            className="px-3 py-2 text-[10px] font-semibold uppercase tracking-wider border-b"
            style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}
          >
            New Terminal
          </div>

          {loading ? (
            <div className="px-3 py-4 text-xs text-center" style={{ color: 'var(--text-muted)' }}>
              Detecting shells…
            </div>
          ) : (
            <div className="py-1">
              {shells.map((shell) => {
                const meta = SHELL_META[shell.key] || { icon: '>', color: '#888', label: shell.label };
                const isDefault = shell.key === defaultShell;
                const isUserDefault = shell.key === currentDefault;
                return (
                  <div key={shell.key} className="flex items-center group/item">
                    <button
                      className="flex-1 flex items-center gap-3 px-3 py-2 text-xs transition-colors hover:bg-white/5"
                      style={{ color: 'var(--text-primary)' }}
                      onClick={() => handleSelect(shell.key)}
                      role="option"
                    >
                      {/* Shell icon */}
                      <span
                        className="w-5 h-5 flex items-center justify-center rounded text-[10px] font-bold"
                        style={{ background: `${meta.color}20`, color: meta.color }}
                      >
                        {meta.icon}
                      </span>

                      {/* Label */}
                      <span className="flex-1 text-left">{meta.label}</span>

                      {/* User default badge */}
                      {isUserDefault && (
                        <span
                          className="text-[9px] px-1.5 py-0.5 rounded font-medium"
                          style={{ background: 'var(--accent-primary)', color: 'white', opacity: 0.8 }}
                        >
                          Default
                        </span>
                      )}

                      {/* System default badge (only if user hasn't set one matching this) */}
                      {isDefault && !isUserDefault && (
                        <span
                          className="text-[9px] px-1.5 py-0.5 rounded font-medium"
                          style={{ color: 'var(--text-muted)', background: 'var(--bg-sidebar)' }}
                        >
                          System
                        </span>
                      )}
                    </button>

                    {/* Set as default button - appears on hover */}
                    {!isUserDefault && onSetDefault && (
                      <button
                        className="px-2 py-1 text-[9px] rounded opacity-0 group-hover/item:opacity-100 transition-opacity mr-1"
                        style={{ color: 'var(--text-muted)' }}
                        onClick={(e) => { e.stopPropagation(); onSetDefault(shell.key); }}
                        title={`Set ${meta.label} as default`}
                      >
                        Set Default
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Get the display metadata for a shell key.
 * Useful for rendering shell-specific icons/colors on tabs.
 */
export function getShellMeta(shellKey) {
  return SHELL_META[shellKey] || { icon: '>', color: '#888', label: shellKey || 'Terminal' };
}
