#!/usr/bin/env bash
# Live proof: a real managed-runtime crash inside the collab-server becomes a
# normalized runtime_observed causal event and a relevance-routed inbox notice.
set -uo pipefail
BASE="http://localhost:3000"
WS="acme-proof"
CT=$(grep -E '^SYNTHI_CODESITE_TOKEN=' .env.local | head -1 | cut -d= -f2-)
AUTH="Authorization: Bearer $CT"
JSON="Content-Type: application/json"
STEP() { printf '\n=== %s ===\n' "$*"; }
jget() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);const v=process.argv[1].split('.').reduce((a,k)=>a==null?a:a[k],o);console.log(v==null?'':(typeof v==='object'?JSON.stringify(v):v));}catch(e){console.log('')}})" "$1"; }

STEP "A. Create project + two agents with intersecting routes"
RESP=$(curl -s -X POST "$BASE/api/workspace/$WS/codesite/projects" -H "$AUTH" -H "$JSON" -d '{"title":"Runtime observation proof","request":"runtime"}')
PID=$(printf '%s' "$RESP" | jget project.id); echo "project=$PID"
curl -s -X POST "$BASE/api/workspace/$WS/codesite/projects/$PID/members" -H "$AUTH" -H "$JSON" -d '{"userId":"user-alice","role":"owner"}' > /dev/null
curl -s -X POST "$BASE/api/workspace/$WS/codesite/projects/$PID/members" -H "$AUTH" -H "$JSON" -d '{"userId":"user-ben","role":"agent"}' > /dev/null
NOW=$(date -u +%Y-%m-%dT%H:%M:%S.000Z); COLLAB="collab-obs-$RANDOM"
ATTACH() { # owner member term provider ref callsign
cat <<EOF
{"collaborationMembershipVerified":true,"ownerUserId":"$1","collaborationUserId":"$2","effectiveWorkspaceUserId":"$3","collaborationSessionId":"$COLLAB","terminalSessionId":"$4","runtimeScope":"workspace:$WS","agentProvider":"$5","providerSessionRef":"$6","displayCallsign":"$7","capabilities":["codesite.context.read","codesite.inbox.read","codesite.events.read","codesite.knowledge.read","codesite.knowledge.write","codesite.inbox.respond","codesite.observations.write","codesite.plans.write"],"subscriptions":["path:src/**"]}
EOF
}
RESP=$(curl -s -X POST "$BASE/api/workspace/$WS/codesite/projects/$PID/agent-sessions/attach" -H "$AUTH" -H "$JSON" -d "$(ATTACH user-alice member-alice eff-alice term-obs-a codex prov-obs-$RANDOM CODEX-OBS-A)")
SID_A=$(printf '%s' "$RESP" | jget session.id); TOK_A=$(printf '%s' "$RESP" | jget agentAccessToken)
RESP=$(curl -s -X POST "$BASE/api/workspace/$WS/codesite/projects/$PID/agent-sessions/attach" -H "$AUTH" -H "$JSON" -d "$(ATTACH user-ben member-ben eff-ben term-obs-b claude prov-obs-b-$RANDOM CLAUDE-OBS-B)")
SID_B=$(printf '%s' "$RESP" | jget session.id); TOK_B=$(printf '%s' "$RESP" | jget agentAccessToken)
echo "alice=$SID_A ben=$SID_B"
echo "token lengths: alice=${#TOK_A} ben=${#TOK_B}"
[ -n "$TOK_A" ] && [ -n "$TOK_B" ] || { echo "FAIL: missing scoped token(s)"; printf '%s' "$RESP" | head -c 400; exit 1; }

STEP "B. Ben files an execution plan himself (his scoped token, his route)"
PLAN_BODY=$(cat <<EOF
{"agentSessionId":"$SID_B","mission":"Consume rotation events in DoorState","route":["src/DoorState.cpp"],"expectedReads":["src/CharacterController.cpp"],"expectedWrites":["src/DoorState.cpp"],"tests":["tests/rotation-door.test.js"]}
EOF
)
PLAN_URL="$BASE/api/workspace/$WS/codesite/agent-sessions/$SID_B/execution-plans"
echo "POST $PLAN_URL"
echo "auth len: ${#TOK_B}"
HTTP=$(curl -s -o "$LOCALAPPDATA/Temp/plan_out.json" -w '%{http_code}' -X POST "$PLAN_URL" -H "Authorization: Bearer $TOK_B" -H "$JSON" -d "$PLAN_BODY")
echo "POST execution-plans (as Ben) -> $HTTP"; head -c 400 "$LOCALAPPDATA/Temp/plan_out.json"; echo
PLAN_ID=$(cat "$LOCALAPPDATA/Temp/plan_out.json" | jget executionPlan.id)
[ -n "$PLAN_ID" ] || { echo "FAIL: no plan id"; exit 1; }
echo "plan=$PLAN_ID"

STEP "C. Simulate the collab-server runtime publisher: crash on a runtime bound to the project"
# This is exactly the POST the collab-server's runtimeObservationPublisher sends
# when a managed runtime session transitions to crashed.
OBS_BODY=$(cat <<EOF
{"producer":{"kind":"program_runtime_adapter","eventId":"live-crash-$RANDOM"},"occurredAt":"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)","adapterSessionId":"rt-live-crash-1","refs":{"runtimeSessionIds":["rt-live-crash-1"],"paths":["src/DoorState.cpp"]},"fact":{"observationKind":"crashed","runtimeState":"crashed","exitCode":1,"reasonCodes":["stop_reason_process_exit"]}}
EOF
)
HTTP=$(curl -s -o "$LOCALAPPDATA/Temp/obs_out.json" -w '%{http_code}' -X POST "$BASE/api/workspace/$WS/codesite/projects/$PID/observations" -H "$AUTH" -H "$JSON" -d "$OBS_BODY")
echo "POST observations (adapter path) -> $HTTP"
cat "$LOCALAPPDATA/Temp/obs_out.json" | head -c 400; echo
[ "$HTTP" = "201" ] || { echo "FAIL: runtime observation ingest"; exit 1; }
NOTIFIED=$(cat "$LOCALAPPDATA/Temp/obs_out.json" | jget notifiedAgentSessionIds)
echo "notified: $NOTIFIED"
echo "$NOTIFIED" | grep -q "$SID_B" || { echo "FAIL: Ben (plan route intersects observation) was not notified"; exit 1; }
echo "PASS: route owner notified (subscription/route matches included: $NOTIFIED)"

STEP "D. Ben sees the runtime crash in his bounded context"
RESP=$(curl -s "$BASE/api/workspace/$WS/codesite/agent-sessions/$SID_B/relevant-context" -H "Authorization: Bearer $TOK_B")
printf '%s' "$RESP" > "$LOCALAPPDATA/Temp/ben_ctx.json"
node -e "
const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
const s=JSON.stringify(d);
if(!s.includes('program_runtime_adapter')){ console.error('FAIL: crash observation missing from Ben context'); process.exit(1); }
console.log('PASS: crash observation present in Ben context');
" "$(cygpath -w "$LOCALAPPDATA/Temp/ben_ctx.json")" || exit 1

STEP "E. Timeline contains the runtime_observed event"
curl -s "$BASE/api/workspace/$WS/codesite/projects/$PID/events?limit=30" -H "$AUTH" > "$LOCALAPPDATA/Temp/tl.json"
node -e "
const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
const types=(d.events||[]).map(e=>e.eventType);
if(!types.includes('runtime_observed')){ console.error('FAIL: no runtime_observed in timeline'); process.exit(1); }
console.log('PASS: runtime_observed in causal timeline');
" "$(cygpath -w "$LOCALAPPDATA/Temp/tl.json")" || exit 1

STEP "RESULT: RUNTIME OBSERVATION CHAIN PASSED END TO END"
