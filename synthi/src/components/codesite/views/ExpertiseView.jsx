"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, Send } from "lucide-react";
import { EXPERTISE_POLICY } from "../../../lib/codesite/expertisePolicy";
import {
  answerCodeSiteProjectQuestion,
  fetchCodeSiteProjectExperts,
  fetchCodeSiteProjectKnowledge,
  submitCodeSiteProjectQuestionFeedback,
} from "../codesiteClient";
import { CodeSiteIcons } from "../icons";
import {
  EmptyLine,
  LoadingSkeleton,
  OperatorPane,
  Pill,
  Section,
  TagList,
} from "../ui";

const QUESTION_FILTERS = Object.freeze([
  { value: "open", label: "Unanswered" },
  { value: "answered", label: "Answered" },
]);

const EXPERTISE_REFRESH_EVENTS = new Set([
  "agent_question_asked",
  "agent_question_answered",
  "agent_question_feedback_submitted",
]);

const REFERENCE_FIELDS = Object.freeze([
  ["paths", "Paths"],
  ["symbols", "Symbols"],
  ["contracts", "Contracts"],
  ["runtimeSessionIds", "Runtime"],
  ["agentSessionIds", "Sessions"],
  ["workstreamIds", "Workstreams"],
  ["transactionIds", "Transactions"],
]);

const EMPTY_REFERENCES = Object.freeze({
  paths: "",
  symbols: "",
  contracts: "",
});

function textValue(value, fallback = "") {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

function parseReferenceInput(value) {
  return [
    ...new Set(
      String(value || "")
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function humanize(value, fallback = "Unknown") {
  const normalized = textValue(value, "").replaceAll("_", " ");
  return normalized
    ? normalized.replace(/^./, (character) => character.toUpperCase())
    : fallback;
}

function referencesFor(item) {
  const references = item?.references;
  if (
    !references ||
    typeof references !== "object" ||
    Array.isArray(references)
  )
    return [];
  return REFERENCE_FIELDS.map(([key, label]) => ({
    key,
    label,
    values: Array.isArray(references[key])
      ? [
          ...new Set(
            references[key]
              .filter((value) => typeof value === "string" && value.trim())
              .map((value) => value.trim()),
          ),
        ]
      : [],
  })).filter((group) => group.values.length);
}

function ReferenceTags({ item, label = "References" }) {
  const groups = referencesFor(item);
  if (!groups.length) return null;

  return (
    <div
      className="mt-2 grid min-w-0 gap-1.5 @min-[36rem]/panel:grid-cols-2"
      aria-label={label}
    >
      {groups.map((group) => (
        <div
          key={group.key}
          className="grid min-w-0 grid-cols-[5.5rem_minmax(0,1fr)] items-start gap-2 text-[10px]"
        >
          <span
            className="pt-0.5 font-semibold uppercase tracking-[0.06em]"
            style={{ color: "var(--text-muted)" }}
          >
            {group.label}
          </span>
          <TagList items={group.values} />
        </div>
      ))}
    </div>
  );
}

function FeedbackLabel({ value }) {
  return humanize(value, "Feedback");
}

function ExpertResults({ result }) {
  const experts = Array.isArray(result?.experts) ? result.experts : [];
  if (!experts.length)
    return (
      <EmptyLine>
        No matching expertise was found for these references.
      </EmptyLine>
    );

  return (
    <div className="min-w-0" data-testid="codesite-expertise-results">
      <div
        className="mb-2 flex flex-wrap items-center gap-1.5 text-[10px]"
        style={{ color: "var(--text-muted)" }}
      >
        <span>
          {experts.length} matching result{experts.length === 1 ? "" : "s"}
        </span>
        {result?.policyVersion ? <Pill>{result.policyVersion}</Pill> : null}
      </div>
      <ul className="min-w-0">
        {experts.map((expert, index) => {
          const key = textValue(expert?.agentSessionId, `expert-${index}`);
          const score = Number(expert?.score);
          const name =
            textValue(expert?.displayCallsign) ||
            textValue(expert?.agentProvider) ||
            "Unidentified peer";
          return (
            <li
              key={key}
              className="grid min-w-0 gap-2 border-t py-3 first:border-t-0 @min-[36rem]/panel:grid-cols-[minmax(0,1fr)_auto]"
              style={{ borderColor: "var(--border-subtle)" }}
              data-testid={`codesite-expertise-result-${key}`}
            >
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="min-w-0 break-words text-xs font-semibold">
                    {name}
                  </span>
                  {expert?.status ? (
                    <Pill tone={expert.status}>{humanize(expert.status)}</Pill>
                  ) : null}
                </div>
                <div
                  className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-0.5 text-[10px]"
                  style={{ color: "var(--text-muted)" }}
                >
                  {expert?.agentProvider ? (
                    <span>{textValue(expert.agentProvider)}</span>
                  ) : null}
                  {expert?.lastInteractionAt ? (
                    <span>
                      last matched {textValue(expert.lastInteractionAt)}
                    </span>
                  ) : null}
                </div>
                <div className="mt-2">
                  <TagList
                    items={expert?.evidence}
                    empty="No matching evidence"
                  />
                </div>
              </div>
              <Pill tone="active">
                {Number.isFinite(score) ? `${score} score` : "matched"}
              </Pill>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function QuestionRow({
  item,
  answerDraft,
  feedbackDraft,
  submitting,
  onAnswerDraft,
  onAnswer,
  onFeedbackDraft,
  onFeedback,
}) {
  const questionId = textValue(item?.id);
  const title = textValue(item?.title, "Untitled question");
  const summary = textValue(
    item?.summary,
    "No project-safe question summary was provided.",
  );
  const feedbackVerdicts = EXPERTISE_POLICY.feedback.verdicts;
  const selectedVerdict = textValue(feedbackDraft?.verdict);
  const needsCorrection = selectedVerdict === "needs_correction";

  return (
    <li
      className="min-w-0 border-t py-3 first:border-t-0"
      style={{ borderColor: "var(--border-subtle)" }}
      data-testid={`codesite-question-${questionId || "unknown"}`}
    >
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <h3 className="min-w-0 break-words text-xs font-semibold">
              {title}
            </h3>
            <Pill tone={item?.status || "idle"}>{humanize(item?.status)}</Pill>
            {item?.questionUrgency ? (
              <Pill tone={item.questionUrgency}>
                {humanize(item.questionUrgency)}
              </Pill>
            ) : null}
          </div>
          <p
            className="mt-1.5 whitespace-pre-wrap break-words text-[11px] leading-4"
            style={{ color: "var(--text-secondary)" }}
          >
            {summary}
          </p>
          <ReferenceTags item={item} label={`${title} references`} />
        </div>
        {item?.updatedAt ? (
          <span
            className="shrink-0 text-[10px]"
            style={{ color: "var(--text-muted)" }}
          >
            {textValue(item.updatedAt)}
          </span>
        ) : null}
      </div>

      {item?.status === "answered" ? (
        <div className="mt-3 grid gap-3 @min-[42rem]/panel:grid-cols-[minmax(0,1fr)_minmax(15rem,0.7fr)]">
          <div
            className="min-w-0 rounded border px-3 py-2"
            style={{
              borderColor: "var(--border-subtle)",
              background: "var(--bg-surface)",
            }}
          >
            <div
              className="text-[10px] font-semibold uppercase tracking-[0.06em]"
              style={{ color: "var(--text-muted)" }}
            >
              Answer
            </div>
            <p
              className="mt-1 whitespace-pre-wrap break-words text-[11px] leading-4"
              style={{ color: "var(--text-secondary)" }}
            >
              {textValue(
                item.answerText,
                "Answer text is not available in the project-safe record.",
              )}
            </p>
          </div>
          <div
            className="min-w-0 rounded border px-3 py-2"
            style={{
              borderColor: "var(--border-subtle)",
              background: "var(--bg-surface)",
            }}
          >
            <div
              className="text-[10px] font-semibold uppercase tracking-[0.06em]"
              style={{ color: "var(--text-muted)" }}
            >
              Answer feedback
            </div>
            <div
              className="mt-2 flex min-w-0 flex-wrap gap-1.5"
              role="group"
              aria-label={`Feedback for ${title}`}
            >
              {feedbackVerdicts.map((verdict) => (
                <button
                  key={verdict}
                  type="button"
                  aria-pressed={selectedVerdict === verdict}
                  disabled={submitting}
                  onClick={() => onFeedbackDraft({ verdict })}
                  className="min-h-9 rounded-md border px-2.5 text-[11px] font-semibold outline-none transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--attention-purple)] disabled:cursor-not-allowed disabled:opacity-50"
                  style={{
                    borderColor:
                      selectedVerdict === verdict
                        ? "var(--attention-purple)"
                        : "var(--border-subtle)",
                    background:
                      selectedVerdict === verdict
                        ? "color-mix(in srgb, var(--attention-purple) 14%, transparent)"
                        : "var(--bg-elevated)",
                    color: "var(--text-primary)",
                  }}
                >
                  <FeedbackLabel value={verdict} />
                </button>
              ))}
            </div>
            {needsCorrection ? (
              <textarea
                id={`codesite-feedback-correction-${questionId}`}
                value={feedbackDraft?.correction || ""}
                onChange={(event) =>
                  onFeedbackDraft({ correction: event.target.value })
                }
                placeholder="Describe the correction for the next answer."
                aria-label={`Correction for ${title}`}
                rows={3}
                className="mt-2 min-h-20 w-full resize-y rounded border px-2 py-1.5 text-[11px] outline-none focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-[var(--attention-purple)]"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-editor)",
                  color: "var(--text-primary)",
                }}
              />
            ) : null}
            <div className="mt-2 flex items-center justify-between gap-2">
              <span
                className="text-[10px]"
                style={{ color: "var(--text-muted)" }}
              >
                Feedback updates the derived expertise signal.
              </span>
              <button
                type="button"
                onClick={onFeedback}
                disabled={
                  submitting ||
                  !selectedVerdict ||
                  (needsCorrection && !textValue(feedbackDraft?.correction))
                }
                className="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border px-2.5 text-[11px] font-semibold outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--attention-purple)] disabled:cursor-not-allowed disabled:opacity-50"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-elevated)",
                  color: "var(--text-primary)",
                }}
                data-testid={`codesite-question-feedback-submit-${questionId}`}
              >
                <Send className="h-3 w-3" aria-hidden="true" />
                {submitting ? "Saving" : "Record"}
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="mt-3 grid gap-2 @min-[38rem]/panel:grid-cols-[minmax(0,1fr)_auto] @min-[38rem]/panel:items-end">
          <div className="min-w-0">
            <label
              htmlFor={`codesite-question-answer-${questionId}`}
              className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.06em]"
              style={{ color: "var(--text-muted)" }}
            >
              Response
            </label>
            <textarea
              id={`codesite-question-answer-${questionId}`}
              value={answerDraft || ""}
              onChange={(event) => onAnswerDraft(event.target.value)}
              placeholder="Share a project-safe answer with enough context to act on."
              rows={3}
              className="min-h-20 w-full resize-y rounded border px-2 py-1.5 text-[11px] outline-none focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-[var(--attention-purple)]"
              style={{
                borderColor: "var(--border-subtle)",
                background: "var(--bg-editor)",
                color: "var(--text-primary)",
              }}
              data-testid={`codesite-question-answer-${questionId}`}
            />
          </div>
          <button
            type="button"
            onClick={onAnswer}
            disabled={submitting || !textValue(answerDraft)}
            className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-semibold outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--attention-purple)] disabled:cursor-not-allowed disabled:opacity-50"
            style={{
              borderColor: "var(--accent-primary)",
              background:
                "color-mix(in srgb, var(--accent-primary) 14%, var(--bg-elevated))",
              color: "var(--text-primary)",
            }}
            data-testid={`codesite-question-answer-submit-${questionId}`}
          >
            <Send className="h-3.5 w-3.5" aria-hidden="true" />
            {submitting ? "Sending" : "Respond"}
          </button>
        </div>
      )}
    </li>
  );
}

export default function ExpertiseView({
  project,
  workspaceSlug,
  streamEvents = [],
}) {
  const projectId = textValue(project?.id);
  const [referenceDraft, setReferenceDraft] = useState(EMPTY_REFERENCES);
  const [expertQuery, setExpertQuery] = useState(null);
  const [expertSearch, setExpertSearch] = useState({
    status: "idle",
    result: null,
    error: null,
  });
  const [questionFilter, setQuestionFilter] = useState("open");
  const [questions, setQuestions] = useState({
    status: "idle",
    items: [],
    error: null,
    nextCursor: null,
  });
  const [answerDrafts, setAnswerDrafts] = useState({});
  const [feedbackDrafts, setFeedbackDrafts] = useState({});
  const [submittingId, setSubmittingId] = useState(null);
  const [notice, setNotice] = useState(null);
  const [actionError, setActionError] = useState(null);
  const questionRequest = useRef(0);
  const questionCursor = useRef(null);
  const handledStreamEvent = useRef(null);

  const loadQuestions = useCallback(async ({ append = false } = {}) => {
    const requestId = questionRequest.current + 1;
    questionRequest.current = requestId;
    const cursor = append ? questionCursor.current : null;
    if (append && !cursor) return;
    if (!workspaceSlug || !projectId) {
      questionCursor.current = null;
      setQuestions({ status: "ready", items: [], error: null, nextCursor: null });
      return;
    }
    setQuestions((current) => ({ ...current, status: "loading", error: null }));
    try {
      const items = await fetchCodeSiteProjectKnowledge(
        workspaceSlug,
        projectId,
        {
          kind: "agent_question",
          status: questionFilter,
          ...(cursor ? { cursor } : {}),
        },
      );
      if (questionRequest.current !== requestId) return;
      const nextItems = Array.isArray(items) ? items : [];
      const nextCursor =
        typeof items?.nextCursor === "string" && items.nextCursor.trim()
          ? items.nextCursor.trim()
          : null;
      questionCursor.current = nextCursor;
      setQuestions((current) => ({
        status: "ready",
        items: append ? [...current.items, ...nextItems] : nextItems,
        error: null,
        nextCursor,
      }));
    } catch (error) {
      if (questionRequest.current !== requestId) return;
      setQuestions((current) => ({
        status: "error",
        items: append ? current.items : [],
        error: error?.message || "questions_fetch_failed",
        nextCursor: append ? current.nextCursor : null,
      }));
    }
  }, [projectId, questionFilter, workspaceSlug]);

  useEffect(() => {
    questionRequest.current += 1;
    questionCursor.current = null;
    handledStreamEvent.current = null;
    setReferenceDraft(EMPTY_REFERENCES);
    setExpertQuery(null);
    setExpertSearch({ status: "idle", result: null, error: null });
    setAnswerDrafts({});
    setFeedbackDrafts({});
    setNotice(null);
    setActionError(null);
  }, [projectId]);

  useEffect(() => {
    questionCursor.current = null;
  }, [projectId, questionFilter]);

  useEffect(() => {
    void loadQuestions();
  }, [loadQuestions]);

  const runExpertSearch = useCallback(
    async (references, { silent = false } = {}) => {
      if (!workspaceSlug || !projectId) return null;
      if (!silent)
        setExpertSearch({ status: "loading", result: null, error: null });
      try {
        const result = await fetchCodeSiteProjectExperts(
          workspaceSlug,
          projectId,
          references,
        );
        setExpertSearch({ status: "ready", result, error: null });
        return result;
      } catch (error) {
        setExpertSearch((current) => ({
          status: "error",
          result: silent ? current.result : null,
          error: error?.message || "experts_fetch_failed",
        }));
        throw error;
      }
    },
    [projectId, workspaceSlug],
  );

  useEffect(() => {
    const event = Array.isArray(streamEvents) ? streamEvents[0] : null;
    const eventType = textValue(event?.eventType || event?.type);
    if (!EXPERTISE_REFRESH_EVENTS.has(eventType)) return;
    const eventKey = textValue(
      event?.id || event?.eventId,
      `${eventType}:${textValue(event?.createdAt)}`,
    );
    if (handledStreamEvent.current === eventKey) return;
    handledStreamEvent.current = eventKey;
    void loadQuestions();
    if (expertQuery)
      void runExpertSearch(expertQuery, { silent: true }).catch(() => {});
  }, [expertQuery, loadQuestions, runExpertSearch, streamEvents]);

  const handleExpertSearch = async (event) => {
    event.preventDefault();
    setNotice(null);
    setActionError(null);
    const references = {
      paths: parseReferenceInput(referenceDraft.paths),
      symbols: parseReferenceInput(referenceDraft.symbols),
      contracts: parseReferenceInput(referenceDraft.contracts),
    };
    if (
      !references.paths.length &&
      !references.symbols.length &&
      !references.contracts.length
    ) {
      setExpertSearch({
        status: "error",
        result: null,
        error: "Add a path, symbol, or contract to search.",
      });
      return;
    }
    setExpertQuery(references);
    try {
      await runExpertSearch(references);
    } catch (_) {
      // The request helper has already placed the safe error in view state.
    }
  };

  const updateAnswerDraft = (questionId, value) => {
    setAnswerDrafts((current) => ({ ...current, [questionId]: value }));
  };

  const updateFeedbackDraft = (questionId, patch) => {
    setFeedbackDrafts((current) => ({
      ...current,
      [questionId]: { ...(current[questionId] || {}), ...patch },
    }));
  };

  const answerQuestion = async (item) => {
    const questionId = textValue(item?.id);
    const answer = textValue(answerDrafts[questionId]);
    if (!questionId || !answer || submittingId) return;
    setSubmittingId(questionId);
    setNotice(null);
    setActionError(null);
    try {
      await answerCodeSiteProjectQuestion(
        workspaceSlug,
        projectId,
        questionId,
        answer,
      );
      setAnswerDrafts((current) => ({ ...current, [questionId]: "" }));
      setNotice(
        "Response recorded. The question list is refreshing from the project state.",
      );
      await loadQuestions();
    } catch (error) {
      setActionError(error?.message || "question_answer_failed");
    } finally {
      setSubmittingId(null);
    }
  };

  const submitFeedback = async (item) => {
    const questionId = textValue(item?.id);
    const draft = feedbackDrafts[questionId] || {};
    if (!questionId || !textValue(draft.verdict) || submittingId) return;
    setSubmittingId(questionId);
    setNotice(null);
    setActionError(null);
    try {
      await submitCodeSiteProjectQuestionFeedback(
        workspaceSlug,
        projectId,
        questionId,
        {
          verdict: draft.verdict,
          correction: draft.correction,
        },
      );
      setNotice(
        "Feedback recorded. Future expertise matches will use this signal.",
      );
      if (expertQuery) await runExpertSearch(expertQuery, { silent: true });
    } catch (error) {
      setActionError(error?.message || "question_feedback_failed");
    } finally {
      setSubmittingId(null);
    }
  };

  const questionItems = useMemo(
    () =>
      Array.isArray(questions.items)
        ? questions.items.filter(
            (item) => item && item.kind === "agent_question",
          )
        : [],
    [questions.items],
  );
  const loadMoreQuestions = questions.nextCursor ? (
    <button
      type="button"
      className="mt-3 min-h-9 rounded-md border px-2.5 text-[11px] font-semibold"
      onClick={() => void loadQuestions({ append: true })}
      disabled={questions.status === "loading"}
      style={{
        borderColor: "var(--border-subtle)",
        background: "var(--bg-elevated)",
        color: "var(--text-primary)",
      }}
      data-testid="codesite-question-load-more"
    >
      Load more questions
    </button>
  ) : null;

  return (
    <div
      className="grid min-w-0 content-start gap-3 p-3 @min-[28rem]/panel:p-4"
      data-testid="codesite-expertise-view"
    >
      <OperatorPane
        title="Find expertise"
        icon={CodeSiteIcons.agents}
        testId="codesite-expertise-search-pane"
        right={
          expertSearch.result?.policyVersion ? (
            <Pill>{expertSearch.result.policyVersion}</Pill>
          ) : null
        }
      >
        <p
          className="max-w-[72ch] text-[11px] leading-4"
          style={{ color: "var(--text-muted)" }}
        >
          Search project-derived expertise by the paths, symbols, and contracts
          your work touches. Results are ranked from governed project activity
          and feedback.
        </p>
        <form
          className="mt-3 grid min-w-0 gap-2 @min-[34rem]/panel:grid-cols-3"
          onSubmit={handleExpertSearch}
          data-testid="codesite-expertise-search"
        >
          {[
            ["paths", "Paths", "path/to/file"],
            ["symbols", "Symbols", "symbolName"],
            ["contracts", "Contracts", "contract.name"],
          ].map(([key, label, placeholder]) => (
            <div key={key} className="min-w-0">
              <label
                htmlFor={`codesite-expertise-${key}`}
                className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.06em]"
                style={{ color: "var(--text-muted)" }}
              >
                {label}
              </label>
              <input
                id={`codesite-expertise-${key}`}
                value={referenceDraft[key]}
                onChange={(event) =>
                  setReferenceDraft((current) => ({
                    ...current,
                    [key]: event.target.value,
                  }))
                }
                placeholder={placeholder}
                className="h-10 w-full min-w-0 rounded border px-2 text-[11px] outline-none focus:outline focus:outline-2 focus:outline-offset-1 focus:outline-[var(--attention-purple)]"
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-editor)",
                  color: "var(--text-primary)",
                }}
                data-testid={`codesite-expertise-input-${key}`}
              />
              <div
                className="mt-1 text-[10px]"
                style={{ color: "var(--text-muted)" }}
              >
                Separate multiple values with commas or new lines.
              </div>
            </div>
          ))}
          <div className="flex items-end @min-[34rem]/panel:col-span-3">
            <button
              type="submit"
              disabled={expertSearch.status === "loading" || !projectId}
              className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-semibold outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--attention-purple)] disabled:cursor-not-allowed disabled:opacity-50"
              style={{
                borderColor: "var(--accent-primary)",
                background:
                  "color-mix(in srgb, var(--accent-primary) 14%, var(--bg-elevated))",
                color: "var(--text-primary)",
              }}
              data-testid="codesite-expertise-search-submit"
            >
              <Search className="h-3.5 w-3.5" aria-hidden="true" />
              {expertSearch.status === "loading" ? "Searching" : "Find experts"}
            </button>
          </div>
        </form>
        {expertSearch.error ? (
          <div
            className="mt-3 rounded border px-3 py-2 text-xs"
            role="alert"
            style={{
              borderColor:
                "color-mix(in srgb, var(--accent-danger) 42%, var(--border-subtle))",
              color: "var(--text-secondary)",
            }}
          >
            {expertSearch.error}
          </div>
        ) : null}
        <div
          className="mt-3"
          aria-live="polite"
          aria-busy={expertSearch.status === "loading" ? "true" : "false"}
        >
          {expertSearch.status === "loading" ? (
            <LoadingSkeleton />
          ) : expertSearch.status === "ready" ? (
            <ExpertResults result={expertSearch.result} />
          ) : (
            <EmptyLine>
              Enter project references to find matching expertise.
            </EmptyLine>
          )}
        </div>
      </OperatorPane>

      <Section
        title="Project questions"
        icon={CodeSiteIcons.signals}
        right={
          <Pill tone={questionItems.length ? "holding" : "idle"}>
            {questionItems.length}
          </Pill>
        }
      >
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>
            Review project-visible questions and close the loop with a durable
            response or feedback signal.
          </p>
          <div
            className="flex min-w-0 gap-1"
            role="tablist"
            aria-label="Project question status"
          >
            {QUESTION_FILTERS.map((filter) => (
              <button
                key={filter.value}
                type="button"
                role="tab"
                aria-selected={questionFilter === filter.value}
                onClick={() => setQuestionFilter(filter.value)}
                className="min-h-9 rounded-md border px-2.5 text-[11px] font-semibold outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--attention-purple)]"
                style={{
                  borderColor:
                    questionFilter === filter.value
                      ? "var(--attention-purple)"
                      : "var(--border-subtle)",
                  background:
                    questionFilter === filter.value
                      ? "color-mix(in srgb, var(--attention-purple) 12%, transparent)"
                      : "var(--bg-elevated)",
                  color: "var(--text-primary)",
                }}
                data-testid={`codesite-question-filter-${filter.value}`}
              >
                {filter.label}
              </button>
            ))}
          </div>
        </div>
        {notice ? (
          <div
            className="mt-3 rounded border px-3 py-2 text-xs"
            role="status"
            style={{
              borderColor:
                "color-mix(in srgb, var(--accent-primary) 42%, var(--border-subtle))",
              color: "var(--text-secondary)",
            }}
          >
            {notice}
          </div>
        ) : null}
        {actionError ? (
          <div
            className="mt-3 rounded border px-3 py-2 text-xs"
            role="alert"
            style={{
              borderColor:
                "color-mix(in srgb, var(--accent-danger) 42%, var(--border-subtle))",
              color: "var(--text-secondary)",
            }}
          >
            {actionError}
          </div>
        ) : null}
        <div
          className="mt-3"
          aria-busy={questions.status === "loading" ? "true" : "false"}
        >
          {questions.status === "loading" ? (
            <LoadingSkeleton />
          ) : questions.error ? (
            <div
              className="rounded border px-3 py-3 text-xs"
              role="alert"
              style={{
                borderColor:
                  "color-mix(in srgb, var(--accent-danger) 42%, var(--border-subtle))",
                color: "var(--text-secondary)",
              }}
            >
              <div className="font-semibold">
                Project questions are unavailable
              </div>
              <div className="mt-1">{questions.error}</div>
              <button
                type="button"
                className="mt-2 min-h-9 rounded-md border px-2.5 text-[11px] font-semibold"
                onClick={() => void loadQuestions()}
                style={{
                  borderColor: "var(--border-subtle)",
                  background: "var(--bg-elevated)",
                  color: "var(--text-primary)",
                }}
                data-testid="codesite-question-retry"
              >
                Try again
              </button>
            </div>
          ) : questionItems.length ? (
            <>
              <ul className="min-w-0" data-testid="codesite-question-list">
                {questionItems.map((item, index) => {
                  const questionId = textValue(item.id, `question-${index}`);
                  const feedbackDraft = feedbackDrafts[questionId] || {};
                  return (
                    <QuestionRow
                      key={questionId}
                      item={item}
                      answerDraft={answerDrafts[questionId]}
                      feedbackDraft={feedbackDraft}
                      submitting={submittingId === questionId}
                      onAnswerDraft={(value) =>
                        updateAnswerDraft(questionId, value)
                      }
                      onAnswer={() => void answerQuestion(item)}
                      onFeedbackDraft={(patch) =>
                        updateFeedbackDraft(questionId, patch)
                      }
                      onFeedback={() => void submitFeedback(item)}
                    />
                  );
                })}
              </ul>
              {loadMoreQuestions}
            </>
          ) : (
            <>
              <EmptyLine>
                {questionFilter === "open"
                  ? "No unanswered project questions."
                  : "No answered project questions yet."}
              </EmptyLine>
              {loadMoreQuestions}
            </>
          )}
        </div>
      </Section>

      <div
        className="flex items-center gap-2 px-1 text-[10px]"
        style={{ color: "var(--text-muted)" }}
      >
        <CodeSiteIcons.lineage
          className="h-3 w-3 shrink-0"
          aria-hidden="true"
        />
        <span>
          Expert identity, evidence, ranking, and policy version come from the
          project control plane.
        </span>
      </div>
    </div>
  );
}
