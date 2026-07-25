import { asArray } from "../lib/format";

export default function PathList({ paths, empty = "none", maxVisible = 4 }) {
  const list = asArray(paths);
  const visible = list.slice(0, maxVisible);
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
        <span className="text-[10px]" style={{ color: "var(--text-muted)" }}>
          +{list.length - visible.length}
        </span>
      ) : null}
    </div>
  );
}
