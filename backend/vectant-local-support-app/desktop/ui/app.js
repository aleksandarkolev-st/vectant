const shell = document.querySelector(".shell");
const tabs = Array.from(document.querySelectorAll("[data-tab]"));
const panels = Array.from(document.querySelectorAll("[data-panel]"));
const statusPill = document.querySelector("[data-status-pill]");
const workspaceSubtitle = document.querySelector("[data-workspace-subtitle]");
const bridgeStatus = document.querySelector("[data-bridge-status]");
const actionButtons = {
  pickWorkspace: document.querySelector('[data-action="pick-workspace"]'),
  pairSession: document.querySelector('[data-action="pair-session"]'),
  reviewFileApproval: document.querySelector('[data-action="review-file-approval"]'),
  reviewPortApproval: document.querySelector('[data-action="review-port-approval"]'),
  openPortPreview: document.querySelector('[data-action="open-port-preview"]'),
  revokePortApproval: document.querySelector('[data-action="revoke-port-approval"]'),
  pause: document.querySelector('[data-action="pause"]'),
  disconnect: document.querySelector('[data-action="disconnect"]'),
  revoke: document.querySelector('[data-action="revoke"]'),
  exportHistory: document.querySelector('[data-action="export-history"]'),
  deleteHistory: document.querySelector('[data-action="delete-history"]'),
  checkUpdate: document.querySelector('[data-action="check-update"]'),
  installUpdate: document.querySelector('[data-action="install-update"]'),
};
const workflowSummary = document.querySelector("[data-workflow-summary]");
const pairingForm = document.querySelector("[data-pairing-form]");
const pairingCode = document.querySelector("[data-pairing-code]");
const pairingConfirm = document.querySelector("[data-pairing-confirm]");
const pairingFingerprint = document.querySelector("[data-pairing-fingerprint]");
const pairingIdentity = document.querySelector("[data-pairing-identity]");
const pairingStatus = document.querySelector("[data-pairing-status]");
const pairingSubmit = document.querySelector("[data-pairing-submit]");
const updateStatus = document.querySelector("[data-update-status]");
const approvalPreview = document.querySelector(".approval-preview");
const approvalReviewDetail = document.querySelector("[data-approval-review-detail]");
const previewPortInput = document.querySelector("[data-preview-port]");
let renderedState = null;

const defaultApprovalCopy = "When Vectant requests a source file or log, this desktop screen must show classification, redactions, target path, actor, reason, expiry, and approval scope before content leaves the machine.";
const defaultPortsCopy = "Approved preview hosts are session scoped, loopback only, token bound, process identity bound, and revoked on disconnect or app quit.";
const defaultActivityCopy = "Allowed, denied, redacted, approved, revoked, paused, disconnected, exported, and deleted events are written to local product storage with scrubbed summaries.";

const fallbackState = {
  connected: false,
  paused: false,
  session: {
    account: "not paired",
    workspace: "No folder selected",
    device: "Stored locally, private key never shown to renderer",
    mode: "Balanced review before send",
  },
  approvals: [],
  ports: [],
  activity: [],
  updatePolicy: {
    available: false,
    enabled: false,
    pairingDisabled: true,
    updateRequired: false,
    pairingAllowed: false,
    currentVersion: "unknown",
    minimumVersion: "unknown",
    reason: "policy_unavailable",
    message: "Cloud policy is unavailable. New pairing is disabled until it can be checked.",
  },
};

function activateTab(name) {
  tabs.forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  panels.forEach((panel) => {
    const active = panel.dataset.panel === name;
    panel.classList.toggle("active", active);
    panel.hidden = !active;
  });
}

function setPaused(paused) {
  shell.dataset.paused = String(paused);
  statusPill.classList.toggle("paused", paused);
  if (shell.dataset.connected !== "true") statusPill.textContent = paused ? "Paused" : "Disconnected";
  if (actionButtons.pause) actionButtons.pause.textContent = paused ? "Resume" : "Pause";
}

function setText(selector, value) {
  const node = document.querySelector(selector);
  if (node) node.textContent = String(value || "");
}

function sanitizeText(value, fallback) {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 160 || /[\r\n\t]/.test(trimmed)) return fallback;
  return trimmed;
}

function renderState(rawState) {
  const state = normalizeState(rawState);
  renderedState = state;
  shell.dataset.connected = String(state.connected);
  setPaused(state.paused);
  statusPill.textContent = state.connected ? (state.paused ? "Paused" : "Connected") : "Disconnected";
  workspaceSubtitle.textContent = state.connected ? state.session.workspace : "No workspace selected";
  setText('[data-field="account"]', state.session.account);
  setText('[data-field="workspace"]', state.session.workspace);
  setText('[data-field="device"]', state.session.device);
  setText('[data-field="mode"]', state.session.mode);
  renderUpdatePolicy(state.updatePolicy);

  setText(
    '[data-field="approval-title"]',
    state.approvals.length ? `${state.approvals.length} approval request${state.approvals.length === 1 ? "" : "s"} pending` : "No live approval request",
  );
  setText(
    '[data-field="approval-tag"]',
    state.approvals.length ? "Review required" : "Zero bytes sent",
  );
  setText(
    '[data-field="approval-copy"]',
    state.approvals.length
      ? "Review each request locally. Content remains on this computer until the desktop approval flow releases a scrubbed payload."
      : defaultApprovalCopy,
  );

  setText(
    '[data-field="ports-title"]',
    state.ports.length ? `${state.ports.length} browser preview port${state.ports.length === 1 ? "" : "s"} approved` : "No ports approved",
  );
  setText(
    '[data-field="ports-copy"]',
    state.ports.length
      ? state.ports.map((port) => `127.0.0.1:${port.port} via ${port.previewHost}`).join(". ")
      : defaultPortsCopy,
  );

  setText(
    '[data-field="activity-title"]',
    state.activity.length ? `${state.activity.length} local event${state.activity.length === 1 ? "" : "s"} recorded` : "History is empty",
  );
  setText(
    '[data-field="activity-copy"]',
    state.activity.length
      ? state.activity.slice(0, 3).map((event) => event.summary).join(" ")
      : defaultActivityCopy,
  );

  renderWorkflow(state);
  renderPairing(state);
  renderApproval(state);
  actionButtons.pickWorkspace.disabled = false;
  actionButtons.pairSession.disabled = false;
  if (pairingSubmit) pairingSubmit.disabled = !state.updatePolicy.pairingAllowed;
  actionButtons.reviewFileApproval.disabled = !state.connected || state.approvals.length === 0;
  actionButtons.reviewPortApproval.disabled = !state.connected;
  actionButtons.openPortPreview.disabled = !state.connected || state.ports.length === 0;
  actionButtons.revokePortApproval.disabled = !state.connected || state.ports.length === 0;
  actionButtons.pause.disabled = !state.connected;
  actionButtons.disconnect.disabled = !state.connected;
  actionButtons.revoke.disabled = !state.connected;
  actionButtons.exportHistory.disabled = !state.historyControlsAvailable;
  actionButtons.deleteHistory.disabled = !state.historyControlsAvailable;
  actionButtons.checkUpdate.disabled = false;
  actionButtons.installUpdate.disabled = !state.availableUpdateVersion;
  actionButtons.installUpdate.textContent = state.availableUpdateVersion
    ? `Install ${state.availableUpdateVersion}`
    : "Install update";
}

function renderUpdatePolicy(policy) {
  const title = renderedState?.availableUpdateVersion
    ? `Signed update ${renderedState.availableUpdateVersion} available`
    : policy.updateRequired
    ? "Signed update required"
    : !policy.available
      ? "Policy check unavailable"
      : !policy.enabled || policy.pairingDisabled
        ? "Pairing disabled by policy"
        : `Version ${policy.currentVersion} is current`;
  const tag = policy.updateRequired
    ? "Blocked"
    : policy.pairingAllowed
      ? `Minimum ${policy.minimumVersion}`
      : "Fail closed";
  setText("[data-update-title]", title);
  setText("[data-update-tag]", tag);
  setText("[data-update-copy]", policy.message);
}

async function invokeStateAction(command, unavailableMessage, payload = {}) {
  try {
    const result = await invokeDesktop(command, payload);
    if (result) {
      bridgeStatus.textContent = "Desktop IPC connected. Renderer received sanitized state only.";
      renderState(result);
      return result;
    }
  } catch {
    bridgeStatus.textContent = "Desktop IPC denied this action. No local data was sent.";
    return null;
  }
  bridgeStatus.textContent = unavailableMessage;
  return null;
}

function renderWorkflow(state) {
  const hasWorkspace = state.session.workspace !== fallbackState.session.workspace;
  const hasApprovals = state.approvals.length > 0;
  const hasPorts = state.ports.length > 0;
  const hasActivity = state.activity.length > 0;

  updateWorkflowStep(
    "workspace",
    hasWorkspace ? "Ready" : "Pending",
    hasWorkspace
      ? `Workspace ${state.session.workspace} is selected for this support session only.`
      : "No folder is selected. This screen sends no workspace bytes while disconnected.",
    hasWorkspace,
  );
  updateWorkflowStep(
    "pairing",
    state.connected ? "Paired" : "Pending",
    state.connected
      ? `Sanitized IPC reports account ${state.session.account} and device ${state.session.device}.`
      : "Pairing requires a local confirmation before the desktop bridge can trust a support session.",
    state.connected,
  );
  updateWorkflowStep(
    "approvals",
    hasApprovals ? "Review" : "Armed",
    hasApprovals
      ? `${state.approvals.length} request${state.approvals.length === 1 ? "" : "s"} waiting for local review.`
      : "File and log requests wait for classification, redaction, reason, expiry, and explicit local approval.",
    hasApprovals,
  );
  updateWorkflowStep(
    "ports",
    hasPorts ? "Approved" : "Locked",
    hasPorts
      ? `${state.ports.length} preview port${state.ports.length === 1 ? "" : "s"} approved for browser-only loopback access.`
      : "No local ports are exposed. Preview does not grant AI or support page-reading access.",
    hasPorts,
  );
  updateWorkflowStep(
    "history",
    hasActivity ? "Recorded" : "Local",
    hasActivity
      ? `${state.activity.length} scrubbed local event${state.activity.length === 1 ? "" : "s"} available for export or delete.`
      : "History actions stay disabled until a paired daemon can confirm local storage access.",
    hasActivity,
  );

  if (workflowSummary) workflowSummary.textContent = state.connected ? "Live sanitized state" : "Safe disconnected state";
}

function renderPairing(state) {
  const pending = state.pairing?.status === "awaiting_confirmation";
  if (pairingForm) pairingForm.hidden = state.connected || pending;
  if (pairingConfirm) pairingConfirm.hidden = !pending;
  if (pairingFingerprint) pairingFingerprint.textContent = pending ? state.pairing.fingerprint : "";
  if (pairingIdentity) {
    pairingIdentity.textContent = pending
      ? "Account " + state.pairing.account + ". Organization " + state.pairing.org + "."
      : "";
  }
  setText("[data-pairing-title]", state.connected ? "Pairing complete" : pending ? "Confirm this fingerprint" : "Enter the browser code");
  setText(
    "[data-pairing-copy]",
    state.connected
      ? "This desktop app is paired to the support session shown in Overview."
      : pending
        ? "Compare this fingerprint with the browser. Confirm only when both values match."
        : "Start pairing in Vectant, then enter the 12-character one-time code here.",
  );
}

function renderApproval(state) {
  const review = state.approvals.find((item) => item.approvalId);
  if (approvalPreview) approvalPreview.hidden = Boolean(review);
  if (approvalReviewDetail) approvalReviewDetail.hidden = !review;
  if (!review) return;
  setText('[data-approval-field="target"]', review.target);
  setText('[data-approval-field="actor"]', review.actor);
  setText('[data-approval-field="classification"]', review.classification);
  setText('[data-approval-field="expires"]', review.expiresAt);
  setText('[data-approval-field="reason"]', "Reason: " + review.reason);
  setText('[data-approval-field="redactions"]', review.redactions.length
    ? review.redactions.length + " sensitive value(s) redacted locally."
    : "No sensitive values detected.");
  const preview = document.querySelector('[data-approval-field="preview"]');
  if (preview) preview.textContent = review.preview;
  approvalReviewDetail.dataset.approvalId = review.approvalId;
}

function updateWorkflowStep(step, status, copy, complete) {
  const item = document.querySelector(`[data-workflow-step="${step}"]`);
  const statusNode = item?.querySelector(".step-status");
  const copyNode = document.querySelector(`[data-workflow-copy="${step}"]`);
  if (statusNode) {
    statusNode.textContent = status;
    statusNode.classList.toggle("complete", complete);
  }
  if (copyNode) copyNode.textContent = copy;
}

function normalizeState(rawState) {
  const raw = rawState && typeof rawState === "object" ? rawState : {};
  const session = raw.session && typeof raw.session === "object" ? raw.session : {};
  const workspace = raw.workspace && typeof raw.workspace === "object" ? raw.workspace : {};
  const updatePolicy = normalizeUpdatePolicy(raw.update_policy);
  return {
    connected: raw.connected === true,
    paused: raw.paused === true || session.paused === true,
    session: {
      account: sanitizeText(session.account || session.account_id, fallbackState.session.account),
      workspace: sanitizeText(
        session.workspace || (workspace.selected === true ? workspace.display : "") || session.workspace_id,
        fallbackState.session.workspace,
      ),
      device: sanitizeText(session.device || session.device_fingerprint, fallbackState.session.device),
      mode: sanitizeText(session.mode, fallbackState.session.mode),
    },
    approvals: normalizeApprovals(raw.approvals),
    ports: Array.isArray(raw.ports)
      ? raw.ports.slice(0, 20).map((port) => ({
          port: Number(port.port) || 0,
          previewHost: sanitizeText(port.preview_host || port.previewHost, "preview host hidden"),
        }))
      : [],
    activity: Array.isArray(raw.activity)
      ? raw.activity.slice(0, 20).map((event) => ({
          summary: sanitizeText(event.summary, "Local event recorded."),
        }))
      : [],
    historyControlsAvailable: raw.history_controls_available === true || raw.connected === true,
    availableUpdateVersion: sanitizeText(raw.available_update_version, ""),
    updatePolicy,
    pairing: raw.pairing && typeof raw.pairing === "object"
      ? {
          status: sanitizeText(raw.pairing.status, ""),
          fingerprint: sanitizeText(raw.pairing.fingerprint, ""),
          account: sanitizeText(raw.pairing.account_id, "unknown account"),
          org: sanitizeText(raw.pairing.org_id, "unknown organization"),
        }
      : null,
  };
}

function normalizeUpdatePolicy(rawPolicy) {
  const raw = rawPolicy && typeof rawPolicy === "object" ? rawPolicy : {};
  const available = raw.available === true;
  const enabled = raw.enabled === true;
  const pairingDisabled = raw.pairing_disabled !== false;
  const updateRequired = raw.update_required === true;
  return {
    available,
    enabled,
    pairingDisabled,
    updateRequired,
    pairingAllowed: available && enabled && !pairingDisabled && !updateRequired,
    currentVersion: sanitizeText(raw.current_version, "unknown"),
    minimumVersion: sanitizeText(raw.minimum_version, "unknown"),
    reason: sanitizeText(raw.reason, "policy_unavailable"),
    message: sanitizeText(
      raw.user_visible_message,
      "Cloud policy is unavailable. New pairing is disabled until it can be checked.",
    ),
  };
}

function normalizeApprovals(rawApprovals) {
  if (Array.isArray(rawApprovals)) return rawApprovals.slice(0, 20);
  if (!rawApprovals || typeof rawApprovals !== "object") return [];
  if (Array.isArray(rawApprovals.items)) {
    return rawApprovals.items.slice(0, 20).map((item) => ({
      approvalId: sanitizeText(item.approval_id, ""),
      requestId: sanitizeText(item.request_id, ""),
      target: sanitizeText(item.target_display, "local item"),
      actor: sanitizeText(item.actor, "unknown actor"),
      classification: sanitizeText(item.classification, "unknown"),
      reason: sanitizeText(item.reason, "No reason supplied."),
      expiresAt: sanitizeText(item.expires_at, "unknown"),
      redactions: Array.isArray(item.redactions) ? item.redactions.slice(0, 100) : [],
      preview: typeof item.redacted_preview === "string"
        ? item.redacted_preview.slice(0, 262144)
        : "Preview unavailable.",
    }));
  }
  const pendingCount = Number(rawApprovals.pending_count);
  if (!Number.isSafeInteger(pendingCount) || pendingCount <= 0) return [];
  return Array.from({ length: Math.min(pendingCount, 20) }, () => ({}));
}

async function invokeDesktop(command, payload = {}) {
  const tauriInvoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
  if (!tauriInvoke) return null;
  return tauriInvoke("local_support_ipc", { command, payload });
}

async function refreshDesktopState() {
  try {
    const state = await invokeDesktop("session.status");
    if (state) {
      bridgeStatus.textContent = "Desktop IPC connected. Renderer received sanitized state only.";
      renderState(state);
      return;
    }
  } catch {
    bridgeStatus.textContent = "Desktop IPC denied or unavailable, showing safe disconnected state.";
  }
  renderState(fallbackState);
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
  tab.addEventListener("keydown", (event) => {
    const currentIndex = tabs.indexOf(tab);
    const targetIndex = event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : event.key === "ArrowRight"
          ? (currentIndex + 1) % tabs.length
          : event.key === "ArrowLeft"
            ? (currentIndex - 1 + tabs.length) % tabs.length
            : -1;
    if (targetIndex < 0) return;
    event.preventDefault();
    const target = tabs[targetIndex];
    activateTab(target.dataset.tab);
    target.focus();
  });
});

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    if (button.dataset.action === "pick-workspace") {
      await invokeStateAction("workspace.pick", "Workspace picker needs the paired desktop daemon. No local paths were exposed.");
    }
    if (button.dataset.action === "pair-session") {
      activateTab("workflow");
      pairingCode?.focus();
    }
    if (button.dataset.action === "confirm-pairing") {
      pairingStatus.textContent = "Confirming signed device proof...";
      const result = await invokeStateAction("pairing.confirm", "Pairing confirmation needs a claimed browser challenge.");
      pairingStatus.textContent = result?.connected ? "Pairing confirmed. Local Support is connected." : "Pairing was not confirmed.";
    }
    if (button.dataset.action === "review-file-approval") {
      await invokeStateAction("approval.file.review", "Approval review needs a live local request. Nothing was sent.");
    }
    if (button.dataset.action === "approve-file") {
      const approvalId = approvalReviewDetail?.dataset.approvalId || "";
      await invokeStateAction("approval.file.approve", "Approval is no longer pending.", { approval_id: approvalId });
    }
    if (button.dataset.action === "deny-file") {
      const approvalId = approvalReviewDetail?.dataset.approvalId || "";
      await invokeStateAction("approval.file.deny", "Approval is no longer pending.", { approval_id: approvalId });
    }
    if (button.dataset.action === "review-port-approval") {
      const port = Number(previewPortInput?.value);
      await invokeStateAction(
        "approval.port.review",
        "Enter a loopback port owned by a live local process. No preview was exposed.",
        { port },
      );
    }
    if (button.dataset.action === "open-port-preview") {
      const port = renderedState?.ports?.[0]?.port;
      await invokeStateAction("approval.port.open", "Approve a port before opening preview.", { port });
    }
    if (button.dataset.action === "revoke-port-approval") {
      const port = renderedState?.ports?.[0]?.port;
      await invokeStateAction("approval.port.revoke", "No approved port was available to revoke.", { port });
    }
    if (button.dataset.action === "pause") {
      const command = shell.dataset.paused === "true" ? "session.resume" : "session.pause";
      const result = await invokeDesktop(command);
      if (result) {
        renderState(result);
      } else {
        setPaused(shell.dataset.paused !== "true");
      }
    }
    if (button.dataset.action === "disconnect") {
      const result = await invokeDesktop("session.disconnect");
      if (result) renderState(result);
    }
    if (button.dataset.action === "revoke") {
      const result = await invokeDesktop("approval.revoke_session");
      if (result) renderState(result);
    }
    if (button.dataset.action === "export-history") {
      const result = await invokeDesktop("history.export");
      if (result) renderState(result);
    }
    if (button.dataset.action === "delete-history") {
      const result = await invokeDesktop("history.delete");
      if (result) renderState(result);
    }
    if (button.dataset.action === "check-update") {
      if (updateStatus) updateStatus.textContent = "Checking the signed update endpoint...";
      const result = await invokeStateAction("update.check", "Signed update check is unavailable in this build.");
      if (updateStatus) {
        updateStatus.textContent = result?.available_update_version
          ? `Signed update ${result.available_update_version} is ready to install.`
          : "No newer signed update is available.";
      }
    }
    if (button.dataset.action === "install-update") {
      if (updateStatus) updateStatus.textContent = "Waiting for native confirmation and signature verification...";
      await invokeStateAction("update.install", "The signed update was not installed.");
    }
  });
});

pairingForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = pairingCode.value.trim().toUpperCase();
  pairingStatus.textContent = "Checking one-time code...";
  const result = await invokeStateAction(
    "pairing.start",
    "Pairing needs a live browser challenge. No session was trusted.",
    { code },
  );
  if (result?.pairing?.status === "awaiting_confirmation") {
    pairingCode.value = "";
    pairingStatus.textContent = "Code accepted. Compare the fingerprint before confirming.";
  } else {
    pairingStatus.textContent = "Code was not accepted. Nothing was paired.";
  }
});

refreshDesktopState();
