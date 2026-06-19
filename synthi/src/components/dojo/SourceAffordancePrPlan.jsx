'use client';

import { FileCode2, ListChecks } from 'lucide-react';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function SourceAffordancePrPlan({ plan }) {
  const files = plan?.files || [];
  const generatedTests = plan?.generatedTests || [];
  const checklist = plan?.reviewChecklist || [];

  return (
    <section className="rounded-md border" style={panelStyle} data-testid="source-affordance-pr-plan">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <FileCode2 size={15} aria-hidden="true" />
            Source Affordance PR
          </h2>
          <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{plan?.planId || 'no-plan-id'}</p>
        </div>
        <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{plan?.readiness || 'not_ready'}</span>
      </div>

      {files.length ? (
        <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
          {files.map((file) => (
            <article key={file.filePath} className="px-4 py-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-sm font-semibold">{file.filePath}</h3>
                  {file.sourceAnchorId ? <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{file.sourceAnchorId}</p> : null}
                </div>
                <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{file.patches.length} patches</span>
              </div>
              <div className="mt-3 grid gap-2">
                {file.patches.map((patch) => (
                  <div key={patch.patchId} className="rounded-md border p-3 text-xs" style={{ borderColor: 'var(--border-subtle)' }}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold">{patch.intent || patch.actionId || patch.patchId}</span>
                      <span style={{ color: patch.reviewRequired ? 'var(--accent-warning)' : 'var(--accent-success)' }}>
                        {patch.reviewRequired ? 'review' : 'ready'}
                      </span>
                    </div>
                    <dl className="mt-2 grid gap-1">
                      <Info label="Action" value={patch.actionId || 'Not recorded'} />
                      <Info label="Locator" value={patch.suggestedAttribute || 'Not recorded'} />
                      <Info label="Risk" value={patch.riskAnnotation || 'Not recorded'} />
                      <Info label="Proof" value={patch.proofHook || 'Not recorded'} />
                    </dl>
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="p-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
          No source patch files are reported.
        </div>
      )}

      <div className="grid gap-3 border-t p-4 md:grid-cols-2" style={{ borderColor: 'var(--border-subtle)' }}>
        <section>
          <h3 className="flex items-center gap-2 text-xs font-semibold">
            <ListChecks size={13} aria-hidden="true" />
            Generated Tests
          </h3>
          {generatedTests.length ? (
            <ul className="mt-2 grid gap-2 text-xs">
              {generatedTests.map((test) => (
                <li key={`${test.path}-${test.purpose}`} className="rounded-md border p-2" style={{ borderColor: 'var(--border-subtle)' }}>
                  <div className="truncate font-medium">{test.path || test.purpose}</div>
                  {test.purpose ? <div className="mt-1 truncate" style={{ color: 'var(--text-muted)' }}>{test.purpose}</div> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>No generated tests are listed.</p>
          )}
        </section>
        <section>
          <h3 className="text-xs font-semibold">Review Checklist</h3>
          {checklist.length ? (
            <ul className="mt-2 grid gap-2 text-xs">
              {checklist.map((item) => <li key={item} className="truncate">{item}</li>)}
            </ul>
          ) : (
            <p className="mt-2 text-xs" style={{ color: 'var(--text-muted)' }}>No review checklist is listed.</p>
          )}
        </section>
      </div>
    </section>
  );
}

function Info({ label, value }) {
  return (
    <div className="grid grid-cols-[72px_minmax(0,1fr)] gap-3">
      <dt style={{ color: 'var(--text-muted)' }}>{label}</dt>
      <dd className="min-w-0 truncate text-right">{value}</dd>
    </div>
  );
}
