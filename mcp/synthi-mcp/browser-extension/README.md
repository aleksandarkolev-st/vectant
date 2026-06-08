# Synthi Browser Bridge Extension

Advanced local development extension for the browser MCP adapter.

This is not the normal product path. Normal users teach workflows inside the
Synthi cloud IDE through:

```text
agent client -> Synthi MCP -> broker -> Synthi-hosted browser/runtime
```

They should not need local Chrome, a CDP port, this extension, or access to
their own desktop browser. Use this extension only when collaborating on the
local CDP/dev harness or debugging page-origin teach events outside the hosted
runtime.

## Install

1. Open `chrome://extensions`.
2. Enable developer mode.
3. Load this directory as an unpacked extension.
4. Run the low-level local-dev `synthi_browser_attach` tool from the MCP client.
5. Configure the extension by sending a runtime message from the extension service worker console:

```js
chrome.runtime.sendMessage({
  type: "synthi:set-config",
  bridgeUrl: "<bridge.url returned by synthi_browser_attach>",
  bridgeToken: "<token returned by synthi_browser_attach>"
});
```

Use `Alt+Shift+S` to toggle the visible teach overlay in the active tab.

The extension sends only explicit teach-mode events to the local bridge. The MCP broker still enforces exact-origin consent, teach-mode state, redaction, and input leases.
