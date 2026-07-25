import { CodeSiteIcons } from "../icons";
import { compact, toneLabel } from "../lib/format";
import { hasEntries } from "../lib/quarantine";
import { EmptyLine, JsonPreview, OperatorPane, Pill, Section } from "../ui";
import TowerStreamPanel from "./activity/TowerStreamPanel";
import BlackBoxFlightRecorder from "./activity/BlackBoxFlightRecorder";

export default function ActivityView({ events, streamStatus, inboxItems }) {
  return (
    <>
      <div className="grid min-w-0 content-start gap-3 p-3 sm:p-4">
        <OperatorPane
          title="Activity Feed"
          icon={CodeSiteIcons.activity}
          testId="codesite-operator-tower-pane"
          right={
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
          }
        >
          <TowerStreamPanel
            events={events}
            streamStatus={streamStatus}
            condensed
          />
        </OperatorPane>
      </div>

      <Section
        title="Audit Event Log"
        icon={CodeSiteIcons.activity}
        right={<Pill>{events.length}</Pill>}
      >
        <BlackBoxFlightRecorder events={events} />
      </Section>

      <Section
        title="Agent Inbox"
        icon={CodeSiteIcons.files}
        right={
          <Pill
            tone={
              inboxItems.some((item) => item.status === "pending")
                ? "holding"
                : "active"
            }
          >
            {inboxItems.length}
          </Pill>
        }
      >
        {inboxItems.length === 0 ? (
          <EmptyLine>No routed inbox items</EmptyLine>
        ) : (
          <div className="space-y-1">
            {inboxItems
              .slice(-5)
              .reverse()
              .map((item, index) => (
                <div
                  key={
                    item.id ||
                    item.eventId ||
                    `${item.kind || "inbox"}-${index}`
                  }
                  className="rounded border px-2 py-1.5 text-xs"
                  style={{
                    borderColor: "var(--border-subtle)",
                    background: "var(--bg-surface)",
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate font-medium">
                        {compact(item.kind, "inbox")}
                      </div>
                      <div
                        className="truncate font-mono text-[10px]"
                        style={{ color: "var(--text-muted)" }}
                      >
                        {compact(item.agentSessionId, "session")} /{" "}
                        {compact(item.eventId, "event")}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      {item.requiresResponse ? (
                        <Pill tone="holding">response</Pill>
                      ) : null}
                      <Pill tone={item.status}>
                        {toneLabel(item.status)}
                      </Pill>
                    </div>
                  </div>
                  {hasEntries(item.redactedPayload) ? (
                    <div className="mt-1">
                      <JsonPreview
                        value={item.redactedPayload}
                        maxLines={6}
                      />
                    </div>
                  ) : null}
                </div>
              ))}
          </div>
        )}
      </Section>
    </>
  );
}
