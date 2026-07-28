import { asArray } from "../lib/format";

export default function TagList({ items, empty = null, maxVisible = 5 }) {
  const list = asArray(items).filter(Boolean);
  const visible = list.slice(0, maxVisible);
  if (visible.length === 0)
    return empty ? (
      <span style={{ color: "var(--text-muted)" }}>{empty}</span>
    ) : null;

  return (
    <div className="mt-1 flex min-w-0 flex-wrap gap-1">
      {visible.map((item, index) => (
        <code
          key={`${item}-${index}`}
          className="max-w-full break-all rounded border px-1.5 py-0.5 text-[10px] leading-4 whitespace-normal"
          style={{
            borderColor: "var(--border-subtle)",
            background: "var(--bg-editor)",
            color: "var(--text-secondary)",
          }}
          title={item}
        >
          {item}
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
