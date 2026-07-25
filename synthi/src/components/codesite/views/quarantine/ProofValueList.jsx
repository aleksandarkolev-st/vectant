import { asArray } from "../../lib/format";

export default function ProofValueList({ values, empty = "none", maxVisible = 3 }) {
  const list = asArray(values);
  const visible = list.slice(0, maxVisible);
  if (!visible.length) {
    return <span style={{ color: "var(--text-muted)" }}>{empty}</span>;
  }
  return (
    <div className="flex min-w-0 max-w-full flex-wrap gap-1">
      {visible.map((value, index) => (
        <code
          key={`${value}-${index}`}
          className="block min-w-0 max-w-full whitespace-normal break-all rounded border px-1.5 py-0.5 text-[10px] leading-4"
          style={{
            borderColor: "var(--border-subtle)",
            background: "var(--bg-surface)",
            color: "var(--text-secondary)",
            overflow: "visible",
            textOverflow: "clip",
            whiteSpace: "normal",
            wordBreak: "break-all",
          }}
          title={value}
        >
          {value}
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
