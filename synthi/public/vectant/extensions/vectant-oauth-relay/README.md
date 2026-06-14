# Vectant OAuth Relay Extension

This optional extension improves terminal OAuth flows for Vectant workspaces.

The default product flow still works without the extension: open the auth link in
your normal browser, copy the redirected `localhost` callback URL, and paste it
into Vectant.

The extension removes that paste step. When a Vectant relay session is armed, the
extension watches browser navigation attempts for top-level loopback URLs:

- `http://localhost:<port>/...`
- `http://127.0.0.1:<port>/...`
- `http://[::1]:<port>/...`

When the navigation matches the active relay session, the extension sends the
full callback URL to `/api/oauth-relay/callback`. Vectant validates workspace
access and forwards the exact URL into the workspace runtime.

## Security Model

- No content scripts are injected into OAuth provider pages.
- The extension does not inspect provider page DOM.
- Callback URLs are not stored.
- The extension only stores short-lived relay metadata and the last submit
  result, without callback query params.
- Capture must be armed from a Vectant page for a specific workspace/runtime.
- The extension only communicates with `https://beta.vectant.dev/*`.

## Build

From the repository root:

```sh
npm run build:oauth-relay-extension
```

The build writes:

- `synthi/public/vectant/extensions/vectant-oauth-relay/` for unpacked installs
- `synthi/public/vectant/extensions/vectant-oauth-relay.zip` as the stable Vectant download
- `synthi/public/vectant/extensions/vectant-oauth-relay-v<version>.zip` as the versioned artifact
- legacy aliases under `synthi/public/extensions/synthi-oauth-relay*` for older beta links

## Development Install

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click "Load unpacked".
4. Select this `extensions/vectant-oauth-relay` directory, or select the built
   `synthi/public/vectant/extensions/vectant-oauth-relay` directory.

## Beta Install From Zip

1. Download `https://beta.vectant.dev/vectant/extensions/vectant-oauth-relay.zip`.
2. Unzip it locally.
3. Open `chrome://extensions`.
4. Enable Developer mode.
5. Click "Load unpacked" and select the unzipped directory.

Firefox support should use the same WebExtensions concepts, but the current
manifest targets Chromium MV3.
