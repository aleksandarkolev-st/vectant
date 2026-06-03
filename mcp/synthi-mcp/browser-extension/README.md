# Synthi Browser Bridge Extension

Local development extension for the general browser MCP adapter.

## Install

1. Open `chrome://extensions`.
2. Enable developer mode.
3. Load this directory as an unpacked extension.
4. Run `synthi_browser_attach` from the MCP client.
5. Configure the extension by sending a runtime message from the extension service worker console:

```js
chrome.runtime.sendMessage({
  type: "synthi:set-config",
  bridgeUrl: "http://127.0.0.1:9475",
  bridgeToken: "<token returned by synthi_browser_attach>"
});
```

Use `Alt+Shift+S` to toggle the visible teach overlay in the active tab.

The extension sends only explicit teach-mode events to the local bridge. The MCP broker still enforces exact-origin consent, teach-mode state, redaction, and input leases.
