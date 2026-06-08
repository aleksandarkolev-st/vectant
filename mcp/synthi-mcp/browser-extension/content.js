let teachActive = false;
let dragStart = null;
let lastUrl = location.href;

const badge = document.createElement("button");
badge.id = "synthi-teach-badge";
badge.type = "button";
badge.textContent = "Teach";
badge.style.cssText = [
  "position:fixed",
  "right:16px",
  "bottom:16px",
  "z-index:2147483647",
  "height:34px",
  "padding:0 12px",
  "border:1px solid rgba(16,24,40,.22)",
  "border-radius:7px",
  "background:#0f172a",
  "color:#fff",
  "font:600 13px/34px system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif",
  "box-shadow:0 8px 24px rgba(15,23,42,.28)",
  "cursor:pointer",
  "opacity:.88"
].join(";");

const rect = document.createElement("div");
rect.id = "synthi-selection-rect";
rect.style.cssText = [
  "position:fixed",
  "z-index:2147483646",
  "pointer-events:none",
  "border:2px solid #38bdf8",
  "background:rgba(56,189,248,.14)",
  "display:none"
].join(";");

document.documentElement.appendChild(badge);
document.documentElement.appendChild(rect);
badge.addEventListener("click", () => setTeach(!teachActive));

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "synthi:toggleTeach") setTeach(!teachActive);
});

document.addEventListener("mousedown", (event) => {
  if (!teachActive) return;
  if (event.target === badge) return;
  dragStart = { x: event.clientX, y: event.clientY };
  updateRect(dragStart.x, dragStart.y, dragStart.x, dragStart.y);
}, true);

document.addEventListener("mousemove", (event) => {
  if (!teachActive || !dragStart) return;
  updateRect(dragStart.x, dragStart.y, event.clientX, event.clientY);
}, true);

document.addEventListener("mouseup", (event) => {
  if (!teachActive || !dragStart) return;
  const start = dragStart;
  dragStart = null;
  rect.style.display = "none";
  const box = boxFromPoints(start.x, start.y, event.clientX, event.clientY);
  if (box.w < 4 || box.h < 4) return;
  const el = document.elementFromPoint(box.x + box.w / 2, box.y + box.h / 2);
  sendBridgeEvent("selection", {
    url: location.href,
    origin: location.origin,
    bbox: box,
    element: elementMetadata(el),
  });
}, true);

document.addEventListener("click", (event) => {
  if (!teachActive) return;
  if (event.target === badge) return;
  sendBridgeEvent("human_action", {
    url: location.href,
    origin: location.origin,
    action: "click",
    element: elementMetadata(event.target),
  });
}, true);

document.addEventListener("change", (event) => {
  if (!teachActive) return;
  const target = event.target;
  if (!target || !("value" in target)) return;
  sendBridgeEvent("human_action", {
    url: location.href,
    origin: location.origin,
    action: "fill",
    value: String(target.value || ""),
    field_name: target.getAttribute?.("name") || target.getAttribute?.("type") || "",
    element: elementMetadata(target),
  });
}, true);

setInterval(() => {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  sendBridgeEvent("origin_change", {
    url: location.href,
    origin: location.origin,
  });
}, 500);

function setTeach(active) {
  teachActive = active;
  badge.textContent = active ? "Teaching" : "Teach";
  badge.style.background = active ? "#0369a1" : "#0f172a";
  badge.style.opacity = active ? "1" : ".88";
}

function sendBridgeEvent(type, payload) {
  chrome.runtime.sendMessage({
    type: "synthi:bridge-event",
    event: {
      page_origin: location.origin,
      type,
      payload,
    },
  }).catch(() => undefined);
}

function updateRect(x1, y1, x2, y2) {
  const box = boxFromPoints(x1, y1, x2, y2);
  rect.style.display = "block";
  rect.style.left = `${box.x}px`;
  rect.style.top = `${box.y}px`;
  rect.style.width = `${box.w}px`;
  rect.style.height = `${box.h}px`;
}

function boxFromPoints(x1, y1, x2, y2) {
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  return {
    x,
    y,
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

function elementMetadata(node) {
  if (!(node instanceof Element)) return {};
  const id = node.id || "";
  const role = node.getAttribute("role") || inferredRole(node);
  const label = labelFor(node);
  const name = node.getAttribute("aria-label") || label || textOf(node);
  return {
    tag: node.tagName.toLowerCase(),
    role,
    name,
    label,
    placeholder: node.getAttribute("placeholder") || "",
    test_id: node.getAttribute("data-testid") || node.getAttribute("data-test") || "",
    text: textOf(node),
    id,
    class_name: typeof node.className === "string" ? node.className : "",
    css: cssSelector(node),
    xpath: xpathFor(node),
    type: node.getAttribute("type") || "",
  };
}

function inferredRole(node) {
  const tag = node.tagName.toLowerCase();
  if (tag === "button") return "button";
  if (tag === "a" && node.hasAttribute("href")) return "link";
  if (tag === "input" || tag === "textarea") return "textbox";
  if (tag === "select") return "combobox";
  return "";
}

function labelFor(node) {
  if (!(node instanceof HTMLElement)) return "";
  if (node.id) {
    const label = document.querySelector(`label[for="${CSS.escape(node.id)}"]`);
    if (label?.textContent) return label.textContent.trim();
  }
  const parent = node.closest("label");
  return parent?.textContent?.trim() || "";
}

function textOf(node) {
  return (node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120);
}

function cssSelector(node) {
  if (!(node instanceof Element)) return "";
  if (node.id) return `#${CSS.escape(node.id)}`;
  const testId = node.getAttribute("data-testid") || node.getAttribute("data-test");
  if (testId) return `[data-testid="${cssAttr(testId)}"]`;
  const tag = node.tagName.toLowerCase();
  const cls = typeof node.className === "string" ? node.className.split(/\s+/).filter(Boolean)[0] : "";
  return cls ? `${tag}.${CSS.escape(cls)}` : tag;
}

function cssAttr(value) {
  return String(value).replace(/"/g, '\\"');
}

function xpathFor(node) {
  if (!(node instanceof Element)) return "";
  const parts = [];
  let current = node;
  while (current && current.nodeType === Node.ELEMENT_NODE) {
    const tag = current.tagName.toLowerCase();
    const siblings = current.parentElement
      ? Array.from(current.parentElement.children).filter((child) => child.tagName === current.tagName)
      : [];
    const index = siblings.indexOf(current) + 1;
    parts.unshift(`${tag}${siblings.length > 1 ? `[${index}]` : ""}`);
    current = current.parentElement;
  }
  return `/${parts.join("/")}`;
}
