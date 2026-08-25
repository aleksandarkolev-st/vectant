import { useState } from "react";
import { asArray } from "../lib/format";

export default function PathList({ paths, empty = "none", maxVisible = 4 }) {
  const list = asArray(paths);
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? list : list.slice(0, maxVisible);
  if (visible.length === 0) {
    return <span style={{ color: "var(--text-muted)" }}>{empty}</span>;
  }

  return (
    <div className="flex min-w-0 max-w-full flex-wrap items-start gap-1 self-start overflow-hidden">
      {visible.map((path, index) => (
        <code
          key={`${path}-${index}`}
          className="inline-block min-w-0 max-w-full break-all rounded border px-1.5 py-0.5 text-[10px] leading-4 whitespace-normal"
          style={{
            maxWidth: "min(100%, 18rem)",
            borderColor: "var(--border-subtle)",
            background: "var(--bg-editor)",
            color: "var(--text-secondary)",
          }}
          title={path}
        >
          {path}
        </code>
      ))}
      {list.length > visible.length ? (
        <button type="button" className="th-focus-ring text-[10px]" onClick={() => setExpanded(true)} style={{ color: "var(--accent-primary)" }}>
          Show {list.length - visible.length} more
        </button>
      ) : expanded && list.length > maxVisible ? (
        <button type="button" className="th-focus-ring text-[10px]" onClick={() => setExpanded(false)} style={{ color: "var(--accent-primary)" }}>
          Show less
        </button>
      ) : null}
    </div>
  );
}
