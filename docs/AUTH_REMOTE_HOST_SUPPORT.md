# Remote Host Authentication Support

This document describes auth capabilities implemented in the Synthi remote-host extension flow.

## Supported APIs

- `vscode.authentication.getSession(providerId, scopes, options)`
  - Interactive (`createIfNone` / `forceNewSession`) requests are surfaced to frontend.
  - GitHub interactive requests trigger active device-flow retrieval in manager.
- `window.showInformationMessage(...)`
  - Forwarded to frontend as `extensionMessage`.
  - Also surfaced as generic `authPrompt` with action titles.
- `window.showQuickPick(...)`
  - Forwarded to frontend; manager now does best-effort fallback selection.
- `window.showInputBox(...)`
  - Forwarded to frontend; manager now returns default value when available.
- `vscode.env.openExternal(uri)`
  - Forwarded and opened in browser.
- `vscode.window.registerUriHandler(...)`
  - Wrapped in preload and tracked.
  - Callback URLs can be delivered via `deliverUriCallback`.
- Secret storage (`$getPassword/$setPassword/$deletePassword`)
  - Persisted in manager-backed JSON store.

## Auth UX Events (frontend channel)

- `authSessionRequest`
- `authPrompt`
- `authDeviceCode`
- `authDeviceCodeMissing`
- `openExternal`
- `clipboardWrite`
- `uriHandlerRegistered`
- `uriCallbackResult`

## Generic Auth UI Expectations

The frontend should display a single auth UX that can show:

- message
- code (if available)
- actions (Open / Copy / Retry / Cancel)

Current implementation maps action titles heuristically (`open`, `copy`, `retry`, `sign in`) to browser/copy actions.

## Test Matrix

- GitHub device flow
  - Expect `authDeviceCode` and open-external URL
  - Expect copy support and visible code toast/log
- Microsoft / Azure auth
  - Expect redirect URI callback handling through `registerUriHandler` + `deliverUriCallback`
- GitLab (or other providers)
  - Expect auth prompts and open/copy/retry UX through generic prompt channel

## Operational Notes

- If provider emits no code and no callback URL, manager emits `authDeviceCodeMissing` to avoid silent failures.
- Duplicate auth-session prompts are deduped at preload-bridge level.
