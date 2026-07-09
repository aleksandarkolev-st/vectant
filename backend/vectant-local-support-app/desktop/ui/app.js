const shell = document.querySelector(".shell");
const tabs = Array.from(document.querySelectorAll("[data-tab]"));
const panels = Array.from(document.querySelectorAll("[data-panel]"));
const statusPill = document.querySelector("[data-status-pill]");

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
  statusPill.textContent = paused ? "Paused" : "Disconnected";
  statusPill.classList.toggle("paused", paused);
  const pauseButton = document.querySelector('[data-action="pause"]');
  if (pauseButton) {
    pauseButton.textContent = paused ? "Resume" : "Pause";
  }
}

tabs.forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => {
    if (button.dataset.action === "pause") {
      setPaused(shell.dataset.paused !== "true");
    }
  });
});
