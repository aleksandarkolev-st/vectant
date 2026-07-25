import { EmptyLine, Metric, Pill } from "../../ui";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { MOTION_EASE } from "../../lib/motion";
import { asArray, compact, formatTime, towerEventKind, towerInstructionText } from "../../lib/format";
import { CodeSiteIcons } from "../../icons";

export default function TowerStreamPanel({ events, streamStatus, condensed = false }) {
  const reduceMotion = useReducedMotion();
  const rows = asArray(events).slice(0, condensed ? 5 : 8);
  return (
    <div
      data-testid="codesite-activity-feed"
      className={
        condensed
          ? "grid min-w-0 gap-2"
          : "grid min-w-0 gap-2 @min-[44rem]/panel:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]"
      }
    >
      <div
        className="rounded-lg border p-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.045)]"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 78%, var(--accent-primary) 22%)",
          background:
            "linear-gradient(180deg, color-mix(in srgb, var(--bg-surface) 90%, var(--accent-primary) 8%), var(--bg-surface))",
        }}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2">
            <span
              className="grid h-7 w-7 shrink-0 place-items-center rounded-md border"
              style={{
                borderColor:
                  "color-mix(in srgb, var(--border-subtle) 76%, var(--accent-primary) 24%)",
                background:
                  "color-mix(in srgb, var(--accent-primary) 9%, transparent)",
              }}
            >
              <CodeSiteIcons.activity
                className="h-3.5 w-3.5"
                style={{ color: "var(--accent-primary)" }}
              />
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold">Activity log</div>
              <div
                className="mt-0.5 text-[10px] uppercase"
                style={{ color: "var(--text-muted)" }}
              >
                Agent updates, blockers, and guardrails
              </div>
            </div>
            <div
              data-testid="codesite-event-stream-status"
              className="mt-1 text-[11px]"
              style={{ color: "var(--text-muted)" }}
            >
              {streamStatus === "live"
                ? "Live updates connected"
                : streamStatus === "reconnecting"
                  ? "Reconnecting updates"
                  : "Checking for updates"}
            </div>
          </div>
          <Pill
            tone={
              streamStatus === "live"
                ? "active"
                : streamStatus === "reconnecting"
                  ? "warning"
                  : "idle"
            }
          >
            {streamStatus}
          </Pill>
        </div>
        <div
          data-testid="codesite-transponder-stream"
          className="mt-3 grid grid-cols-3 gap-2"
        >
          <Metric
            label="Events"
            value={rows.length}
            tone={rows.length ? "active" : "idle"}
            icon={CodeSiteIcons.activity}
          />
          <Metric
            label="Coordination"
            value={
              rows.filter((event) =>
                String(event.eventType || "").includes("tower"),
              ).length
            }
            icon={CodeSiteIcons.governance}
          />
          <Metric
            label="Blocks"
            value={
              rows.filter((event) =>
                /denied|quarantined|ground_stop/i.test(
                  String(event.eventType || ""),
                ),
              ).length
            }
            tone="holding"
            icon={CodeSiteIcons.conflicts}
          />
        </div>
      </div>
      <div
        className="min-w-0 overflow-hidden rounded-lg border"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 82%, var(--accent-primary) 18%)",
          background: "var(--bg-surface)",
        }}
      >
        <div
          className="grid grid-cols-[52px_minmax(0,1fr)_auto] gap-2 border-b px-3 py-2 text-[10px] font-semibold"
          style={{
            borderColor: "var(--border-subtle)",
            color: "var(--text-muted)",
            background: "color-mix(in srgb, var(--bg-elevated) 72%, transparent)",
          }}
        >
          <span>Time</span>
          <span>Update</span>
          <span>Actor</span>
        </div>
        <AnimatePresence initial={false}>
          {rows.length ? (
            rows.map((event, index) => (
              <motion.div
                key={
                  event.id ||
                  `${event.eventType || "event"}-${event.createdAt || index}`
                }
                data-testid="codesite-tower-instruction-row"
                layout={!reduceMotion}
                initial={reduceMotion ? false : { opacity: 0, y: -8 }}
                animate={reduceMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
                exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8 }}
                transition={{
                  duration: reduceMotion ? 0 : 0.22,
                  ease: MOTION_EASE,
                }}
                className="grid min-h-11 grid-cols-[52px_minmax(0,1fr)_auto] items-center gap-2 border-t px-3 py-2 text-xs first:border-t-0"
                style={{
                  borderColor: "var(--border-subtle)",
                  background:
                    index === 0
                      ? "color-mix(in srgb, var(--accent-primary) 8%, transparent)"
                      : "transparent",
                }}
              >
                <span
                  className="font-mono text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {formatTime(event.createdAt)}
                </span>
                <span className="min-w-0 break-words">
                  <span className="font-medium">
                    {towerInstructionText(event)}
                  </span>
                  <span
                    className="ml-1 text-[10px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {towerEventKind(event)}
                  </span>
                </span>
                <Pill tone={event.eventType}>
                  {compact(event.displayCallsign || event.actorType, "system")}
                </Pill>
              </motion.div>
            ))
          ) : (
            <div className="p-3">
              <EmptyLine>No activity events received</EmptyLine>
            </div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
