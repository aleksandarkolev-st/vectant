# Vectant Local Support Incident Response

This runbook is for the Local Support security owner, cloud operations, and release owner. It is deliberately written around the real control-plane actions in this repository. It does not authorize sending local payloads or bypassing local review.

## Operating rules

1. Treat missing policy, database, relay, signing, or audit state as a fail-closed incident.
2. Record the incident ID, UTC timestamps, operator role, affected account/org/session/device IDs, policy version, app version, and every control-plane response.
3. Never copy local file bodies, preview response bodies, secrets, cookies, device private keys, or bearer tokens into tickets, chat, logs, or incident exports.
4. Preserve scrubbed hashes, request IDs, classifications, byte counts, redaction counts, decisions, and audit-chain verification results.
5. A control is not considered effective until the operator verifies the resulting durable state and a safe negative path.

## Emergency disable

Use when a vulnerable app version, scanner failure, relay abuse, or policy mistake requires immediate containment.

1. Authenticate to `/api/local-support/admin/state` with the protected operations token from the approved secret store. Use same-origin request metadata and never place the token in a URL.
2. Disable the smallest effective scope first. For a broad incident, submit:

   ```json
   {
     "action": "update_policy",
     "global_enabled": false,
     "org_disabled": true,
     "pairing_disabled": true,
     "preview_disabled": true,
     "agent_access_disabled": true,
     "min_app_version": "<approved-current-version>",
     "vulnerable_versions": ["<affected-version>"],
     "retention_days": 30
   }
   ```

3. Verify the response is `policy_updated`, then `GET` the admin state again and confirm the durable policy values.
4. Confirm `/api/local-support/policy` returns the disabled state and that a new pairing request is denied.
5. Revoke affected sessions and devices individually through the same admin route. Confirm the response is `revocation_required`, the session status is `revoked`, pending relay requests are no longer deliverable, and encrypted pending payloads are purged.
6. Record a scrubbed security event with the incident ID, affected scope, reason class, and zero raw body fields.

## Compromised session, device, or relay credential

1. Revoke the device first when the device identity or private key may be exposed. Revoke the session when scope is limited to one support session.
2. Confirm a previously valid device poll returns `relay_revoked` and that a previously queued request cannot be leased.
3. Rotate the affected cloud secret in the secret manager: admin token, envelope secret, device-proof secret, or relay payload key. Do not reuse the exposed value.
4. Restart the affected cloud workers and verify old credentials fail closed while newly provisioned credentials pass the authenticated smoke path.
5. Search only scrubbed audit fields for reuse: request ID, device fingerprint hash, account/org, actor, capability, decision, bytes sent, and reason. Do not search or export raw local content.

## Suspected malicious or downgraded update

1. Disable the affected version in the durable vulnerable-version policy and raise the minimum supported version above it.
2. Stop publication of the affected channel and preserve the signed manifest, artifact hash, release commit, SBOM, workflow run, and Authenticode status.
3. Do not replace a signed artifact in place. Publish a new version through the protected signing workflow after two-person review.
4. Verify on a clean runner that the candidate rejects:
   - an altered artifact hash;
   - an invalid updater signature;
   - a version lower than the installed version;
   - a revoked installed version;
   - an unsupported channel or malformed manifest.
5. Keep the affected update endpoint disabled until the clean-runner verification and incident owner sign-off are recorded.

## Signing-key rotation

1. Declare the old key compromised or retired and record the reason and UTC time.
2. Generate the replacement key in the approved hardened signing environment. Never write private key material to the repository, CI log, artifact bundle, or developer workstation.
3. Update the protected CI secret, updater public key, release endpoint configuration, and key inventory in one reviewed change. Require two reviewers for all signing configuration changes.
4. Publish a key-transition release that is signed with the approved transition procedure. Keep the old public key available only for the explicitly documented transition window.
5. Verify a clean install, update, downgrade rejection, tamper rejection, and emergency version revocation with the new key.
6. Revoke and destroy the old private key according to the organization’s key-destruction procedure. Record evidence without recording key bytes.

## Audit and user-impact investigation

For each affected account or organization, collect only:

- account, organization, session, and device identifiers or their approved hashes;
- request IDs, actor, capability, target classification, target hash, decision, reason, timestamp, policy/scanner/protocol versions;
- bytes sent and redaction counts;
- local/cloud audit-chain heads and verification results;
- revocation and purge responses.

The incident owner must answer:

1. What was requested?
2. What was blocked or redacted locally?
3. What, if anything, was actually sent, and how many bytes left the machine?
4. Which sessions, devices, ports, and relay requests were revoked?
5. Were any raw bodies, credentials, cookies, or sensitive URLs present in cloud logs or exports? If so, escalate as a separate data-exposure incident and do not duplicate the material.

## Tabletop exercise checklist

The exercise facilitator records pass/fail evidence for every item. A documented procedure is not an exercised control.

- [ ] Disable global access and verify durable policy state.
- [ ] Revoke a session and verify relay denial plus payload purge.
- [ ] Revoke a device and verify old device proof rejection.
- [ ] Block a vulnerable app version and verify pairing denial.
- [ ] Reject a tampered, unsigned, and downgraded update on a clean runner.
- [ ] Rotate an updater key and verify the new signed candidate.
- [ ] Export scrubbed audit evidence and verify the chain without raw bodies.
- [ ] Restore approved policy only after the incident owner records scope, evidence, and sign-off.

## Required evidence before closure

The incident may close only when containment, durable state verification, audit preservation, user-impact assessment, remediation, and owner sign-off are recorded. If production signing credentials, cloud infrastructure, or a clean verification runner were unavailable, the incident remains open with that exact dependency named.
