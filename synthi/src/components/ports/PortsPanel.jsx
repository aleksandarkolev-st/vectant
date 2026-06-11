'use client';
import { useCallback } from 'react';
import { Network, ExternalLink, Copy } from 'lucide-react';
import { toast } from 'sonner';
import { useAppSelector } from '@/redux/hooks';
import { getProgramSessionAppUrl } from '@/services/programSessionClient';

export default function PortsPanel() {
  const ports = useAppSelector((s) => s.ports?.containerPorts) || [];
  const slug = useAppSelector((s) => s.workspace?.slug) || '';

  const urlFor = useCallback(
    (port) => getProgramSessionAppUrl(port, { slug, runtimeType: 'container' }),
    [slug],
  );

  const open = useCallback((port) => {
    const url = urlFor(port);
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }, [urlFor]);

  const copy = useCallback(async (port) => {
    const url = urlFor(port);
    try { await navigator.clipboard.writeText(url); toast.success(`Copied ${url}`); }
    catch { toast.error('Copy failed'); }
  }, [urlFor]);

  return (
    <div className="h-full w-full overflow-y-auto p-3" style={{ background: 'var(--bg-sidebar)', color: 'var(--text-primary)' }}>
      <div className="flex items-center gap-2 mb-3">
        <Network size={16} />
        <span className="text-sm font-medium">Ports</span>
      </div>
      {!slug ? (
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>No workspace.</div>
      ) : ports.length === 0 ? (
        <div className="text-sm" style={{ color: 'var(--text-muted)' }}>
          No forwarded ports. Start a server in the terminal (e.g. <code>npm run dev</code>, binding 0.0.0.0) and it will appear here.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {ports.map((port) => (
            <div
              key={port}
              data-testid={`port-row-${port}`}
              className="rounded-md border px-3 py-2 flex items-center justify-between gap-3"
              style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-surface)' }}
            >
              <span className="text-sm">Port {port}</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid={`open-port-${port}`}
                  onClick={() => open(port)}
                  title="Open in browser"
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded"
                  style={{ background: 'color-mix(in srgb, #60a5fa 18%, transparent)' }}
                >
                  <ExternalLink size={13} /> Open
                </button>
                <button
                  type="button"
                  onClick={() => copy(port)}
                  title="Copy URL"
                  className="inline-flex items-center gap-1 text-xs px-2 py-1 rounded"
                  style={{ background: 'var(--bg-elevated, rgba(255,255,255,0.06))' }}
                >
                  <Copy size={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
