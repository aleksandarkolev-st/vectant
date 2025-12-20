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
        className={`group relative w-full h-12 flex items-center justify-center transition-all duration-150 ${
          isActive 
            ? "text-[#4aba9a] bg-[#0c0d12]" 
            : "text-[#3d4256] hover:text-[#9ba2b8] hover:bg-[#0c0d12]"
        }`}
      >
        {/* Active indicator - Strong teal accent bar */}
        <div
          className={`absolute left-0 top-1 bottom-1 w-[3px] rounded-r-full transition-all duration-200 ${
            isActive ? "bg-gradient-to-b from-[#3a8574] to-[#4aba9a] shadow-[0_0_10px_rgba(58,133,116,0.6)]" : "bg-transparent"
          }`}
        />
        <Icon className={`w-5 h-5 transition-all ${isActive ? 'opacity-100' : 'opacity-50 group-hover:opacity-80'}`} strokeWidth={isActive ? 2 : 1.5} />

        {/* Hover label - Synthi styled */}
        <div
          role="tooltip"
          className="pointer-events-none absolute left-full ml-3 top-1/2 -translate-y-1/2 z-50 whitespace-nowrap rounded-md border border-[#1a1b24] bg-[#0c0d12] px-2 py-1 text-[11px] font-medium text-[#f4f5f8] opacity-0 group-hover:opacity-100 transition shadow-lg"
        >
          {label}
        </div>

        {/* Badge with Synthi teal */}
        {typeof badge === "number" && badge > 0 && (
          <div className="absolute right-2 top-2 min-w-4 h-4 px-1 rounded-full bg-gradient-to-r from-[#3a8574] to-[#4a9a88] text-white text-[9px] leading-4 text-center font-semibold shadow-[0_0_8px_rgba(58,133,116,0.5)]">
            {badge}
          </div>
        )}
      </button>
    );
  };

  return (
    <div className="w-12 h-full flex flex-col items-center bg-[#08090d] border-r-2 border-[#1a1b24]">
      <div className="w-full flex flex-col pt-1">{topItems.map(renderButton)}</div>
      
      {/* Synthi AI Badge - Unique branded feature indicator */}
      <div className="mt-auto mb-3 flex flex-col items-center">
        <div className="w-7 h-7 rounded-lg bg-[#3a857412] border border-[#3a857430] flex items-center justify-center cursor-pointer hover:border-[#3a857460] hover:bg-[#3a857420] transition-all group" title="Synthi AI">
          <Sparkles className="w-3.5 h-3.5 text-[#3a8574] opacity-70 group-hover:opacity-100" strokeWidth={2} />
        </div>
      </div>
    </div>
  );
}
