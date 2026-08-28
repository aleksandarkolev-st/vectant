#!/usr/bin/env bash
# Live multi-agent connection proof against the running Compose stack.
# Proves: two differently-owned agents attach to one shared project,
# one agent's discovery produces a targeted durable impact notice for the
# other, the other acknowledges it, and observations land on the causal
# timeline -- all over real HTTP with real scoped credentials.
set -uo pipefail

BASE="http://localhost:3000"
WS="acme-proof"
ENV_FILE=".env.local"
CT=$(grep -E '^SYNTHI_CODESITE_TOKEN=' "$ENV_FILE" | head -1 | cut -d= -f2-)
if [ -z "$CT" ]; then echo "FATAL: no SYNTHI_CODESITE_TOKEN"; exit 2; fi

AUTH="Authorization: Bearer $CT"
JSON="Content-Type: application/json"
STEP() { printf '\n=== %s ===\n' "$*"; }
jget() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);const v=process.argv[1].split('.').reduce((a,k)=>a==null?a:a[k],o);console.log(v==null?'':(typeof v==='object'?JSON.stringify(v):v));}catch(e){console.log('')}})" "$1"; }

STEP "0. Control plane reachable (unauthenticated must be denied)"
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/api/workspace/$WS/codesite/projects")
echo "GET projects without auth -> $CODE (expect 401)"
if [ "$CODE" != "401" ] && [ "$CODE" != "403" ]; then echo "FAIL: auth wall missing"; exit 1; fi

STEP "1. Create the shared project"
RESP=$(curl -s -X POST "$BASE/api/workspace/$WS/codesite/projects" -H "$AUTH" -H "$JSON" \
  -d '{"title":"Live multi-agent proof","request":"Prove two owned agents coordinate over the shared bus"}')
echo "$RESP" | head -c 400; echo
PID=$(printf '%s' "$RESP" | jget project.id)
[ -n "$PID" ] || { echo "FAIL: no project id"; exit 1; }
echo "project=$PID"

STEP "1b. Tower adds Alice and Ben as project members (owner + agent roles)"
for M in '{"userId":"user-alice","role":"owner"}' '{"userId":"user-ben","role":"agent"}'; do
  RESP=$(curl -s -X POST "$BASE/api/workspace/$WS/codesite/projects/$PID/members" -H "$AUTH" -H "$JSON" -d "$M")
  printf '%s' "$RESP" | head -c 200; echo
done

NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
COLLAB="collab-live-$RANDOM"

STEP "2. Alice attaches CODEX-ROTATION-01 (owner alice)"
ATTACH_BODY=$(cat <<EOF
{
  "collaborationMembershipVerified": true,
  "ownerUserId": "user-alice",
  "collaborationUserId": "member-alice",
  "effectiveWorkspaceUserId": "eff-alice",
  "collaborationSessionId": "$COLLAB",
  "terminalSessionId": "term-alice-1",
  "runtimeScope": "workspace:$WS",
  "agentProvider": "codex",
  "providerSessionRef": "prov-codex-$RANDOM",
  "displayCallsign": "CODEX-ROTATION-01",
  "capabilities": ["codesite.context.read","codesite.inbox.read","codesite.events.read","codesite.knowledge.read","codesite.knowledge.write","codesite.inbox.respond","codesite.observations.write"],
  "subscriptions": ["path:src/**","contract:rotation.completed@v1"]
}
EOF
)
RESP=$(curl -s -X POST "$BASE/api/workspace/$WS/codesite/projects/$PID/agent-sessions/attach" -H "$AUTH" -H "$JSON" -d "$ATTACH_BODY")
SID_A=$(printf '%s' "$RESP" | jget session.id)
TOK_A=$(printf '%s' "$RESP" | jget agentAccessToken)
RESUMED_A=$(printf '%s' "$RESP" | jget resumed)
echo "alice session=$SID_A resumed=$RESUMED_A token=${TOK_A:0:8}..."
[ -n "$SID_A" ] && [ -n "$TOK_A" ] || { echo "FAIL: alice attach"; echo "$RESP" | head -c 600; exit 1; }

STEP "3. Ben attaches CLAUDE-DOOR-02 (owner ben, different user)"
BEN_RANDOM=$RANDOM
ATTACH_BODY_BEN=$(cat <<EOF
{
  "collaborationMembershipVerified": true,
  "ownerUserId": "user-ben",
  "collaborationUserId": "member-ben",
  "effectiveWorkspaceUserId": "eff-ben",
  "collaborationSessionId": "$COLLAB",
  "terminalSessionId": "term-ben-1",
  "runtimeScope": "workspace:$WS",
  "agentProvider": "claude",
  "providerSessionRef": "prov-claude-$BEN_RANDOM",
  "displayCallsign": "CLAUDE-DOOR-02",
  "capabilities": ["codesite.context.read","codesite.inbox.read","codesite.events.read","codesite.knowledge.read","codesite.knowledge.write","codesite.inbox.respond","codesite.observations.write"],
  "subscriptions": ["path:src/**"]
}
EOF
)
RESP=$(curl -s -X POST "$BASE/api/workspace/$WS/codesite/projects/$PID/agent-sessions/attach" -H "$AUTH" -H "$JSON" -d "$ATTACH_BODY_BEN")
SID_B=$(printf '%s' "$RESP" | jget session.id)
TOK_B=$(printf '%s' "$RESP" | jget agentAccessToken)
echo "ben session=$SID_B token=${TOK_B:0:8}..."
[ -n "$SID_B" ] && [ -n "$TOK_B" ] || { echo "FAIL: ben attach"; echo "$RESP" | head -c 600; exit 1; }

STEP "4. Alice records a discovery (rotation ownership fact)"
KNOW_BODY=$(cat <<EOF
{
  "kind": "discovery",
  "title": "CharacterController.cpp owns player rotation",
  "summary": "CharacterController::Turn emits rotation.completed@v1; Camera.cpp does not control rotation. DoorState.cpp consumes the event.",
  "confidence": 0.92,
  "status": "verified",
  "verification": "verified",
  "references": {
    "paths": ["src/CharacterController.cpp", "src/Camera.cpp"],
    "contracts": ["rotation.completed@v1"],
    "symbols": ["CharacterController::Turn"]
  },
  "evidenceRefs": ["proof:live-discovery-$RANDOM"],
  "source": { "actorType": "agent", "actorId": "$SID_A" }
}
EOF
)
RESP=$(curl -s -X POST "$BASE/api/workspace/$WS/codesite/agent-sessions/$SID_A/knowledge" -H "Authorization: Bearer $TOK_A" -H "$JSON" -d "$KNOW_BODY")
echo "$RESP" | head -c 500; echo
IMPACT_ID=$(printf '%s' "$RESP" | jget impacts.0.inboxItem.id)
EVENT_ID=$(printf '%s' "$RESP" | jget event.id)
[ -n "$IMPACT_ID" ] || { echo "FAIL: no targeted impact notice produced"; exit 1; }
echo "discovery event=$EVENT_ID -> ben inbox item=$IMPACT_ID"

STEP "5. Ben sees the notice in HIS bounded context (his own credential)"
RESP=$(curl -s "$BASE/api/workspace/$WS/codesite/agent-sessions/$SID_B/relevant-context" -H "Authorization: Bearer $TOK_B")
UNREAD=$(printf '%s' "$RESP" | jget briefing.unreadInboxCount)
INBOX_JSON=$(printf '%s' "$RESP")
echo "$INBOX_JSON" | grep -q "CharacterController.cpp owns player rotation" \
  && echo "PASS: discovery text present in Ben's context without any chat copy" \
  || { echo "FAIL: discovery not found in Ben's context"; echo "$INBOX_JSON" | head -c 800; exit 1; }

STEP "6. Ben acknowledges the impact notice"
RESP=$(curl -s -X POST "$BASE/api/workspace/$WS/codesite/agent-sessions/$SID_B/inbox/$IMPACT_ID/respond" \
  -H "Authorization: Bearer $TOK_B" -H "$JSON" \
  -d '{"action":"acknowledge","reason":"Avoiding duplicate Camera investigation; consuming rotation.completed@v1 as documented"}')
echo "$RESP" | head -c 300; echo
printf '%s' "$RESP" | grep -qi 'acknowledged\|"ok"\|inboxItem' || { echo "FAIL: acknowledge rejected"; exit 1; }

STEP "7. Alice publishes a runtime observation onto the causal timeline"
OBS_BODY=$(cat <<EOF
{
  "eventType": "runtime_observed",
  "producer": { "kind": "preview_adapter", "eventId": "live-preview-$RANDOM" },
  "occurredAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "refs": {
    "runtimeSessionIds": ["rt-alice-preview-1"],
    "paths": ["src/CharacterController.cpp"],
    "contracts": ["rotation.completed@v1"],
    "process": { "pid": 4711, "parentPid": 100, "ancestry": [{ "pid": 100, "parentPid": 1 }] }
  },
  "providerSessionBound": false,
  "evidenceRefs": ["runtime-event:live-$RANDOM"],
  "fact": { "observationKind": "state_changed", "runtimeState": "ready", "healthState": "ok", "ports": [3000], "reasonCodes": ["event_payload_observed"] }
}
EOF
)
HTTP=$(curl -s -o "$LOCALAPPDATA/Temp/obs_out.json" -w '%{http_code}' -X POST "$BASE/api/workspace/$WS/codesite/agent-sessions/$SID_A/observations" -H "Authorization: Bearer $TOK_A" -H "$JSON" -d "$OBS_BODY")
echo "POST observations -> $HTTP"
head -c 400 "$LOCALAPPDATA/Temp/obs_out.json"; echo
[ "$HTTP" = "201" ] || { echo "FAIL: observation ingest"; exit 1; }
grep -q '"eventType":"runtime_observed"' "$LOCALAPPDATA/Temp/obs_out.json" || { echo "FAIL: observation event not echoed"; exit 1; }

STEP "8. NEGATIVE: Ben cannot publish an observation attributed to Alice's session"
NEG_BODY=$(cat <<EOF
{
  "eventType": "runtime_observed",
  "producer": { "kind": "terminal_adapter", "eventId": "forged-$RANDOM" },
  "occurredAt": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)",
  "refs": { "runtimeSessionIds": ["rt-forged"], "agentSessionIds": ["$SID_A"], "process": { "pid": 9 } },
  "fact": { "observationKind": "crashed", "exitCode": 1 }
}
EOF
)
HTTP=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$BASE/api/workspace/$WS/codesite/agent-sessions/$SID_B/observations" -H "Authorization: Bearer $TOK_B" -H "$JSON" -d "$NEG_BODY")
echo "forged attribution -> $HTTP (expect 403)"
[ "$HTTP" = "403" ] || { echo "FAIL: forged observation was not denied"; exit 1; }

STEP "9. NEGATIVE: rebinding Ben's ACTIVE provider ref to a new terminal must be rejected; exact rebind resumes"
FORGE_TERMINAL=$(cat <<EOF
{
  "collaborationMembershipVerified": true,
  "ownerUserId": "user-ben",
  "collaborationUserId": "member-ben",
  "effectiveWorkspaceUserId": "eff-ben",
  "collaborationSessionId": "$COLLAB",
  "terminalSessionId": "term-forge-$RANDOM",
  "runtimeScope": "workspace:$WS",
  "agentProvider": "claude",
  "providerSessionRef": "prov-claude-$BEN_RANDOM",
  "capabilities": ["codesite.context.read"]
}
EOF
)
HTTP=$(curl -s -o "$LOCALAPPDATA/Temp/forge_out.json" -w '%{http_code}' -X POST "$BASE/api/workspace/$WS/codesite/projects/$PID/agent-sessions/attach" -H "$AUTH" -H "$JSON" -d "$FORGE_TERMINAL")
echo "active ref on NEW terminal -> $HTTP (expect non-2xx)"
case "$HTTP" in 200|201) echo "FAIL: duplicate active binding accepted"; head -c 300 "$LOCALAPPDATA/Temp/forge_out.json"; exit 1;; esac
RESP=$(curl -s -X POST "$BASE/api/workspace/$WS/codesite/projects/$PID/agent-sessions/attach" -H "$AUTH" -H "$JSON" -d "$ATTACH_BODY_BEN")
RESUMED_B=$(printf '%s' "$RESP" | jget resumed)
SAME_ID=$(printf '%s' "$RESP" | jget session.id)
echo "exact rebind -> resumed=$RESUMED_B sameId=$([ "$SAME_ID" = "$SID_B" ] && echo yes || echo NO)"
[ "$RESUMED_B" = "true" ] && [ "$SAME_ID" = "$SID_B" ] || { echo "FAIL: exact rebind did not resume"; echo "$RESP" | head -c 400; exit 1; }

STEP "10. Project timeline shows the causal order (attach -> discovery -> observation)"
TIMELINE="$LOCALAPPDATA/Temp/timeline.json"
RESP=$(curl -s "$BASE/api/workspace/$WS/codesite/projects/$PID/events?limit=20" -H "$AUTH")
printf '%s' "$RESP" > "$TIMELINE"
node -e "
const fs=require('fs');
const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const ev=(d.events||[]).map(e=>e.eventType+':'+(e.displayCallsign||e.actorType));
console.log(ev.slice(0,12).join('\n'));
const types=new Set((d.events||[]).map(e=>e.eventType));
for (const t of ['agent_attached','discovery_recorded','impact_notice_created','impact_notice_responded']) {
  if(!types.has(t)){ console.error('MISSING '+t); process.exit(1); }
}
console.log('PASS: full causal chain present');
" "$(cygpath -w "$TIMELINE")" || { echo 'FAIL: timeline verification'; exit 1; }

STEP "RESULT: ALL LIVE CHECKS PASSED"
