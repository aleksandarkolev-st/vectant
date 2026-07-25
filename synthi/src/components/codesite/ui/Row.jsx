

export default function Row({ children, testId }) {
  return (
    <div
      data-testid={testId}
      className="grid min-h-10 grid-cols-[minmax(76px,0.9fr)_minmax(0,1.5fr)_minmax(72px,0.8fr)] items-center gap-2 border-t py-2 text-xs first:border-t-0"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      {children}
    </div>
  );
}
