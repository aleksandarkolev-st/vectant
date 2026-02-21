"use client";

import { useEffect, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/redux/hooks";
import { selectFileThunk } from "@/redux/workspaceSlice";
import { api } from "@/services/api";
import { PanelLeftClose, PanelRightClose, ChevronDown, ChevronRight, Search } from "lucide-react";
import { selectTreeOnRight } from "@/redux/uiSlice";
import { perfMeasureToConsole } from "@/services/perfMarkers";

const Section = ({ children, className = "" }) => (
  <div className={`mx-2 mb-2 rounded-lg border ${className}`} style={{ background: 'var(--bg-surface)', borderColor: 'var(--border-subtle)' }}>
    {children}
  </div>
);

const SectionHead = ({ label, count, actions }) => (
  <div className="flex items-center gap-2 px-3 py-2">
    <span className="text-[11px] font-medium" style={{ color: 'var(--text-primary)' }}>{label}</span>
    {count != null && count > 0 && (
      <span className="text-[10px] rounded-full px-1.5 py-0.5 min-w-[18px] text-center font-medium" style={{ color: 'var(--text-muted)', background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>{count}</span>
    )}
    {actions && <div className="ml-auto flex items-center gap-1">{actions}</div>}
  </div>
);

const IconBtn = ({ onClick, disabled, title, children, className = "" }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={`p-1.5 rounded-lg transition-all disabled:opacity-40 ${className}`}
  >
    {children}
  </button>
);

export default function SearchView({ slug, onToggleOrientation }) {
  const dispatch = useAppDispatch();
  const isRightSide = useAppSelector(selectTreeOnRight);

  const [query, setQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [results, setResults] = useState([]);
  const [expanded, setExpanded] = useState(() => new Set());

  const abortRef = useRef(null);

  useEffect(() => {
    const q = query.trim();

    // Reset on empty
    if (!q) {
      abortRef.current?.abort?.();
      setIsSearching(false);
      setResults([]);
      setExpanded(new Set());
      return;
    }

    // Small debounce so we don't spam fetches while typing
    const t = setTimeout(() => {
      abortRef.current?.abort?.();
      const controller = new AbortController();
      abortRef.current = controller;

      (async () => {
        setIsSearching(true);
        const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
        try {
          const resp = await api.searchIndex(slug, q, { signal: controller.signal });
          const nextResults = Array.isArray(resp?.results) ? resp.results : [];

          if (controller.signal.aborted) return;

          setResults(nextResults);
          setExpanded(new Set());
          if (t0) perfMeasureToConsole('search_response_time', t0, { status: resp?.status });
        } catch (e) {
          if (!controller.signal.aborted) {
            console.error("Search failed", e);
            setResults([]);
          }
        } finally {
          if (!controller.signal.aborted) setIsSearching(false);
        }
      })();
    }, 200);

    return () => clearTimeout(t);
  }, [query, slug]);

  const toggleExpanded = (filePath) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  };

  const openFile = (file) => {
    dispatch(selectFileThunk(file));
  };

  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const renderHighlightedPreview = (preview, term) => {
    if (!term || !preview) return preview;
    const safe = escapeRegExp(term.trim());
    if (!safe) return preview;
    const regex = new RegExp(`(${safe})`, "gi");
    const parts = preview.split(regex);
    return parts.map((part, index) => {
      if (part.toLowerCase() === term.toLowerCase()) {
        return (
          <mark
            key={`hl-${index}`}
            className="rounded-sm px-0.5"
            style={{ background: 'color-mix(in srgb, var(--accent-secondary) 25%, transparent)', color: 'var(--accent-tertiary)' }}
          >
            {part}
          </mark>
        );
      }
      return <span key={`txt-${index}`}>{part}</span>;
    });
  };

  return (
    <div className="flex flex-col h-full w-full overflow-hidden select-none">
      {/* Header strip with gradient accent */}
      <div className="flex-shrink-0">
        <div className="h-[2px]" style={{ background: 'linear-gradient(90deg, var(--accent-primary), var(--accent-secondary), var(--accent-tertiary), transparent)' }} />
        <div className={`flex items-center gap-2 px-3 py-2 ${isRightSide ? "flex-row-reverse" : ""}`}>
          <Search size={14} className="flex-shrink-0" style={{ color: 'var(--accent-secondary)' }} />
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Search</span>
          <div className="ml-auto flex items-center gap-0.5">
            <IconBtn
              onClick={onToggleOrientation}
              title={isRightSide ? "Move to left" : "Move to right"}
              className="transition-colors"
              style={{ color: 'var(--text-muted)' }}
            >
              {isRightSide ? (
                <PanelLeftClose className="w-3.5 h-3.5" strokeWidth={1.5} />
              ) : (
                <PanelRightClose className="w-3.5 h-3.5" strokeWidth={1.5} />
              )}
            </IconBtn>
          </div>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto py-1">
        <Section>
          <div className="px-3 py-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5" style={{ color: 'var(--text-muted)' }} />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search in files"
                className="w-full h-8 rounded-lg border pl-8 pr-2 text-[12px] outline-none transition-colors"
                style={{ color: 'var(--text-primary)', background: 'var(--bg-elevated)', borderColor: 'var(--border-medium)', '--tw-placeholder-color': 'var(--text-dim)' }}
              />
            </div>
            <div className="mt-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>
              {isSearching ? "Searching..." : query.trim() ? `${results.length} file(s) with matches` : ""}
            </div>
          </div>
        </Section>

        {query.trim() && !isSearching && results.length === 0 && (
          <Section>
            <div className="px-3 py-2 text-[11px]" style={{ color: 'var(--text-muted)' }}>No results.</div>
          </Section>
        )}

        {results.length > 0 && (
          <Section className="pb-1">
            <SectionHead label="Results" count={results.length} />
            <div className="pb-1">
              {results.map((r) => {
                const filePath = r.file.path;
                const isOpen = expanded.has(filePath);

                return (
                  <div key={filePath} className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                    <button
                      type="button"
                      onClick={() => toggleExpanded(filePath)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left transition-colors"
                      style={{ ':hover': undefined }}
                      title={filePath}
                    >
                      {isOpen ? (
                        <ChevronDown className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                      ) : (
                        <ChevronRight className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="text-[12px] truncate" style={{ color: 'var(--text-primary)' }}>{r.file.name}</div>
                        <div className="text-[10px] truncate" style={{ color: 'var(--text-muted)' }}>{filePath}</div>
                      </div>
                      <div className="text-[10px] rounded-full px-2 py-0.5" style={{ color: 'var(--text-secondary)', background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>{r.matchCount}</div>
                    </button>

                    {isOpen && (
                      <div className="pb-2">
                        {r.matches.map((m) => (
                          <button
                            key={`${filePath}:${m.lineNumber}`}
                            type="button"
                            className="w-full px-8 py-1.5 text-left text-[11px] transition-colors hover:opacity-80"
                            style={{ color: 'var(--text-primary)' }}
                            onClick={() => openFile(r.file)}
                            title={`Line ${m.lineNumber}`}
                          >
                            <span className="inline-block w-14" style={{ color: 'var(--text-muted)' }}>{m.lineNumber}</span>
                            <span className="font-mono" style={{ color: 'var(--text-primary)' }}>{renderHighlightedPreview(m.preview, query)}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>
        )}
      </div>
    </div>
  );
}
