'use client';

import { CheckCircle2, ClipboardCheck, XCircle } from 'lucide-react';

const panelStyle = {
  borderColor: 'var(--border-subtle)',
  background: 'color-mix(in srgb, var(--bg-panel) 92%, transparent)',
};

export default function ApprovalQueue({
  items = [],
  onApprove,
  onDeny,
  busyQueueId = '',
  canApprove = () => true,
  canDeny = () => true,
}) {
  return (
    <section className="rounded-md border p-4" style={panelStyle} data-testid="approval-queue">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <ClipboardCheck size={15} aria-hidden="true" />
          Approval Queue
        </h2>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{items.length} pending</span>
      </div>
      {items.length ? (
        <div className="grid gap-2">
          {items.map((item) => (
            <ApprovalQueueItem
              key={item.queueId}
              item={item}
              onApprove={onApprove}
              onDeny={onDeny}
              busyQueueId={busyQueueId}
              canApprove={canApprove}
              canDeny={canDeny}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>No approval work is currently queued.</p>
      )}
    </section>
  );
}

function ApprovalQueueItem({ item, onApprove, onDeny, busyQueueId, canApprove, canDeny }) {
  const approveSupported = canApprove(item);
  const denySupported = canDeny(item);
  const approveDisabled = !onApprove || busyQueueId === item.queueId || !approveSupported;
  const denyDisabled = !onDeny || busyQueueId === item.queueId || !denySupported;
  return (
    <article className="rounded-md border p-3" style={{ borderColor: 'var(--border-subtle)' }}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{item.action || 'Approval'}</h3>
          <p className="mt-1 truncate text-xs" style={{ color: 'var(--text-muted)' }}>{item.skillId || item.licenseId}</p>
        </div>
        <span className="rounded-md border px-2 py-1 text-xs" style={panelStyle}>{item.status || 'pending'}</span>
      </div>
      {item.reason ? <p className="mt-3 text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>{item.reason}</p> : null}
      {item.constraints?.length ? (
        <ul className="mt-3 grid gap-2 text-xs">
          {item.constraints.map((constraint) => (
            <li key={`${item.queueId}-${constraint}`} className="rounded-md border px-3 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
              {constraint}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <ActionButton
          icon={CheckCircle2}
          label="Approve"
          disabled={approveDisabled}
          testId={`approval-${item.queueId}-approve`}
          onClick={() => onApprove?.(item)}
          unavailableReason={approveSupported ? undefined : 'Review is not supported for this approval source yet'}
        />
        <ActionButton
          icon={XCircle}
          label="Deny"
          disabled={denyDisabled}
          testId={`approval-${item.queueId}-deny`}
          onClick={() => onDeny?.(item)}
          unavailableReason={denySupported ? undefined : 'Review is not supported for this approval source yet'}
        />
      </div>
    </article>
  );
}

function ActionButton({ icon: Icon, label, disabled, testId, onClick, unavailableReason }) {
  return (
    <button
      type="button"
      className="inline-flex h-8 items-center gap-2 rounded-md border px-3 text-xs disabled:cursor-not-allowed disabled:opacity-45"
      style={panelStyle}
      disabled={disabled}
      data-testid={testId}
      onClick={onClick}
      title={disabled ? (unavailableReason || 'Action handler unavailable') : label}
    >
      <Icon size={13} aria-hidden="true" />
      {label}
    </button>
  );
}
