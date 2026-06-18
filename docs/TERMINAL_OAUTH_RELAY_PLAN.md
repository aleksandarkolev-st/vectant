# Terminal OAuth Relay Plan

## Decision

Synthi should not center terminal OAuth around the noVNC workspace browser.

The workspace browser is protocol-correct because `localhost` means the
workspace pod, but it is a poor default developer experience. It is slower, it
does not have the user's normal browser cookies or password manager state, and
it is more likely to hit provider bot or device-verification checks.

The default path should be local browser plus paste callback. The power-user
upgrade should be a Synthi browser extension that auto-captures failed
localhost callback navigations. The workspace browser remains the fallback.

## Goals

- Preserve each CLI's exact loopback OAuth assumptions.
- Avoid rewriting `redirect_uri`.
- Avoid inspecting third-party auth provider pages.
- Avoid storing OAuth callback URLs.
- Avoid logging callback query strings.
- Support unknown CLIs, not only known tools.
- Keep callback relay sessions short-lived and workspace-scoped.

## Flow

1. User clicks an OAuth URL printed by a terminal command.
2. Synthi routes it to `/auth/loopback`.
3. `/auth/loopback` creates a short-lived relay session through
   `/api/oauth-relay/session`.
4. The user signs in in their local browser.
5. The provider redirects to `http://localhost:<port>/...`.
6. If the localhost redirect fails locally, the user pastes that failed callback
   URL into `/auth/loopback`.
7. `/api/oauth-relay/callback` validates the relay session, workspace access,
   runtime scope, expected loopback host, expected port, and expected path.
8. Synthi forwards the exact callback URL into the workspace runtime.
9. The CLI receives the callback and completes auth.

## Extension Flow

The extension must watch callback navigations, not callback pages.

A failed localhost redirect may never create a document, so content scripts on
`localhost` are the wrong layer. The extension service worker should use
`webNavigation.onBeforeNavigate` and `webNavigation.onErrorOccurred`, inspect
`details.url`, accept only top-level loopback navigations for the currently
armed relay session, and submit the exact failed callback URL to
`/api/oauth-relay/callback`.

The extension must not inject into auth provider pages and must not inspect the
contents of third-party auth pages.

## Relay Session Model

Relay sessions are signed, short-lived tokens. They include only routing and
validation metadata:

```ts
type TerminalOAuthRelaySession = {
  sid: string;
  workspaceId: string;
  workspaceSlug: string;
  runtimeScope: string;
  runtimeKind: "private" | "collab";
  terminalId?: string;
  actorUserIdHash: string;
  collabSessionId?: string;
  expectedCallback?: {
    host?: "localhost" | "127.0.0.1" | "::1";
    port?: number;
    pathPrefix?: string;
  };
  providerOrigin?: string;
  createdAt: number;
  expiresAt: number;
};
```

Rules:

- Default TTL is 5 minutes.
- A successful callback consumes the session.
- Session ids are random and unguessable.
- Callback URLs are not stored.
- Callback query params are not logged.

## Public API

The draft originally used `/collab/oauth-relay/*`. The implemented public API
uses `/api/oauth-relay/*` so the frontend server can enforce NextAuth workspace
membership before forwarding anything into a runtime.

### Create Relay Session

```text
POST /api/oauth-relay/session
```

Request:

```json
{
  "workspaceSlug": "oecr3qez",
  "runtimeScope": "ws-1586gbb-user-1ckw582",
  "runtimeKind": "private",
  "terminalId": "terminal-main",
  "authUrl": "https://provider.example/oauth/authorize?...",
  "expectedCallback": {
    "host": "localhost",
    "port": 1455,
    "pathPrefix": "/auth/callback"
  }
}
```

Response:

```json
{
  "sessionId": "relay_...",
  "expiresAt": "2026-06-14T14:05:00.000Z",
  "expectedCallback": {
    "host": "localhost",
    "port": 1455,
    "pathPrefix": "/auth/callback"
  }
}
```

### Submit Callback

```text
POST /api/oauth-relay/callback
```

Request:

```json
{
  "sessionId": "relay_...",
  "workspaceSlug": "oecr3qez",
  "callbackUrl": "http://localhost:1455/auth/callback?code=...&state=..."
}
```

Response:

```json
{
  "ok": true,
  "statusCode": 200
}
```

Validation:

- User must still have access to the workspace.
- Relay session must be valid and unexpired.
- Runtime scope must match the signed relay session.
- Callback URL must be loopback-only.
- Callback host, port, and path prefix must match when known.
- Query params must not be logged.

## Fallback

`/auth/loopback` keeps an "Open in workspace browser" fallback. This uses the
runtime browser / noVNC path for cases where paste-based relay is impossible,
but it is no longer the default terminal OAuth path.

