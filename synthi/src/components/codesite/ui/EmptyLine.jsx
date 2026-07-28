

export default function EmptyLine({ children = "None" }) {
  return (
    <div
      className="rounded border px-3 py-3 text-xs"
      style={{
        borderColor: "var(--border-subtle)",
        color: "var(--text-muted)",
      }}
    >
      {children}
    </div>
  );
}
