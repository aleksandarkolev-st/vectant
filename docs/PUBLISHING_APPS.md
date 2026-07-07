# Publishing an app to a Vectant workspace

This guide shows you how to package an app so it can be installed and run inside a
Vectant workspace. You do that by adding one file to your project:
**`vectant.programs.json`** — a small recipe that tells Vectant how to install and
launch your app.

If you already have a `devcontainer.json`, skip to
[Already have a devcontainer.json?](#already-have-a-devcontainerjson).

---

## Quickstart

1. Add a `vectant.programs.json` at the root of your workspace:

   ```json
   {
     "packageId": "my-web-app",
     "version": "1.0.0",
     "displayName": "My Web App",
     "runtimeType": "web",
     "install": ["npm ci"],
     "launch": "npm run dev",
     "ports": [3000],
     "permissions": ["program.launch", "network.outbound"]
   }
   ```

2. Open the **Programs** panel in your workspace and go to the **Store** tab.
3. Click **Submit for review**.
4. Track status under the **My Apps** tab. Once it's approved, it appears in the
   store for others to install.

That's it. The three required fields are `packageId`, `version`, and `launch` —
everything else has sensible defaults.

> **Tip:** In the publish page you can click **Generate manifest with AI** to draft a
> `vectant.programs.json` from your project's files, then edit it before saving. If you
> use an AI coding assistant in your workspace terminal, it can also describe and check
> the format for you (the `vectant-programs` tools: `describe_manifest_schema`,
> `validate_manifest`).

---

## Field reference

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `packageId` | string | **yes** | Unique id. Lowercase, starts with a letter or number, up to 64 chars, characters `a–z 0–9 . _ -`. No `..`. |
| `version` | string | **yes** | Your app's version, e.g. `"1.0.0"`. |
| `launch` | string | **yes** | The command that starts your app. For `container`/`gui` apps it must reference your image. |
| `runtimeType` | enum | no | One of `web`, `cli`, `tui`, `background`, `gui`, `container`. Defaults to `cli`. See [Runtime types](#runtime-types). |
| `displayName` | string | no | Friendly name shown in the store. Defaults to `packageId`. |
| `description` | string | no | Short summary shown in the store. |
| `workingDir` | string | no | Directory (relative to the workspace root) to run in. `""` means the root. Absolute paths and `..` are not allowed. |
| `install` | string or string[] | no | Setup commands run once before the first launch. |
| `env` | object | no | Environment variables, e.g. `{ "NODE_ENV": "production" }`. Values are treated as strings. |
| `ports` | number[] | no | Ports your app listens on (1–65535). |
| `permissions` | enum[] | no | Capabilities your app needs. See [Permissions](#permissions). `program.launch` is always included. |
| `surfaces` | enum[] | no | Which tabs to show: `app`, `logs`, `terminal`, `ports`, `health`, `settings`. Chosen automatically when omitted. |
| `health` | object | no | Optional health check: `{ "type": "...", "target": "...", "intervalMs": 0 }`. |
| `webGui` | boolean | no | `container` apps only: your published web port is a desktop/GUI stream, shown as a full interactive panel. |

---

## Runtime types

Pick the `runtimeType` that matches how your app runs:

| Type | Use it for | Shows up as |
|------|------------|-------------|
| `web` | A web app / dev server that listens on a port. | An embedded web panel. |
| `cli` | A command-line tool. | Runs in the integrated terminal. |
| `tui` | A full-screen terminal app (e.g. a text UI). | Runs in the integrated terminal. |
| `background` | A long-running process with no UI. | Logs only. |
| `gui` | A graphical desktop app streamed to the browser. | A full interactive panel. |
| `container` | An app shipped as a container image. | Depends on what it exposes (web panel, GUI, or logs). |

---

## Permissions

Request the **least** your app needs — apps that ask for more are reviewed more
closely and are less likely to be installed.

| Scope | Grants |
|-------|--------|
| `program.launch` | Start the app. Always implied. |
| `workspace.files.read` | Read the workspace files. |
| `workspace.files.write` | Write to the workspace files. |
| `network.outbound` | Make outbound network requests. |
| `ports.expose` | Expose the ports you declared. |

---

## Rules

These keep installed apps safe to run in someone else's workspace. Commands that do
any of the following are **not accepted**:

- Mounting the host: an absolute-path `-v`/`--volume` source, `docker.sock`, or
  `/var/run/docker`. The workspace mount `-v "$PWD":/workspace` **is** fine.
- Privileged/host-access flags: `--privileged`, `--cap-add`, `--security-opt`,
  `--device`.

Keep your `launch`/`install` commands to what the app itself needs.

---

## Examples

### Web (dev server)

```json
{
  "packageId": "my-web-app",
  "version": "1.0.0",
  "displayName": "My Web App",
  "runtimeType": "web",
  "install": ["npm ci"],
  "launch": "npm run dev",
  "ports": [3000],
  "permissions": ["program.launch", "network.outbound"]
}
```

### CLI tool

```json
{
  "packageId": "my-cli",
  "version": "1.0.0",
  "displayName": "My CLI",
  "runtimeType": "cli",
  "install": ["pipx install my-cli"],
  "launch": "my-cli --help",
  "permissions": ["program.launch"]
}
```

### TUI (terminal UI)

```json
{
  "packageId": "my-tui",
  "version": "1.0.0",
  "displayName": "My TUI",
  "runtimeType": "tui",
  "launch": "my-tui",
  "permissions": ["program.launch"]
}
```

### Background worker

```json
{
  "packageId": "my-worker",
  "version": "1.0.0",
  "displayName": "My Worker",
  "runtimeType": "background",
  "install": ["npm ci"],
  "launch": "node worker.js",
  "permissions": ["program.launch", "network.outbound"]
}
```

### Container

The `launch` command must reference the image you publish.

```json
{
  "packageId": "my-tool",
  "version": "1.0.0",
  "displayName": "My Tool",
  "runtimeType": "container",
  "install": ["docker pull registry.example.com/me/my-tool:1.0.0"],
  "launch": "docker run --rm -p 6901:6901 -v \"$PWD\":/workspace registry.example.com/me/my-tool:1.0.0",
  "ports": [6901],
  "permissions": ["program.launch"]
}
```

### GUI (streamed desktop app)

A container that serves a desktop/GUI on a web port. Set `webGui: true`.

```json
{
  "packageId": "my-gui",
  "version": "1.0.0",
  "displayName": "My GUI App",
  "runtimeType": "container",
  "webGui": true,
  "install": ["docker pull registry.example.com/me/my-gui:1.0.0"],
  "launch": "docker run --rm -p 6901:6901 registry.example.com/me/my-gui:1.0.0",
  "ports": [6901],
  "permissions": ["program.launch"]
}
```

---

## Already have a devcontainer.json?

You can publish a project that has a `devcontainer.json` without writing a
`vectant.programs.json` — Vectant reads a documented subset of it. Here's how the
fields map:

| `devcontainer.json` | Becomes |
|---------------------|---------|
| `name` | `displayName` (and a slugified `packageId`) |
| `version` | `version` (defaults to `0.0.0`) |
| `containerEnv` / `remoteEnv` | `env` (platform-reserved keys are dropped) |
| `forwardPorts` | `ports` (an app with ports becomes `web`, otherwise `background`) |
| `onCreateCommand`, `updateContentCommand`, `postCreateCommand` | `install` (in that order) |
| `postStartCommand` | `launch` |
| `image` / `build.dockerfile` | recorded as hints |

The same [Rules](#rules) apply: a devcontainer that requests host access is not
accepted. Specifically, these keys are rejected:

- `privileged: true`
- host `mounts` (bind mounts, `docker.sock`, `/var/run/...`)
- `runArgs` containing `-v`, `--privileged`, `--cap-add`, `--security-opt`, or `--device`
- host-access `features` such as docker-in-docker, docker-outside-of-docker, or sshd

For full control over how your app appears and runs, add a `vectant.programs.json` —
it always takes precedence over an imported `devcontainer.json`.

---

## Checklist before you submit

- [ ] `packageId`, `version`, and `launch` are set.
- [ ] `runtimeType` matches how your app runs.
- [ ] `ports` lists every port your app listens on.
- [ ] `permissions` requests only what the app needs.
- [ ] No host mounts or privileged flags in `install`/`launch`.
- [ ] For `container`/`gui`: `launch` references the image you publish.
