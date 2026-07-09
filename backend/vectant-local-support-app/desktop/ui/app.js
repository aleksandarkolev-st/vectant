const shell = document.querySelector(".shell");
const tabs = Array.from(document.querySelectorAll("[data-tab]"));
const panels = Array.from(document.querySelectorAll("[data-panel]"));
const statusPill = document.querySelector("[data-status-pill]");
const workspaceSubtitle = document.querySelector("[data-workspace-subtitle]");
const bridgeStatus = document.querySelector("[data-bridge-status]");
const actionButtons = {
  pause: document.querySelector('[data-action="pause"]'),
  disconnect: document.querySelector('[data-action="disconnect"]'),
  revoke: document.querySelector('[data-action="revoke"]'),
};

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
};

function activateTab(name) {
  tabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === name);
  });
  panels.forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === name);
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
  shell.dataset.connected = String(state.connected);
  setPaused(state.paused);
  statusPill.textContent = state.connected ? (state.paused ? "Paused" : "Connected") : "Disconnected";
  workspaceSubtitle.textContent = state.connected ? state.session.workspace : "No workspace selected";
  setText('[data-field="account"]', state.session.account);
  setText('[data-field="workspace"]', state.session.workspace);
  setText('[data-field="device"]', state.session.device);
  setText('[data-field="mode"]', state.session.mode);

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

  actionButtons.disconnect.disabled = !state.connected;
  actionButtons.revoke.disabled = !state.connected;
}

function normalizeState(rawState) {
  const raw = rawState && typeof rawState === "object" ? rawState : {};
  const session = raw.session && typeof raw.session === "object" ? raw.session : {};
  return {
    connected: raw.connected === true,
    paused: raw.paused === true || session.paused === true,
    session: {
      account: sanitizeText(session.account || session.account_id, fallbackState.session.account),
      workspace: sanitizeText(session.workspace || session.workspace_id, fallbackState.session.workspace),
      device: sanitizeText(session.device || session.device_fingerprint, fallbackState.session.device),
      mode: sanitizeText(session.mode, fallbackState.session.mode),
    },
    approvals: Array.isArray(raw.approvals) ? raw.approvals.slice(0, 20) : [],
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
  };
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
});

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", async () => {
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
  });
});

refreshDesktopState();
