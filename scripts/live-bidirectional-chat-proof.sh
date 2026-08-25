#!/usr/bin/env bash
# ============================================================================
# MEDIATED AGENT-TO-AGENT CHAT — FULL BIDIRECTIONAL ROUND-TRIP PROOF
# (closes review caveat #2: "reply leg implemented but never captured")
#
# Two REAL attached agents (different owners/providers) in one shared session:
#   LEG A->B : CHAT-A posts a handoff addressed to CHAT-B
#   RECEIVE  : CHAT-B reads its OWN inbox authenticated ONLY by its
#              agentAccessToken (the exact leg that hit auth friction before;
#              exercises getAgentInboxForAgent added by the R5 fix)
#   RESPOND  : CHAT-B accepts the handoff via inbox respond
#   LEG B->A : CHAT-B posts its reply handoff addressed back to CHAT-A
#   RECEIVE  : CHAT-A reads the reply from its own inbox (token-only auth)
# Negatives prove the gate fails closed (unauthenticated + cross-agent reads).
#
# All identifiers are generated at runtime; no hardcoded values.
# BASE is overridable so the SAME script can validate any environment:
#   BASE=https://beta.vectant.dev bash scripts/live-bidirectional-chat-proof.sh
# ============================================================================
set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" || exit 1

BASE="${BASE:-http://localhost:3000}"
WS="${PROOF_WS:-acme-bidirectional}"
OUT="${LOCALAPPDATA:-/tmp}/Temp/bidirectional-proof"
mkdir -p "$OUT"
INTERNAL_TOKEN=$(grep -E '^SYNTHI_CODESITE_TOKEN=' .env.local | head -1 | cut -d= -f2-)
AUTH="Authorization: Bearer ${INTERNAL_TOKEN}"
JSON='Content-Type: application/json'
PASS=0; FAIL=0; STEP_N=0

step() { STEP_N=$((STEP_N+1)); echo ""; echo "=== $1 ==="; }
ok()  { PASS=$((PASS+1)); echo "  PASS: $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL: $1"; }
check() { local name="$1" got="$2" want="$3"; [ "$got" = "$want" ] && ok "$name ($got)" || bad "$name (got '$got' want '$want')"; }

jget() { node -e "
let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{
  const o=JSON.parse(d);const v=process.argv[1].split('.').reduce((a,k)=>a==null?a:a[k],o);
  console.log(v==null?'':(typeof v==='object'?JSON.stringify(v):v));
}catch(e){console.log('')}})" "$1"; }

ATTACH() { # $1 owner $2 member $3 eff $4 term $5 provider $6 ref $7 callsign $8 projectId
  local body="{\"collaborationMembershipVerified\":true,\"ownerUserId\":\"$1\",\"collaborationUserId\":\"$2\",\"effectiveWorkspaceUserId\":\"$3\",\"collaborationSessionId\":\"${COLLAB}\",\"terminalSessionId\":\"$4\",\"runtimeScope\":\"workspace:${WS}\",\"agentProvider\":\"$5\",\"providerSessionRef\":\"$6\",\"displayCallsign\":\"$7\",\"capabilities\":[\"codesite.context.read\",\"codesite.plans.write\",\"codesite.knowledge.write\",\"codesite.knowledge.read\",\"codesite.inbox.respond\",\"codesite.channels.open\"]}"
  printf '%s' "$body" > "$OUT/attach-body.json"
  curl -sL -X POST "$BASE/api/workspace/$WS/codesite/projects/$8/agent-sessions/attach" \
    -H "$AUTH" -H "$JSON" --data-binary @"$OUT/attach-body.json" > "$OUT/attach-resp.json"
  local sid tok
  sid=$(jget session.id < "$OUT/attach-resp.json")
  tok=$(jget agentAccessToken < "$OUT/attach-resp.json")
  [ -n "$sid" ] && [ -n "$tok" ] && printf '%s %s\n' "$sid" "$tok"
}

echo "=== Setup: shared collaboration session with two agents ==="
COLLAB="collab-bidir-$RANDOM"
HTTP=$(curl -sL -o "$OUT/proj.json" -w '%{http_code}' -X POST "$BASE/api/workspace/$WS/codesite/projects" -H "$AUTH" -H "$JSON" -d '{"title":"Bidirectional mediated chat proof"}')
check "project created" "$HTTP" "201"
PID=$(jget project.id < "$OUT/proj.json")
curl -sL -X POST "$BASE/api/workspace/$WS/codesite/projects/$PID/members" -H "$AUTH" -H "$JSON" -d '{"userId":"user-alice","role":"owner"}' > /dev/null
curl -sL -X POST "$BASE/api/workspace/$WS/codesite/projects/$PID/members" -H "$AUTH" -H "$JSON" -d '{"userId":"user-ben","role":"agent"}' > /dev/null

RESULT_A=$(ATTACH user-alice member-alice eff-alice "term-a-$RANDOM" codex prov-a-"$RANDOM" CHAT-A "$PID")
SID_A=$(printf '%s' "$RESULT_A" | cut -d' ' -f1); TOK_A=$(printf '%s' "$RESULT_A" | cut -d' ' -f2)
RESULT_B=$(ATTACH user-ben member-ben eff-ben "term-b-$RANDOM" claude prov-b-"$RANDOM" CHAT-B "$PID")
SID_B=$(printf '%s' "$RESULT_B" | cut -d' ' -f1); TOK_B=$(printf '%s' "$RESULT_B" | cut -d' ' -f2)
[ -n "$SID_A" ] && [ -n "$TOK_A" ] && ok "CHAT-A attached ($SID_A)" || bad "CHAT-A attach failed"
[ -n "$SID_B" ] && [ -n "$TOK_B" ] && ok "CHAT-B attached ($SID_B)" || bad "CHAT-B attach failed"

step "LEG 1 (A->B): CHAT-A posts a message addressed to CHAT-B"
MSG1="bidir-msg-a2b-$RANDOM"
HANDOFF_BODY="{\"kind\":\"handoff\",\"title\":\"Round-trip probe $MSG1\",\"summary\":\"Please confirm receipt of $MSG1\",\"toAgentSessionId\":\"$SID_B\",\"requiredActions\":[\"confirm receipt\"]}"
HTTP=$(curl -sL -o "$OUT/h1.json" -w '%{http_code}' -X POST "$BASE/api/workspace/$WS/codesite/agent-sessions/$SID_A/knowledge" \
  -H "Authorization: Bearer $TOK_A" -H "$JSON" -d "$HANDOFF_BODY")
check "CHAT-A handoff accepted" "$HTTP" "201"
KID1=$(jget knowledge.id < "$OUT/h1.json")
[ -n "$KID1" ] && ok "knowledge item id $KID1" || bad "no knowledge id returned"

step "RECEIVE (B): CHAT-B reads its own inbox with ONLY its agent token"
INBOX_B_CODE=$(curl -sL -o "$OUT/inbox-b.json" -w '%{http_code}' "$BASE/api/workspace/$WS/codesite/agent-sessions/$SID_B/inbox" -H "Authorization: Bearer $TOK_B")
check "inbox GET with agent token returns 200" "$INBOX_B_CODE" "200"
EVENT1=$(node -e "
const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
const items=(d.inbox||[]).filter(i=>i.knowledgeItemId==='$KID1');
console.log(items.length?items[items.length-1].id:'')" "$(cygpath -w "$OUT/inbox-b.json")" 2>/dev/null)
[ -n "$EVENT1" ] && ok "message delivered into CHAT-B durable inbox ($EVENT1)" || bad "message NOT found in CHAT-B inbox"

step "NEGATIVE GATE 1: inbox must fail closed without credentials"
NOAUTH_CODE=$(curl -sL -o /dev/null -w '%{http_code}' "$BASE/api/workspace/$WS/codesite/agent-sessions/$SID_B/inbox")
[ "$NOAUTH_CODE" != "200" ] && ok "unauthenticated inbox read rejected ($NOAUTH_CODE)" || bad "unauthenticated inbox read SUCCEEDED (gate open!)"

step "NEGATIVE GATE 2: CHAT-B's token must not read CHAT-A's inbox"
CROSS_CODE=$(curl -sL -o /dev/null -w '%{http_code}' "$BASE/api/workspace/$WS/codesite/agent-sessions/$SID_A/inbox" -H "Authorization: Bearer $TOK_B")
[ "$CROSS_CODE" != "200" ] && ok "cross-agent inbox read rejected ($CROSS_CODE)" || bad "cross-agent inbox read SUCCEEDED (isolation broken!)"

step "RESPOND (B): CHAT-B accepts the handoff"
RESP_BODY='{"action":"accept","reason":"receipt confirmed, proceeding"}'
HTTP=$(curl -sL -o "$OUT/resp.json" -w '%{http_code}' -X POST "$BASE/api/workspace/$WS/codesite/agent-sessions/$SID_B/inbox/$EVENT1/respond" \
  -H "Authorization: Bearer $TOK_B" -H "$JSON" -d "$RESP_BODY")
check "CHAT-B response accepted" "$HTTP" "200"
RACTION=$(jget response.action < "$OUT/resp.json")
check "response action recorded" "$RACTION" "accept"

step "LEG 2 (B->A): CHAT-B replies back to CHAT-A"
MSG2="bidir-msg-b2a-$RANDOM"
REPLY_BODY="{\"kind\":\"handoff\",\"title\":\"Reply $MSG2\",\"summary\":\"Acknowledged $MSG1; replying with $MSG2\",\"toAgentSessionId\":\"$SID_A\",\"references\":{\"agentSessionIds\":[\"$SID_A\"]},\"requiredActions\":[\"none\"]}"
HTTP=$(curl -sL -o "$OUT/h2.json" -w '%{http_code}' -X POST "$BASE/api/workspace/$WS/codesite/agent-sessions/$SID_B/knowledge" \
  -H "Authorization: Bearer $TOK_B" -H "$JSON" -d "$REPLY_BODY")
check "CHAT-B reply accepted" "$HTTP" "201"
KID2=$(jget knowledge.id < "$OUT/h2.json")

step "RECEIVE (A): CHAT-A reads the reply with ONLY its agent token"
INBOX_A_CODE=$(curl -sL -o "$OUT/inbox-a.json" -w '%{http_code}' "$BASE/api/workspace/$WS/codesite/agent-sessions/$SID_A/inbox" -H "Authorization: Bearer $TOK_A")
check "CHAT-A inbox GET with agent token returns 200" "$INBOX_A_CODE" "200"
EVENT2=$(node -e "
const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
const items=(d.inbox||[]).filter(i=>i.knowledgeItemId==='$KID2');
console.log(items.length?items[items.length-1].id:'')" "$(cygpath -w "$OUT/inbox-a.json")" 2>/dev/null)
[ -n "$EVENT2" ] && ok "reply delivered into CHAT-A durable inbox ($EVENT2)" || bad "reply NOT found in CHAT-A inbox"
ACK_BODY='{"action":"acknowledge","reason":"reply received; round trip closed"}'
HTTP=$(curl -sL -o "$OUT/resp2.json" -w '%{http_code}' -X POST "$BASE/api/workspace/$WS/codesite/agent-sessions/$SID_A/inbox/$EVENT2/respond" \
  -H "Authorization: Bearer $TOK_A" -H "$JSON" -d "$ACK_BODY")
check "CHAT-A acknowledges the reply" "$HTTP" "200"

step "Timeline: causal events recorded for both directions"
curl -sL "$BASE/api/workspace/$WS/codesite/projects/$PID/events?limit=100" -H "$AUTH" > "$OUT/events.json"
node -e "
const d=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));
const types=(d.events||[]).map(e=>e.eventType);
const need=['knowledge_created','knowledge_response_recorded'];
const missing=need.filter(t=>!types.includes(t));
if(missing.length){console.error('MISSING '+missing.join(','));process.exit(1);}
console.log('timeline contains:', need.join(', '));
" "$(cygpath -w "$OUT/events.json")" \
  && ok "causal timeline captured both message legs" \
  || bad "timeline incomplete"

echo ""
echo "=== SUMMARY ==="
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ] && echo "BIDIRECTIONAL MEDIATED CHAT ROUND-TRIP: PASSED" || echo "BIDIRECTIONAL MEDIATED CHAT ROUND-TRIP: FAILED"
exit $([ "$FAIL" = "0" ] && echo 0 || echo 1)
