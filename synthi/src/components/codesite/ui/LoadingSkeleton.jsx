

export default function LoadingSkeleton() {
  return (
    <div className="space-y-3 p-3" data-testid="codesite-loading">
      {[0, 1, 2, 3].map((item) => (
        <div
          key={item}
          className="h-16 rounded border"
          style={{
            borderColor: "var(--border-subtle)",
            background: "var(--bg-surface)",
            opacity: 0.75,
          }}
        />
      ))}
    </div>
  );
}
