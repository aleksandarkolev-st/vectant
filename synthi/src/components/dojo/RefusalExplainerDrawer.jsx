'use client';

import { Ban, FileWarning } from 'lucide-react';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function RefusalExplainerDrawer({ refusal }) {
  if (!refusal) {
    return (
      <section className="rounded-md border p-4" style={panelStyle} data-testid="refusal-explainer-empty">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Ban size={15} aria-hidden="true" />
          Refusal Explainer
        </h2>
        <p className="mt-2 text-sm" style={{ color: 'var(--text-muted)' }}>No blocked action is currently recorded.</p>
      </section>
    );
  }

  return (
    <section className="rounded-md border p-4" style={panelStyle} data-testid="refusal-explainer-drawer">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Ban size={15} aria-hidden="true" />
            Refusal Explainer
          </h2>
          <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{refusal.requestedAction || 'blocked action'}</p>
        </div>
        <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{refusal.status || 'blocked'}</span>
      </div>

      {refusal.refusal ? (
        <p className="mt-4 rounded-md border p-3 text-sm leading-6" style={{ borderColor: 'var(--border-subtle)' }}>
          {refusal.refusal}
        </p>
      ) : null}

      <section className="mt-4 grid gap-4 md:grid-cols-2">
        <List title="Blocked By" items={refusal.blockedBy} />
        <List title="Error Codes" items={refusal.errorCodes} />
      </section>

      <section className="mt-4">
        <h3 className="mb-2 flex items-center gap-2 text-xs font-semibold">
          <FileWarning size={13} aria-hidden="true" />
          Case Law
        </h3>
        {refusal.caseLawRefs?.length ? (
          <div className="grid gap-2">
            {refusal.caseLawRefs.map((item) => (
              <div key={`${item.id}-${item.title}`} className="rounded-md border px-3 py-2 text-xs" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="font-semibold">{item.id || item.title}</div>
                {item.title && item.title !== item.id ? (
                  <div className="mt-1" style={{ color: 'var(--text-muted)' }}>{item.title}</div>
                ) : null}
                {item.status ? <div className="mt-1" style={{ color: 'var(--text-muted)' }}>{item.status}</div> : null}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs" style={{ color: 'var(--text-muted)' }}>No case-law citation recorded</p>
        )}
      </section>

      {refusal.requiredSteps?.length || refusal.nextStep ? (
        <section className="mt-4">
          <h3 className="mb-2 text-xs font-semibold">Smallest Allowed Next Step</h3>
          <ul className="grid gap-2 text-xs">
            {[refusal.nextStep, ...(refusal.requiredSteps || [])].filter(Boolean).map((step) => (
              <li key={step} className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
                {step}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

function List({ title, items = [] }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold">{title}</h3>
      {items.length ? (
        <ul className="grid gap-2 text-xs">
          {items.map((item) => (
            <li key={`${title}-${item}`} className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
              {item}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>None recorded</p>
      )}
    </section>
  );
}
