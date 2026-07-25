

export default function JsonPreview({ value, maxLines = 10 }) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2);
  const lines = text.split("\n").slice(0, maxLines).join("\n");
  return (
    <pre
      aria-label="CodeSite JSON proof details"
      className="max-h-44 overflow-auto rounded border p-2 text-[10px] leading-4"
      style={{
        borderColor: "var(--border-subtle)",
        background: "var(--bg-editor)",
        color: "var(--text-secondary)",
      }}
      tabIndex={0}
    >
      {lines}
    </pre>
  );
}
