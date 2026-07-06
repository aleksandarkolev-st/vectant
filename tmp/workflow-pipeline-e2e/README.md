# CodeSite Workflow Pipeline Proof

Generated from a Docker-backed live browser workflow run against:

- Frontend: `http://127.0.0.1:3100`
- Collab server: `http://127.0.0.1:11234`
- Browser workflow bridge: `http://127.0.0.1:9466`
- Hosted Chromium CDP: `http://127.0.0.1:37019`

Command:

```bash
env TMPDIR=/tmp TEMP=/tmp TMP=/tmp FRONTEND_URL=http://127.0.0.1:3100 COLLAB_URL=http://127.0.0.1:11234 SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL=http://127.0.0.1:9466 SYNTHI_HOSTED_BROWSER_CDP_URL=http://127.0.0.1:37019 SYNTHI_WORKFLOW_PIPELINE_TIMEOUT_MS=180000 SYNTHI_WORKFLOW_PIPELINE_VERIFY_FRESH_MCP=1 SYNTHI_WORKFLOW_PIPELINE_CASES=profile-form npm --prefix mcp/synthi-mcp run live:browser:workflow-pipeline
```

Verified workflow:

- Seeded a real profile form workspace in the Docker collab container.
- Observed and taught a browser workflow through the hosted Playwright CDP overlay.
- Compiled, exported, manifested, licensed, and published `synthi_app_save_profile`.
- Confirmed direct private tool calls require `synthi_dojo_run_with_proof_capsule`.
- Exported Dojo artifacts, extracted 35 proof evidence ledger records, issued and validated a proof capsule, dry-ran it, and executed prefix validation through the proof-gated path.
- Verified a fresh MCP process can discover the private tool, attach hosted browser runtime, grant preview consent, open the preview, and run prefix replay.
- Ran the exported Playwright workflow successfully.

Visual proof:

- `profile-form/observed-preview.png`
- `profile-form/after-teach-actions.png`
- `profile-form/after-publish-panel.png`
- `profile-form/after-validate-panel.png`

Machine proof:

- `summary.json`
- `profile-form/dojo-proof-evidence-ledger.json`
- `profile-form/dojo-proof-capsule-issue.json`
- `profile-form/dojo-proof-capsule-validate.json`
- `profile-form/dojo-proof-capsule-dry-run.json`
- `profile-form/dojo-proof-capsule-run.json`
- `profile-form/fresh-mcp-private-tool-call.json`
- `profile-form/playwright-run.log`
