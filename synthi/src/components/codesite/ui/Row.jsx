

// Three columns only once the panel can hold them. This primitive backs most of
// the panel's lists, so an unconditional three-up grid was crushing all of them
// at dock widths.
export default function Row({ children, testId }) {
  return (
    <div
      data-testid={testId}
      className="grid min-h-10 grid-cols-1 items-start gap-1 border-t py-2 text-xs first:border-t-0 @min-[26rem]/panel:grid-cols-[minmax(76px,0.9fr)_minmax(0,1.5fr)_minmax(72px,0.8fr)] @min-[26rem]/panel:items-center @min-[26rem]/panel:gap-2"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      {children}
    </div>
  );
}
