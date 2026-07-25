import { EmptyLine, JsonPreview, Pill, SignalBar } from "../../ui";
import { asArray, countBy, eventDisplayType, eventPathLabel, formatCompactNumber, formatTime } from "../../lib/format";
import { hasEntries } from "../../lib/quarantine";

export default function BlackBoxFlightRecorder({ events }) {
  const rows = asArray(events);
  if (!rows.length) return <EmptyLine>No events recorded</EmptyLine>;
  const typeCounts = Object.entries(
    countBy(rows.map((event) => eventDisplayType(event))),
  )
    .sort((left, right) => right[1] - left[1])
    .slice(0, 6);
  const actors = Object.keys(
    countBy(rows.map((event) => event.displayCallsign || event.actorType)),
  );

  return (
    <div data-testid="codesite-black-box-recorder" className="grid gap-3">
      <div
        className="grid gap-2 rounded-lg border px-3 py-2 text-xs @min-[44rem]/panel:grid-cols-[minmax(0,1fr)_minmax(220px,0.45fr)]"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 78%, var(--accent-primary) 22%)",
          background: "var(--bg-surface)",
        }}
      >
        <div className="min-w-0">
          <div className="font-semibold">Event recorder stream</div>
          <div
            className="mt-1 max-w-[65ch] leading-5"
            style={{ color: "var(--text-muted)" }}
          >
            Ordered event evidence with actor, logical time, path, and payload
            preview for event replay.
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1 @min-[44rem]/panel:justify-end">
          <Pill>{rows.length} events</Pill>
          <Pill>{actors.length} actors</Pill>
        </div>
      </div>
      <div className="grid min-w-0 gap-3 @min-[52rem]/panel:grid-cols-[minmax(0,1fr)_minmax(220px,0.35fr)]">
        <div className="space-y-1">
          {rows.map((event, index) => (
            <div
              key={
                event.id ||
                event.eventId ||
                `${event.eventType || "event"}-${index}`
              }
              className="rounded-md border px-2 py-1.5 text-xs"
              style={{
                borderColor: "var(--border-subtle)",
                background: index % 2 ? "var(--bg-surface)" : "var(--bg-editor)",
              }}
            >
              <div className="grid min-h-9 grid-cols-[52px_minmax(0,1fr)_minmax(88px,auto)] items-center gap-2">
                <span
                  className="font-mono text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {formatTime(event.createdAt)}
                </span>
                <div className="min-w-0">
                  <div className="truncate">{eventDisplayType(event)}</div>
                  <div
                    className="truncate font-mono text-[10px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {eventPathLabel(event)}
                  </div>
                </div>
                <span
                  className="max-w-[110px] truncate text-right text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {event.displayCallsign || event.actorType || ""}
                </span>
              </div>
              {hasEntries(event.details) || asArray(event.evidenceRefs).length ? (
                <div className="mt-1">
                  <JsonPreview
                    value={{
                      eventId: event.id,
                      logicalTime: event.logicalTime,
                      details: event.details || {},
                      evidenceRefs: event.evidenceRefs || [],
                    }}
                    maxLines={10}
                  />
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <div className="grid min-w-0 content-start gap-2">
          {typeCounts.map(([type, count]) => (
            <div
              key={type}
              className="rounded-md border px-2 py-1.5 text-xs"
              style={{
                borderColor: "var(--border-subtle)",
                background: "var(--bg-surface)",
              }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">{type}</span>
                <span className="font-mono tabular-nums">
                  {formatCompactNumber(count)}
                </span>
              </div>
              <div className="mt-1">
                <SignalBar
                  value={count / rows.length}
                  tone={count > 1 ? "holding" : "active"}
                  label={`${type} event share`}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
