# Vectant Local Support Incident Response

This runbook applies to suspected device-key compromise, malicious pairing, unsafe preview forwarding, secret disclosure, signing-key compromise, and vulnerable desktop releases. Public beta remains blocked until every exercise produces dated evidence and all critical/high findings are closed.

## Authority and evidence

- Incident commander may activate global, organization, pairing, preview, or agent-access disables without waiting for a release.
- Security operations owns device/session revocation and alert triage. Release engineering owns signing and updater keys. These roles must be held by different people during a signing incident.
- Store only scrubbed event IDs, request/session/device IDs, hashes, versions, decisions, and timestamps. Never copy raw local payloads, tokens, pairing codes, or private keys into tickets or chat.
- Record who performed each action, UTC time, API/command result, and a link to immutable CI or audit evidence.

## First 15 minutes

1. Open an incident record and assign commander, security operator, release operator, and communications owner.
2. Preserve scrubbed cloud security events and the affected user’s scrubbed local export. Verify both audit chains before analysis.
3. Use `/local-support/admin` to apply the narrowest safe immediate control. For uncertain or active exploitation, disable global access, pairing, preview, and agent access.
4. Revoke affected sessions and devices. Confirm the desktop receives terminal relay denial and clears approvals, preview ports, tokens, and pending content.
5. If a version is implicated, add it to `vulnerable_versions` and raise `min_app_version`. Confirm cloud and local negative tests return zero bytes sent.
6. If secrets may have crossed the boundary, treat the data owner—not Vectant logs—as the source of truth and begin credential rotation without requesting the raw secret.

## Scenario actions

### Pairing or session compromise

- Disable pairing when scope is unknown.
- Revoke device and every related session.
- Search scrubbed events for account/org/workspace/device mismatches, replay, bad proof, and abnormal request rate.
- Require a new local fingerprint confirmation and rotated OS-owned device identity before reconnecting.

### Preview abuse or malicious dev server

- Disable preview globally or for the organization.
- Revoke every approved port for affected sessions.
- Preserve redirect-block, service-worker, rate-limit, process-identity, and response-cap events.
- Re-enable only after real-server tests cover the exploit and process identity changes revoke access.

### Suspected local-data disclosure

- Pause affected sessions, then revoke if containment is incomplete.
- Verify the sent receipt’s target hash, classification, redaction count, byte count, scanner/policy version, and approval ID.
- Scan exports, application logs, CI output, and cloud summaries for fixture markers. Do not paste suspected customer data into the scanner corpus.
- Treat scanner uncertainty or missing audit evidence as a disclosure until disproved.

### Signing or updater compromise

- Disable Local Support and pairing globally.
- Mark every build signed by the suspect key as vulnerable; raise minimum version only after a replacement build is available.
- Revoke the certificate with its issuer and disable the protected signing environment.
- Rotate updater and code-signing keys using the procedure below. Never reuse the compromised key to sign the recovery release.

## Signing-key rotation

1. Two release operators verify the incident ID, intended version/channel, source commit, and clean security workflow result.
2. Generate the replacement key in the approved hardware-backed or protected signing environment. Private material must never enter the repository, workflow logs, artifacts, or developer workstations.
3. Add the new public updater key to a dual-trust transition release signed by the still-trusted old key. If the old key is compromised, distribute recovery only through the independently code-signed installer channel.
4. Update protected-environment secrets and revoke access to the old environment/key.
5. Build from the reviewed commit, generate SBOM and checksums, sign installer and update metadata, then verify signatures on a separate clean Windows runner.
6. Exercise rejection of unsigned, byte-tampered, wrong-channel, revoked, and downgraded packages. Record exact CI run and artifact hashes.
7. Revoke the old key/certificate, remove dual trust in the next release, and confirm old-key updates fail.

## Recovery and closeout gates

- All kill switches and revocations were observed end-to-end, not inferred from a successful API response.
- The exploit has a failing-then-passing regression test using the real boundary it attacked.
- Scrubbed audit chains verify and no raw bodies or credentials appear in collected evidence.
- Critical/high findings are closed and independently reviewed.
- Windows signature verification, package hash verification, downgrade rejection, and emergency version revocation pass on a clean machine.
- Communications and retention actions are approved by security/legal owners.
- Controls are re-enabled one at a time; pairing and preview are last.

## Tabletop record

For each exercise, record: date, participants/roles, scenario, starting version/commit, controls invoked, time-to-containment, observed desktop/cloud behavior, evidence links, findings with severity/owner/due date, retest result, and security-owner sign-off. An unchecked template or unit-only output is not exercise evidence.
