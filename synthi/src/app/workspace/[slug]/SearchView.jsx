"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useAppDispatch, useAppSelector } from "@/redux/hooks";
import { selectFileThunk } from "@/redux/workspaceSlice";
import { api } from "@/services/api";
import { PanelLeftClose, PanelRightClose, ChevronDown, ChevronRight } from "lucide-react";
import { selectTreeOnRight } from "@/redux/uiSlice";

function flattenFiles(nodes, out = []) {
  for (const node of nodes || []) {
    if (!node) continue;
    if (node.isFolder) {
      if (node.children?.length) flattenFiles(node.children, out);
    } else {
      out.push(node);
    }
  }
  return out;
}

function findMatchesInContent(content, query) {
  const q = query.toLowerCase();
  const lines = String(content ?? "").split(/\r?\n/);

  const matches = [];
  for (let i = 0; i < lines.length; i++) {
    const lineText = lines[i];
    if (lineText.toLowerCase().includes(q)) {
      matches.push({
        lineNumber: i + 1,
        preview: lineText.length > 240 ? lineText.slice(0, 240) + "…" : lineText,
      });
      if (matches.length >= 200) break;
    }
  }

  return matches;
}

export default function SearchView({ slug, onToggleOrientation }) {
  const dispatch = useAppDispatch();
  const isRightSide = useAppSelector(selectTreeOnRight);
  const rawFiles = useAppSelector((state) => state.workspace.rawFiles);
  const fileContentCache = useAppSelector((state) => state.workspace.fileContentCache);

  const allFiles = useMemo(() => flattenFiles(rawFiles), [rawFiles]);

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
        try {
          const nextResults = [];

          for (const file of allFiles) {
            if (controller.signal.aborted) return;
            if (!file?.path) continue;

            let content;
            if (fileContentCache?.has?.(file.path)) {
              content = fileContentCache.get(file.path);
            } else {
              content = await api.fetchFileContentStorageOnly(slug, file.path, {
                signal: controller.signal,
              });
            }

            if (controller.signal.aborted) return;

            // Skip extremely large payloads to avoid UI jank
            if (typeof content === "string" && content.length > 2_000_000) continue;

            const matches = findMatchesInContent(content, q);
            if (matches.length) {
              nextResults.push({
                file,
                matches,
                matchCount: matches.length,
              });
            }
          }

          if (controller.signal.aborted) return;

          // Auto-expand first few files for convenience
          const nextExpanded = new Set();
          for (const r of nextResults.slice(0, 3)) nextExpanded.add(r.file.path);

          setResults(nextResults);
          setExpanded(nextExpanded);
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
  }, [query, allFiles, fileContentCache, slug]);

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

  return (
    <div className="w-full h-full select-none bg-[#232323] text-gray-100 flex flex-col border-r border-[#343434]">
      {/* Header */}
      <div
        className={`px-3 py-2 flex items-center ${isRightSide ? "flex-row-reverse" : ""} justify-between border-b border-[#343434] sticky top-0 bg-[#1e1e1e] z-10`}
      >
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold tracking-wide uppercase text-gray-300">Search</span>
        </div>
        <button
          onClick={onToggleOrientation}
          className={`p-1.5 rounded border border-[#3a3a3a] bg-[#262626] hover:bg-[#2f2f2f] transition ${isRightSide ? "mr-auto" : "ml-auto"}`}
          title={isRightSide ? "Move to left" : "Move to right"}
        >
          {isRightSide ? (
            <PanelLeftClose className="w-4 h-4 text-gray-300" />
          ) : (
            <PanelRightClose className="w-4 h-4 text-gray-300" />
          )}
        </button>
      </div>

      {/* Search box */}
      <div className="px-3 py-2 border-b border-[#343434] bg-[#1e1e1e]">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search in files"
          className="w-full h-8 rounded border border-[#3a3a3a] bg-[#262626] px-2 text-sm text-gray-100 placeholder:text-gray-500 outline-none focus:border-[#4a4a4a]"
        />
        <div className="mt-2 text-xs text-gray-400">
          {isSearching ? "Searching…" : query.trim() ? `${results.length} file(s) with matches` : ""}
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {query.trim() && !isSearching && results.length === 0 && (
          <div className="px-3 py-2 text-sm text-gray-400">No results.</div>
        )}

        {results.map((r) => {
          const filePath = r.file.path;
          const isOpen = expanded.has(filePath);

          return (
            <div key={filePath} className="border-b border-[#2b2b2b]">
              <button
                type="button"
                onClick={() => toggleExpanded(filePath)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-[#2a2d2e]"
                title={filePath}
              >
                {isOpen ? (
                  <ChevronDown className="w-4 h-4 text-gray-400" />
                ) : (
                  <ChevronRight className="w-4 h-4 text-gray-400" />
                )}
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-100 truncate">{r.file.name}</div>
                  <div className="text-[11px] text-gray-500 truncate">{filePath}</div>
                </div>
                <div className="text-xs text-gray-300">{r.matchCount}</div>
              </button>

              {isOpen && (
                <div className="pb-2">
                  {r.matches.map((m) => (
                    <button
                      key={`${filePath}:${m.lineNumber}`}
                      type="button"
                      className="w-full px-8 py-1.5 text-left text-xs text-gray-200 hover:bg-[#2a2d2e]"
                      onClick={() => openFile(r.file)}
                      title={`Line ${m.lineNumber}`}
                    >
                      <span className="inline-block w-14 text-gray-500">{m.lineNumber}</span>
                      <span className="font-mono text-gray-200">{m.preview}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
