"use client";

import { Files, Search, GitBranch, Puzzle, Settings, Sparkles } from "lucide-react";

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
        className={`group relative w-full h-12 flex items-center justify-center text-[#6b7089] hover:text-[#f0f2f5] hover:bg-[#12131a] transition-colors ${
          isActive ? "text-[#f0f2f5] bg-[#0d0e14]" : ""
        }`}
      >
        {/* Active indicator - Synthi teal accent bar */}
        <div
          className={`absolute left-0 top-0 bottom-0 w-0.5 transition-all duration-200 ${
            isActive ? "bg-gradient-to-b from-[#327464] to-[#3d8b78] shadow-[0_0_8px_rgba(50,116,100,0.5)]" : "bg-transparent"
          }`}
        />
        <Icon className={`w-5 h-5 transition-colors ${isActive ? 'text-[#327464]' : ''}`} strokeWidth={2} />

        {/* Hover label - Synthi styled */}
        <div
          role="tooltip"
          className="pointer-events-none absolute left-full ml-2 top-1/2 -translate-y-1/2 z-50 whitespace-nowrap rounded-lg border border-[#1c1d26] bg-[#0d0e14] px-2.5 py-1.5 text-xs text-[#f0f2f5] opacity-0 group-hover:opacity-100 transition shadow-lg"
        >
          {label}
        </div>

        {/* Badge with Synthi teal */}
        {typeof badge === "number" && badge > 0 && (
          <div className="absolute right-2 top-2 min-w-4 h-4 px-1 rounded-full bg-gradient-to-r from-[#327464] to-[#3d8b78] text-white text-[10px] leading-4 text-center font-medium shadow-[0_0_6px_rgba(50,116,100,0.4)]">
            {badge}
          </div>
        )}
      </button>
    );
  };

  return (
    <div className="w-12 h-full flex flex-col items-center bg-[#0a0b10] border-r border-[#1c1d26]">
      <div className="w-full flex flex-col">{topItems.map(renderButton)}</div>
      
      {/* Synthi AI Badge - Unique branded feature indicator */}
      <div className="mt-auto mb-2 flex flex-col items-center">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-[#32746420] to-[#3d8b7820] border border-[#32746440] flex items-center justify-center cursor-pointer hover:border-[#32746480] transition-all group" title="Synthi AI">
          <Sparkles className="w-4 h-4 text-[#327464] group-hover:text-[#3d8b78]" strokeWidth={2} />
        </div>
      </div>
      
      <div className="w-full flex flex-col">{bottomItems.map(renderButton)}</div>
    </div>
  );
}
