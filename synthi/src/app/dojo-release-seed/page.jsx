export const metadata = {
  title: 'Dojo release seed',
};

export default function DojoReleaseSeedPage() {
  return (
    <main
      style={{
        minHeight: '100vh',
        display: 'grid',
        placeItems: 'center',
        background: '#090b0f',
        color: '#f4f4f5',
        fontFamily: 'Inter, system-ui, sans-serif',
      }}
    >
      <section
        aria-label="Dojo release seed"
        style={{
          width: 'min(520px, calc(100vw - 48px))',
          border: '1px solid rgba(244, 244, 245, 0.14)',
          borderRadius: 12,
          padding: 28,
          background: 'rgba(255, 255, 255, 0.035)',
        }}
      >
        <p
          style={{
            margin: '0 0 12px',
            color: '#8b949e',
            fontSize: 12,
            letterSpacing: 0,
          }}
        >
          Dojo release gate
        </p>
        <h1
          style={{
            margin: '0 0 20px',
            fontSize: 24,
            lineHeight: 1.2,
            fontWeight: 600,
          }}
        >
          Release details fixture
        </h1>
        <button
          type="button"
          data-source-id="dojo.release.seed.action"
          style={{
            height: 40,
            padding: '0 16px',
            border: '1px solid #6ee7b7',
            borderRadius: 8,
            background: '#6ee7b7',
            color: '#06110d',
            fontSize: 14,
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          Open release details
        </button>
      </section>
    </main>
  );
}
