
import { useState } from "react";

export default function JsonPreview({ value, maxLines = 10 }) {
  const [expanded, setExpanded] = useState(false);
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2);
  const sourceLines = text.split("\n");
  const lines = (expanded ? sourceLines : sourceLines.slice(0, maxLines)).join("\n");
  return (
    <div>
      <pre aria-label="CodeSite JSON proof details" className="max-h-44 overflow-auto rounded border p-2 text-[10px] leading-4" style={{ borderColor: "var(--border-subtle)", background: "var(--bg-editor)", color: "var(--text-secondary)" }} tabIndex={0}>{lines}</pre>
      {sourceLines.length > maxLines ? (
        <button type="button" className="th-focus-ring mt-1 text-[10px]" onClick={() => setExpanded((current) => !current)} style={{ color: "var(--accent-primary)" }}>
          {expanded ? "Show preview" : `Show ${sourceLines.length - maxLines} more lines`}
        </button>
      ) : null}
    </div>
  );
}
