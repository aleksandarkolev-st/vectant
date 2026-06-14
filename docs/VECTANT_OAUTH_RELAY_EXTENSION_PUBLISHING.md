# Vectant OAuth Relay Extension Publishing

The Vectant OAuth Relay extension improves terminal OAuth flows by capturing
short-lived localhost callback navigations and forwarding them to the active
workspace relay session.

Chrome no longer supports normal public one-click extension installs directly
from arbitrary websites. The production install flow must go through a Chrome
Web Store listing. The Vectant-hosted zip remains a beta/development fallback.

## Source And Build

Source:

```sh
extensions/vectant-oauth-relay
```

Build:

```sh
npm run build:oauth-relay-extension
```

Chrome Web Store upload artifact:

```sh
synthi/public/vectant/extensions/vectant-oauth-relay.zip
```

Compatibility aliases are also generated under:

```sh
synthi/public/extensions/synthi-oauth-relay.zip
```

## Listing Draft

Suggested name:

```text
Vectant OAuth Relay
```

Suggested short description:

```text
Relay terminal OAuth localhost callbacks into your active Vectant workspace.
```

Suggested permission justifications:

```text
webNavigation:
Used only to observe top-level localhost, 127.0.0.1, and ::1 navigation
attempts while a user has explicitly armed a Vectant relay session.

storage:
Stores one short-lived relay session and the last non-sensitive delivery status.
Callback URL query parameters are never stored.

host permission https://beta.vectant.dev/*:
Allows the extension to communicate only with Vectant beta pages and the
OAuth relay callback endpoint.
```

Suggested privacy statement:

```text
The extension does not inspect OAuth provider pages, inject content scripts into
third-party authentication sites, collect browsing history, or store callback
query parameters. It only forwards a matching loopback callback URL after the
user arms a specific Vectant workspace relay session.
```

## After Approval

Set the public install URL to the Chrome Web Store listing URL:

```sh
NEXT_PUBLIC_VECTANT_OAUTH_RELAY_EXTENSION_URL=https://chromewebstore.google.com/detail/<extension-slug>/<extension-id>
```

Then rebuild and redeploy the frontend. Until this env var is set, the UI uses:

```text
/vectant/extensions/vectant-oauth-relay.zip
```
