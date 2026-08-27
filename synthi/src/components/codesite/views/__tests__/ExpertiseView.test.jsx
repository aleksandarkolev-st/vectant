/* @vitest-environment jsdom */

import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  answerCodeSiteProjectQuestion: vi.fn(),
  fetchCodeSiteProjectExperts: vi.fn(),
  fetchCodeSiteProjectKnowledge: vi.fn(),
  submitCodeSiteProjectQuestionFeedback: vi.fn(),
}));

vi.mock("../../codesiteClient", () => h);

import ExpertiseView from "../ExpertiseView";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container;
let root;

const openQuestion = {
  id: "question/1",
  kind: "agent_question",
  title: "Which route contract applies?",
  summary: "The caller and handler appear to use different versions.",
  status: "open",
  questionUrgency: "high",
  references: {
    paths: ["src/routes/checkout.ts"],
    contracts: ["checkout.route.v2"],
  },
};

const answeredQuestion = {
  ...openQuestion,
  status: "answered",
  answerText: "Use the versioned route contract.",
};

function renderView() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(
      <ExpertiseView workspaceSlug="team/a" project={{ id: "project/1" }} />,
    );
  });
  return container;
}

async function flush(times = 5) {
  for (let index = 0; index < times; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function setNativeValue(element, value) {
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(element),
    "value",
  );
  descriptor?.set?.call(element, value);
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function click(element) {
  act(() => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

beforeEach(() => {
  h.answerCodeSiteProjectQuestion.mockReset();
  h.fetchCodeSiteProjectExperts.mockReset();
  h.fetchCodeSiteProjectKnowledge.mockReset();
  h.submitCodeSiteProjectQuestionFeedback.mockReset();
  h.fetchCodeSiteProjectKnowledge.mockResolvedValue([]);
  h.fetchCodeSiteProjectExperts.mockResolvedValue({
    policyVersion: "policy.v1",
    experts: [],
  });
  h.answerCodeSiteProjectQuestion.mockResolvedValue({
    duplicate: false,
    question: answeredQuestion,
  });
  h.submitCodeSiteProjectQuestionFeedback.mockResolvedValue({
    duplicate: false,
  });
});

afterEach(() => {
  if (root) act(() => root.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("ExpertiseView", () => {
  it("searches project-derived expertise and renders returned evidence", async () => {
    h.fetchCodeSiteProjectExperts.mockResolvedValue({
      policyVersion: "synthi.codesite.expertise-policy.v1",
      experts: [
        {
          agentSessionId: "session-1",
          displayCallsign: "returned-callsign",
          agentProvider: "returned-provider",
          status: "attached",
          score: 3.5,
          evidence: ["plan_route:src/routes/checkout.ts"],
        },
      ],
    });
    renderView();
    await flush();

    setNativeValue(
      container.querySelector('[data-testid="codesite-expertise-input-paths"]'),
      "src/routes/checkout.ts\nsrc/routes/checkout.ts",
    );
    setNativeValue(
      container.querySelector(
        '[data-testid="codesite-expertise-input-symbols"]',
      ),
      "buildRoute",
    );
    click(
      container.querySelector(
        '[data-testid="codesite-expertise-search-submit"]',
      ),
    );
    await flush();

    expect(h.fetchCodeSiteProjectExperts).toHaveBeenCalledWith(
      "team/a",
      "project/1",
      {
        paths: ["src/routes/checkout.ts"],
        symbols: ["buildRoute"],
        contracts: [],
      },
    );
    expect(container.textContent).toContain("returned-callsign");
    expect(container.textContent).toContain("3.5 score");
    expect(container.textContent).toContain(
      "plan_route:src/routes/checkout.ts",
    );
  });

  it("loads unanswered questions and posts a project-safe response", async () => {
    h.fetchCodeSiteProjectKnowledge.mockResolvedValue([openQuestion]);
    renderView();
    await flush();

    expect(container.textContent).toContain(openQuestion.title);
    const answer = container.querySelector(
      '[data-testid="codesite-question-answer-question/1"]',
    );
    setNativeValue(answer, "Use the versioned route contract.");
    await flush();
    click(
      container.querySelector(
        '[data-testid="codesite-question-answer-submit-question/1"]',
      ),
    );
    await flush();

    expect(h.answerCodeSiteProjectQuestion).toHaveBeenCalledWith(
      "team/a",
      "project/1",
      "question/1",
      "Use the versioned route contract.",
    );
    expect(h.fetchCodeSiteProjectKnowledge).toHaveBeenCalledTimes(2);
  });

  it("submits correction feedback for an answered question", async () => {
    h.fetchCodeSiteProjectKnowledge.mockImplementation(
      async (_workspace, _project, filters) =>
        filters.status === "answered" ? [answeredQuestion] : [],
    );
    renderView();
    await flush();
    click(
      container.querySelector(
        '[data-testid="codesite-question-filter-answered"]',
      ),
    );
    await flush();

    expect(container.textContent).toContain(answeredQuestion.answerText);
    click(
      [...container.querySelectorAll("button")].find(
        (button) => button.textContent === "Needs correction",
      ),
    );
    const correction = container.querySelector(
      '[data-testid="codesite-question-question/1"] textarea',
    );
    setNativeValue(correction, "Use the versioned contract.");
    await flush();
    click(
      container.querySelector(
        '[data-testid="codesite-question-feedback-submit-question/1"]',
      ),
    );
    await flush();

    expect(h.submitCodeSiteProjectQuestionFeedback).toHaveBeenCalledWith(
      "team/a",
      "project/1",
      "question/1",
      {
        verdict: "needs_correction",
        correction: "Use the versioned contract.",
      },
    );
  });
});
