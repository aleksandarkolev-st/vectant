const DEFAULT_BRIDGE_URL = "http://127.0.0.1:9475";

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["bridgeUrl"], (current) => {
    if (!current.bridgeUrl) {
      chrome.storage.local.set({ bridgeUrl: DEFAULT_BRIDGE_URL });
    }
  });
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== "toggle-teach") return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  chrome.tabs.sendMessage(tab.id, { type: "synthi:toggleTeach" }).catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "synthi:bridge-event") {
    sendBridgeEvent(message.event, sender)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (message?.type === "synthi:set-config") {
    chrome.storage.local.set({
      bridgeUrl: message.bridgeUrl || DEFAULT_BRIDGE_URL,
      bridgeToken: message.bridgeToken || "",
    }, () => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

async function sendBridgeEvent(event, sender) {
  const config = await chrome.storage.local.get(["bridgeUrl", "bridgeToken"]);
  const bridgeUrl = config.bridgeUrl || DEFAULT_BRIDGE_URL;
  const bridgeToken = config.bridgeToken || "";
  if (!bridgeToken) return { ok: false, error: "bridge_token_missing" };
  const pageOrigin = event?.page_origin || pageOriginFromSender(sender);
  const response = await fetch(`${bridgeUrl.replace(/\/$/, "")}/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bridge_token: bridgeToken,
      page_origin: pageOrigin,
      type: event?.type,
      payload: event?.payload || {},
    }),
  });
  const body = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, body };
}

function pageOriginFromSender(sender) {
  try {
    return new URL(sender?.url || "").origin;
  } catch {
    return "";
  }
}
