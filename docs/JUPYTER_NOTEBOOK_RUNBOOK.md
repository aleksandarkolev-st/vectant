# Jupyter notebook support runbook

## Prerequisites

Run the checked-in Prisma migration before enabling the viewer:

```powershell
Set-Location synthi
npx prisma migrate deploy
```

Each connected Jupyter server must already be running. The server URL must be HTTPS,
except a loopback `http://localhost` development server. Tokens are entered only in the
workspace settings UI and are encrypted before persistence.

## Rollout flags

| Variable | Default | Effect |
| --- | --- | --- |
| `NEXT_PUBLIC_JUPYTER_NOTEBOOK_VIEWER` | enabled | Native safe `.ipynb` viewer. Set to `0` to restore source-file behavior. |
| `NEXT_PUBLIC_JUPYTER_NOTEBOOK_EDITING` | disabled | Enables structural notebook saves through the existing workspace save path. |
| `NEXT_PUBLIC_JUPYTER_AGENT_EXECUTION` | disabled | Registers the approval-gated Jupyter execution tool. |

Roll out viewer, editing, then execution. Validate each stage with a non-sensitive
notebook and a workspace member account before broadening access.

## Operational checks

1. In workspace settings, add an approved server and confirm the token is never shown
   again, apart from its final four characters.
2. Open a notebook, confirm a malformed or unsafe output remains isolated from Monaco
   and the workspace shell.
3. Attach the notebook deliberately in chat. The attachment must be labelled untrusted
   and explicit, never automatic.
4. When execution is enabled, request a cell execution through chat. It must appear in
   the standard approval card before a kernel receives code.
5. Revoke the server. Existing workspace features remain available; only Jupyter
   operations fail closed.

## Rollback

Set the relevant flag to `0` and redeploy. Disabling execution keeps viewing and editing;
disabling editing keeps viewing; disabling viewer returns `.ipynb` to normal source-file
handling. Never delete registrations or notebook files as part of rollback. Existing
kernels are not automatically terminated by revocation or UI disconnect.

## Incident handling

- A Jupyter transport loss during execution is **unknown**, not failed or safe to retry.
  Do not re-run automatically; inspect kernel state first.
- A server revision mismatch is a conflict. Preserve the local buffer and ask the user to
  choose a recovery path. Do not overwrite either side.
- Credential exposure suspicion: revoke the server registration, rotate the token at the
  Jupyter host, and review `JupyterAuditEvent` metadata. Audit records intentionally do
  not include tokens, notebook bodies, or output bodies.
