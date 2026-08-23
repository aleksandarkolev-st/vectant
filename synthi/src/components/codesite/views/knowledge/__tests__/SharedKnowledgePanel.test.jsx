/* @vitest-environment jsdom */

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SharedKnowledgePanel from "../SharedKnowledgePanel";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;

const discovery = {
  id: "knowledge-discovery-1",
  kind: "discovery",
  visibility: "project",
  redactionClass: "project_fact",
  title: "Checkout retries can duplicate a reservation",
  summary: "The retry path reuses a stale idempotency key after a timeout.",
  status: "verified",
  verification: "verified",
  confidence: 0.92,
  source: {
    actorType: "agent",
    actorId: "research-agent",
    agentSessionId: "agent-session-7",
    terminalSessionId: "terminal-3",
    providerSessionRef: "provider-secret-never-render",
  },
  references: {
    paths: ["api/checkout/retry.js"],
    symbols: ["retryReservation"],
    contracts: ["checkout.idempotency.v2"],
    runtimeSessionIds: ["runtime-11"],
    agentSessionIds: ["agent-session-7"],
    workstreamIds: ["workstream-checkout"],
    transactionIds: ["transaction-22"],
  },
  impactCount: 2,
  requiresResponse: true,
  payload: "PRIVATE-DISCOVERY-PAYLOAD",
  prompt: "PRIVATE-PROMPT",
};

const lead = {
  id: "knowledge-lead-1",
  kind: "lead",
  visibility: "project",
  title: "Confirm cache invalidation owner",
  summary: "Ownership is unclear for the reservation cache invalidation path.",
  status: "claimed",
  priority: "high",
  confidence: 0.61,
  source: { actorType: "human", actorId: "alice" },
  references: { paths: ["api/cache/reservations.js"] },
};

const skill = {
  id: "knowledge-skill-1",
  kind: "shared_skill",
  visibility: "project",
  title: "Verify checkout idempotency",
  summary: "A reviewed sequence for exercising the retry contract.",
  status: "published",
  skillKey: "checkout-idempotency-proof",
  source: { actorType: "agent", actorId: "review-agent" },
  references: { contracts: ["checkout.idempotency.v2"] },
  recipe: {
    commands: ["PRIVATE-RECIPE-COMMAND"],
    environment: { ACCESS_TOKEN: "PRIVATE-ENV-VALUE" },
  },
};

const handoff = {
  id: "knowledge-handoff-1",
  kind: "handoff",
  visibility: "project",
  title: "Checkout retry review ready",
  summary: "The failing retry path and evidence are ready for the next owner.",
  status: "ready",
  source: { actorType: "agent", actorId: "research-agent" },
  references: { paths: ["api/checkout/retry.js"] },
  fromAgentSessionId: "agent-session-7",
  toAgentSessionId: "agent-session-8",
  requiredActions: ["PRIVATE-RECIPIENT-ACTION"],
  unresolvedRisks: ["PRIVATE-RECIPIENT-RISK"],
};

function renderPanel(props = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <SharedKnowledgePanel
        items={[discovery, lead, skill, handoff]}
        {...props}
      />,
    );
  });
  return container;
}

function click(element) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function keydown(element, key) {
  act(() => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

beforeEach(() => {
  container = null;
  root = null;
});

afterEach(() => {
  if (root) {
    act(() => root.unmount());
  }
  container?.remove();
});

describe("SharedKnowledgePanel", () => {
  it("renders a labelled tab interface with project-safe discovery evidence", () => {
    renderPanel();

    const tablist = container.querySelector('[role="tablist"]');
    const tabs = [...container.querySelectorAll('[role="tab"]')];
    const panel = container.querySelector('[role="tabpanel"]');

    expect(tablist.getAttribute("aria-label")).toBe(
      "Shared knowledge categories",
    );
    expect(tabs).toHaveLength(4);
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Discoveries1",
      "Leads1",
      "Skills1",
      "Handoffs1",
    ]);
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].tabIndex).toBe(0);
    expect(tabs.slice(1).every((tab) => tab.tabIndex === -1)).toBe(true);
    expect(panel.getAttribute("aria-labelledby")).toBe(tabs[0].id);
    expect(tabs[0].getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("tabindex")).toBe("0");

    expect(panel.textContent).toContain(discovery.title);
    expect(panel.textContent).toContain(discovery.summary);
    expect(panel.textContent).toContain("Verified");
    expect(panel.textContent).toContain("92% confidence");
    expect(panel.querySelector("meter").getAttribute("aria-label")).toBe(
      "Confidence: 92 percent",
    );
    expect(panel.textContent).toContain("Agent · research-agent");
    expect(panel.textContent).toContain(
      "agent agent-session-7 · terminal terminal-3",
    );
    expect(panel.textContent).toContain("api/checkout/retry.js");
    expect(panel.textContent).toContain("retryReservation");
    expect(panel.textContent).toContain("checkout.idempotency.v2");
    expect(panel.textContent).toContain("runtime-11");
    expect(panel.textContent).toContain("workstream-checkout");
    expect(panel.textContent).toContain("transaction-22");
  });

  it("changes tabs on click and reports the selected kind", () => {
    const onActiveKindChange = vi.fn();
    renderPanel({ onActiveKindChange });

    click(container.querySelector('[data-testid="shared-knowledge-tab-lead"]'));

    expect(onActiveKindChange).toHaveBeenCalledWith("lead");
    expect(
      container
        .querySelector('[data-testid="shared-knowledge-tab-lead"]')
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(container.querySelector('[role="tabpanel"]').textContent).toContain(
      lead.title,
    );
    expect(
      container.querySelector('[role="tabpanel"]').textContent,
    ).not.toContain(discovery.title);
  });

  it.each([
    ["ArrowRight", "lead"],
    ["ArrowLeft", "handoff"],
    ["End", "handoff"],
  ])(
    "supports %s keyboard navigation with selection and focus",
    (key, expectedKind) => {
      const onActiveKindChange = vi.fn();
      renderPanel({ onActiveKindChange });
      const first = container.querySelector(
        '[data-testid="shared-knowledge-tab-discovery"]',
      );
      first.focus();

      keydown(first, key);

      const expected = container.querySelector(
        `[data-testid="shared-knowledge-tab-${expectedKind}"]`,
      );
      expect(document.activeElement).toBe(expected);
      expect(expected.getAttribute("aria-selected")).toBe("true");
      expect(onActiveKindChange).toHaveBeenCalledWith(expectedKind);
    },
  );

  it("supports Home navigation and a controlled selected tab", () => {
    const onActiveKindChange = vi.fn();
    renderPanel({ activeKind: "handoff", onActiveKindChange });
    const handoffTab = container.querySelector(
      '[data-testid="shared-knowledge-tab-handoff"]',
    );
    expect(handoffTab.getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector('[role="tabpanel"]').textContent).toContain(
      handoff.title,
    );

    keydown(handoffTab, "Home");

    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="shared-knowledge-tab-discovery"]'),
    );
    expect(onActiveKindChange).toHaveBeenCalledWith("discovery");
    expect(handoffTab.getAttribute("aria-selected")).toBe("true");
  });

  it("shows compact impact visibility without rendering impact or private payloads", () => {
    renderPanel({
      items: [
        discovery,
        {
          id: "impact-private-1",
          kind: "impact_notice",
          visibility: "restricted",
          title: "PRIVATE-IMPACT-TITLE",
          summary: "PRIVATE-IMPACT-SUMMARY",
          recipientAgentSessionIds: ["PRIVATE-RECIPIENT"],
          responseAction: "PRIVATE-RESPONSE-ACTION",
        },
        {
          ...lead,
          id: "owner-private-lead",
          visibility: "owner_private",
          title: "PRIVATE-OWNER-LEAD",
        },
        {
          ...lead,
          id: "restricted-lead",
          visibility: "restricted",
          title: "PRIVATE-RESTRICTED-LEAD",
        },
        {
          ...lead,
          id: "unknown-visibility-lead",
          visibility: "unexpected_scope",
          title: "PRIVATE-UNKNOWN-VISIBILITY",
        },
        {
          ...discovery,
          id: "redacted-discovery",
          redactionClass: "owner_private",
          title: "PRIVATE-REDACTION-CLASS",
        },
        {
          ...discovery,
          id: "unknown-redaction-discovery",
          redactionClass: "unexpected_class",
          title: "PRIVATE-UNKNOWN-REDACTION",
        },
      ],
    });

    const impact = container.querySelector(
      '[data-testid="shared-knowledge-impact"]',
    );
    expect(impact.textContent).toContain("2 affected");
    expect(impact.textContent).toContain("Response needed");
    expect(container.textContent).not.toContain("PRIVATE-");
    expect(container.textContent).not.toContain("provider-secret-never-render");
  });

  it("never renders recipes, recipient-only handoff details, prompts, or provider refs", () => {
    renderPanel();
    for (const kind of ["discovery", "shared_skill", "handoff"]) {
      click(
        container.querySelector(`[data-testid="shared-knowledge-tab-${kind}"]`),
      );
      expect(container.textContent).not.toContain("PRIVATE-");
      expect(container.textContent).not.toContain(
        "provider-secret-never-render",
      );
    }
    click(
      container.querySelector(
        '[data-testid="shared-knowledge-tab-shared_skill"]',
      ),
    );
    expect(container.textContent).toContain(skill.title);
    click(
      container.querySelector('[data-testid="shared-knowledge-tab-handoff"]'),
    );
    expect(container.textContent).toContain(handoff.title);
  });

  it("renders a polite loading state and marks the panel busy", () => {
    renderPanel({ loading: true });

    const panel = container.querySelector(
      '[data-testid="shared-knowledge-panel"]',
    );
    const loading = container.querySelector(
      '[data-testid="shared-knowledge-loading"]',
    );
    expect(panel.getAttribute("aria-busy")).toBe("true");
    expect(loading.getAttribute("role")).toBe("status");
    expect(loading.textContent).toBe("Loading shared knowledge");
    expect(container.textContent).not.toContain(discovery.title);
  });

  it("renders an actionable error state and invokes retry", () => {
    const onRetry = vi.fn();
    renderPanel({
      error: new Error("The project connection closed."),
      onRetry,
    });

    const alert = container.querySelector('[role="alert"]');
    expect(alert.textContent).toContain("Shared knowledge is unavailable");
    expect(alert.textContent).toContain("The project connection closed.");
    click(
      [...alert.querySelectorAll("button")].find(
        (button) => button.textContent === "Try again",
      ),
    );
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("renders a meaningful, category-specific empty state", () => {
    renderPanel({ items: [], defaultKind: "shared_skill" });

    expect(
      container.querySelector('[data-testid="shared-knowledge-empty"]')
        .textContent,
    ).toContain("No reviewed skills have been shared with this project yet.");
    click(
      container.querySelector('[data-testid="shared-knowledge-tab-handoff"]'),
    );
    expect(
      container.querySelector('[data-testid="shared-knowledge-empty"]')
        .textContent,
    ).toContain("No handoffs have been shared with this project yet.");
  });

  it("handles malformed inputs without leaking object values", () => {
    renderPanel({
      items: [
        null,
        "not-an-item",
        {
          kind: "discovery",
          title: { secret: "PRIVATE-OBJECT" },
          summary: { secret: "PRIVATE-SUMMARY" },
        },
      ],
    });

    expect(container.textContent).toContain("Untitled discovery");
    expect(container.textContent).toContain(
      "No project-safe summary was provided.",
    );
    expect(container.textContent).not.toContain("PRIVATE-");
    expect(container.textContent).not.toContain("[object Object]");
  });

  it("uses unique tab and panel ids across multiple instances", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        <>
          <SharedKnowledgePanel items={[]} title="Primary knowledge" />
          <SharedKnowledgePanel items={[]} title="Secondary knowledge" />
        </>,
      );
    });

    const tablists = [...container.querySelectorAll('[role="tablist"]')];
    const firstTab = tablists[0].querySelector('[role="tab"]');
    const secondTab = tablists[1].querySelector('[role="tab"]');
    expect(firstTab.id).not.toBe(secondTab.id);
    expect(
      new Set(
        [...container.querySelectorAll("[id]")].map((element) => element.id),
      ).size,
    ).toBe(container.querySelectorAll("[id]").length);
  });
});
