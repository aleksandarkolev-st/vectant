"use client";

import { Files, Search, GitBranch, Puzzle, Settings } from "lucide-react";

export default function ActivityBar({ active = "explorer", onSelect, badges = {} }) {
  const topItems = [
    { id: "explorer", label: "Explorer", Icon: Files },
    { id: "search", label: "Search", Icon: Search },
    { id: "scm", label: "Source Control", Icon: GitBranch },
    { id: "extensions", label: "Extensions", Icon: Puzzle },
  ];

  const bottomItems = [{ id: "settings", label: "Settings", Icon: Settings }];

  const renderButton = ({ id, label, Icon }) => {
    const isActive = id === active;
    const badge = badges?.[id];

    return (
      <button
        key={id}
        type="button"
        aria-label={label}
        onClick={() => onSelect?.(id)}
        className={`group relative w-full h-12 flex items-center justify-center text-gray-300 hover:text-white hover:bg-[#2a2d2e] ${
          isActive ? "text-white bg-[#252526]" : ""
        }`}
      >
        <div
          className={`absolute left-0 top-0 bottom-0 w-0.5 ${
            isActive ? "bg-white" : "bg-transparent"
          }`}
        />
        <Icon className="w-5 h-5" />

        {/* Hover label */}
        <div
          role="tooltip"
          className="pointer-events-none absolute left-full ml-2 top-1/2 -translate-y-1/2 z-50 whitespace-nowrap rounded border border-[#3a3a3a] bg-[#252526] px-2 py-1 text-xs text-gray-100 opacity-0 group-hover:opacity-100 transition"
        >
          {label}
        </div>

        {typeof badge === "number" && badge > 0 && (
          <div className="absolute right-2 top-2 min-w-4 h-4 px-1 rounded-full bg-blue-500 text-white text-[10px] leading-4 text-center">
            {badge}
          </div>
        )}
      </button>
    );
  };

  return (
    <div className="w-12 h-full flex flex-col items-center bg-[#1e1e1e] border-r border-[#2a2a2a]">
      <div className="w-full flex flex-col">{topItems.map(renderButton)}</div>
      <div className="mt-auto w-full flex flex-col">{bottomItems.map(renderButton)}</div>
    </div>
  );
}
