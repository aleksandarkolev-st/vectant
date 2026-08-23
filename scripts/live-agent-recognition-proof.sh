#!/usr/bin/env bash
# Live proof: automatic agent recognition. Two agents owned by DIFFERENT users,
# launched from different terminals in the SAME shared collaboration session
# (the plan §9 model), automatically see each other in their briefings.
set -uo pipefail
BASE="http://localhost:3000"; WS="acme-recog"
CT=$(grep -E '^SYNTHI_CODESITE_TOKEN=' .env.local | head -1 | cut -d= -f2-)
AUTH="Authorization: Bearer $CT"; JSON="Content-Type: application/json"
STEP() { printf '\n=== %s ===\n' "$*"; }
jget() { node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const o=JSON.parse(d);const v=process.argv[1].split('.').reduce((a,k)=>a==null?a:a[k],o);console.log(v==null?'':(typeof v==='object'?JSON.stringify(v):v));}catch(e){console.log('')}})" "$1"; }

STEP "A. Shared project + members (Alice owner, Ben guest)"
RESP=$(curl -s -X POST "$BASE/api/workspace/$WS/codesite/projects" -H "$AUTH" -H "$JSON" -d '{"title":"Recognition proof","request":"peers"}')
PID=$(printf '%s' "$RESP" | jget project.id); echo "project=$PID"
curl -s -X POST "$BASE/api/workspace/$WS/codesite/projects/$PID/members" -H "$AUTH" -H "$JSON" -d '{"userId":"user-alice","role":"owner"}' >/dev/null
curl -s -X POST "$BASE/api/workspace/$WS/codesite/projects/$PID/members" -H "$AUTH" -H "$JSON" -d '{"userId":"user-ben","role":"agent"}' >/dev/null

# ONE shared collaboration session (same Vectant session per plan §9.1),
# separate terminals and provider sessions per participant.
COLLAB="collab-SHARED-$RANDOM"

ATTACH() {
cat <<EOF
{"collaborationMembershipVerified":true,"ownerUserId":"$1","collaborationUserId":"$2","effectiveWorkspaceUserId":"$3","collaborationSessionId":"$4","terminalSessionId":"$5","runtimeScope":"workspace:$WS","agentProvider":"$6","providerSessionRef":"$7","displayCallsign":"$8","capabilities":["codesite.context.read","codesite.inbox.read","codesite.events.read"],"subscriptions":["project.events"]}
EOF
}

STEP "B. Alice opens terminal + Codex in the shared session"
RESP=$(curl -s -X POST "$BASE/api/workspace/$WS/codesite/projects/$PID/agent-sessions/attach" -H "$AUTH" -H "$JSON" \
  -d "$(ATTACH user-alice member-alice eff-alice "$COLLAB" term-shared-a codex prov-r-a-$RANDOM CODEX-R-A)")
SID_A=$(printf '%s' "$RESP" | jget session.id); TOK_A=$(printf '%s' "$RESP" | jget agentAccessToken)
echo "alice=$SID_A"

STEP "C. Ben opens a SEPARATE terminal + Claude in the same shared session"
RESP=$(curl -s -X POST "$BASE/api/workspace/$WS/codesite/projects/$PID/agent-sessions/attach" -H "$AUTH" -H "$JSON" \
  -d "$(ATTACH user-ben member-ben eff-ben "$COLLAB" term-shared-b claude prov-r-b-$RANDOM CLAUDE-R-B)")
SID_B=$(printf '%s' "$RESP" | jget session.id); TOK_B=$(printf '%s' "$RESP" | jget agentAccessToken)
echo "ben=$SID_B"
[ -n "$TOK_A" ] && [ -n "$TOK_B" ] || { echo 'FAIL: missing tokens'; exit 1; }

STEP "D. AUTOMATIC RECOGNITION via relevant-context peerAgents"
PEERS_A=$(curl -s "$BASE/api/workspace/$WS/codesite/agent-sessions/$SID_A/relevant-context" -H "Authorization: Bearer $TOK_A")
printf '%s' "$PEERS_A" > "$LOCALAPPDATA/Temp/peers_a.json"
PEERS_B=$(curl -s "$BASE/api/workspace/$WS/codesite/agent-sessions/$SID_B/relevant-context" -H "Authorization: Bearer $TOK_B")
printf '%s' "$PEERS_B" > "$LOCALAPPDATA/Temp/peers_b.json"
node -e "
const fs=require('fs');
const a=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const b=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const sidA=process.argv[3], sidB=process.argv[4];
const pa=a.peerAgents||[], pb=b.peerAgents||[];
console.log('CODEX-R-A peers:', JSON.stringify(pa.map(p=>p.callsign+'@'+p.ownerUserId)));
console.log('CLAUDE-R-B peers:', JSON.stringify(pb.map(p=>p.callsign+'@'+p.ownerUserId)));
if(!pa.some(p=>p.id===sidB)){ console.error('FAIL: alice does not recognize ben'); process.exit(1); }
if(!pb.some(p=>p.id===sidA)){ console.error('FAIL: ben does not recognize alice'); process.exit(1); }
console.log('PASS: automatic mutual recognition across owners/providers/terminals');
" "$(cygpath -w "$LOCALAPPDATA/Temp/peers_a.json")" "$(cygpath -w "$LOCALAPPDATA/Temp/peers_b.json")" "$SID_A" "$SID_B" || exit 1

STEP "E. Public radar roster: distinct owners, no private refs"
PROJ=$(curl -s "$BASE/api/workspace/$WS/codesite/projects/$PID" -H "$AUTH")
printf '%s' "$PROJ" > "$LOCALAPPDATA/Temp/radar.json"
node -e "
const fs=require('fs');
const d=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const sessions=(d.project&&d.project.agentSessions)||[];
const owners=new Set(sessions.map(s=>s.ownerUserId));
console.log('roster:', sessions.map(s=>s.displayCallsign+'@'+s.ownerUserId).join(', '));
if(sessions.length<2 || owners.size<2){ console.error('FAIL: roster incomplete'); process.exit(1); }
if(/prov-r-/.test(JSON.stringify(sessions))){ console.error('FAIL: provider refs leaked'); process.exit(1); }
console.log('PASS: multi-owner roster visible without private bindings');
" "$(cygpath -w "$LOCALAPPDATA/Temp/radar.json")" || exit 1

STEP "RESULT: AUTOMATIC RECOGNITION PASSED END TO END"
