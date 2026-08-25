---
area: synthi-ui
scope: synthi/src/{components,hooks,context,redux,themes}
files_covered: 467 (components 398 / hooks 38 / context 2 / redux 16 / themes 13)
generated: 2026-08-25
method: full enumeration (os.walk) + batch head-reads + import/hook/selector extraction for every file
---

# Area: synthi UI — Components · Hooks · Context · Redux · Themes

Exhaustive inventory and analysis of the `synthi/src` front-end surface. Every component group and every hook file is listed with what it renders/does, what state it owns vs receives, which services/libs it calls, and where its data comes from.

## 0. Scope & method

- **Enumerated**: `synthi/src/components` (398 files, 21 subdirectories + 22 root files), `synthi/src/hooks` (38), `synthi/src/context` (2), `synthi/src/redux` (16), `synthi/src/themes` (13).
- **Per-file signal extraction**: import graph (`@/services/*`, `@/lib/*`, local hooks), custom-hook usage, `useSelector` slices touched, exports, head comments. Test files (`*.test.*`, `*.spec.*`) are marked rather than described in depth.
- **Deep dives** (multi-paragraph): AIChatWindow + chat rail/hooks, CodeSitePanel, docking-wm window manager, Dojo dashboards, AgentWorkflowPanel, SCM/git redesign, healing subsystem, editor-integration surfaces (FileTree / TerminalPane / StatusBar / TopNav live under `app/workspace/` but own most component wiring).
- Line refs are `file:LNN` anchors verified against current sources.

## 1. Architecture overview

Synthi is a **Next.js App Router client-side IDE** ("Vectant console"). The workspace route `app/workspace/[slug]/page.jsx:L377` is the mega-composer that mounts everything else:

```
app/workspace/[slug]/page.jsx
├── ThemeProvider ─ SessionTokenHydrator ─ StoreHydrator ─ WorkspaceHydrator
├── ProactiveAnalysisProvider            (components/analysis)
├── DockableWorkspace                    (components/docking-wm) ← the shell
│   ├── DockingActivityBar               (left edge, panel toggles)
│   ├── LayoutRenderer → SplitContainer/TabGroup → PanelContainer
│   │      └── panel-wrappers.jsx resolves panel type → real component:
│   │          Explorer(FileTree) · Editor(Monaco) · Terminal(TerminalPane)
│   │          Chat(AIChatWindow) · AgentWorkflows · CodeSite · Problems · Search …
│   ├── FloatingWindow / PopoutWindow    (detached panels, BroadcastChannel sync)
│   └── WorkspaceProfileManager / LayoutPresetPicker
├── TopNav (+ EditorTabStrip, CollabToolbar)
├── StatusBar (healing indicator, presence, branch, compile manifest)
└── overlays: ThemePicker/ThemeCreator, NewProjectPicker, ErrorOverlay,
              HMRStatusIndicator, GlobalErrorHandler, HealingToast …
```

**Layering**

1. **Redux store** (`redux/store.js`) — 10 slices: `workspace`, `ui`, `git`, `extensions`, `theme`, `layout` (docking-wm), `healing`, `pr`, `compileManifest`, `ports`. Typed hook aliases in `redux/hooks.js`.
2. **Services layer** (`@/services/*`, outside this area but heavily referenced): `api`, `gitClient`, `prClient`, `collabClient` (Yjs/WebSocket), `collabSessionService`, `sseClient`, `analyzerGatewayClient`, `compilerClient`, `dojoClient`, `programSessionClient`, `programsClient`, `integrationsClient`, `runtimeScope`, `userIdentity`, `VirtualFileSystem`, `fileCache`, `monacoDiagnosticsAdapter`, `runtimeErrorInterceptor`, `lspRegistry`, `vscodeTunnelService`.
3. **Hooks** (`hooks/`, plus nested `components/chat/hooks/` and `components/docking-wm/hooks/`) — all side-effectful orchestration lives here, not in components.
4. **Components** — mostly presentational or thin controllers; they read Redux via selectors, receive props from `page.jsx` or panel wrappers, and delegate behavior to hooks/services.
5. **Themes** — JSON theme documents validated by `themes/theme-schema.js`, applied to CSS custom properties by the theme engine (`@/lib/theme-engine`).

**Data ingress patterns**: REST fetch wrappers (`codesiteClient.js`, `programsClient.js`, `integrationsClient.js`, `dojoClient`), SSE streams (`sseClient`: healing stats, code-intel metrics, workspace presence, CodeSite 36 event types), WebSocket PTY (terminal via collab-server), Yjs awareness (presence/file presence), window CustomEvents (`synthi:compile-manifest`, `synthi:pre-compile-heal`, `synthi:program-output`, `synthi:build-log`, layout undo), localStorage persistence (UI prefs, tabs per slug, layouts, themes, healing config).

## 2. Component inventory

### 2.1 `components/` root — app-shell chrome (22 files)

| File | ~L | Role | State & data |
|---|---|---|---|
| `DraggableVideoWidget.jsx` | 322 | Draggable GUI-preview video widget (run-in-GUI mode); position persisted in `guiConfig`. | Receives `guiConfig/setGuiConfig/isGuiRunning/isHmrRecompiling` props from page.jsx; owns only drag offset state. |
| `EditorPaneHeader.jsx` | 74 | Thin strip between navbar and an editor pane when split (≥2 panes): pane number in palette color + breadcrumb. | Reads pane identity from `useWorkspacePanelContext` + docking layout selectors; dispatches nothing. |
| `EditorTabStrip.jsx` | 483 | Click-only horizontal file-tab strip living in the TopNav row; deliberately NOT part of docking drag (splits via context menu/shortcuts only). | Tabs come from `workspace.openFiles` + docking editor-pane projection (`docking-wm/utils/editor-panes.js`); dispatches `selectFileThunk`/close-tab actions. |
| `ErrorOverlay.jsx` | 913 | Vectant recovery overlay for compile/runtime errors: source snippet, `file:line`, suggestions, quick-fix buttons (`QUICK_FIX_TYPES` incl. add-include), dismiss. | Subscribes to preview-store error state (`@/lib/preview-store`, `diagnostics-normalizer`, `preview-lifecycle`); quick fixes dispatch into editor. |
| `ExtensionDebugPanel.jsx` | 326 | Dev-only playground that activates a bundled hello-world extension against the extension host. | Owns local log buffer; drives `useExtensions()` API directly. |
| `ExtensionPanel.jsx` | 401 | Phase-F user surface: installed-extension list with status, recent errors, enable/disable/uninstall, health badges; exports `ExtensionStatusIndicator`. | Reads `state.extensions` (extensionSlice); actions call the extensions API from `useExtensions`. |
| `GlobalErrorHandler.jsx` | 60 | Swallows benign Monaco `'Canceled'` promise rejections globally; forwards the rest. | No state; window-level listeners only. |
| `HMRStatusIndicator.jsx` | 464 | Next-dev-style pill showing HMR status (applied/in-progress/full-reload-needed/failed/GPU mode). | Derives from preview-store/HMR runtime (`preview-lifecycle`, `preview-store`); no Redux. |
| `NativeContextMenuGuard.jsx` | 47 | Suppresses the native browser context menu workspace-wide unless a custom menu already handled the event. | Stateless listener. |
| `NewProjectPicker.jsx` | 595 | Scaffold-mode modal (empty workspace) listing project templates; "Other" tile opens build-brief input → dispatches `synthi:jumpstart` window event; also picker-provider pattern. | Templates from `@/lib/project-templates`; writes via `scaffoldProjectThunk`; exposes `useNewProjectPicker` context. |
| `RenderBoundary.jsx` | 59 | `React.memo` isolation wrapper (`withRenderBoundary` HOC) to sever re-render cascades from wide Redux selectors. | Stateless. |
| `SessionTokenHydrator.jsx` | 91 | Bridges NextAuth `session.githubToken` into the in-memory githubToken cache so non-React modules (thunks, prClient) can read it; mirrors into `pr.hasToken`. | Reads session; dispatches prSlice token flag. |
| `SettingsPanelContent.jsx` | 869 | Shared settings body used by legacy sidebar AND docking SettingsPanelWrapper: auto-save, AI auto-complete, theme-picker launch, GitHub PAT management, status-island prefs. | Reads/writes `ui` slice toggles + `statusIslandPreferences` lib; session for PAT. |
| `StatusIslandPresetDialog.jsx` | 117 | Save/delete dialog for StatusBar "status island" dock presets. | Persists via `statusIslandPreferences` lib. |
| `StoreHydrator.jsx` | 32 | Hydrates global UI prefs from localStorage on mount (workspace-specific tabs deferred to WorkspaceHydrator). | Dispatches uiSlice rehydrate. |
| `SynthiException.js` | 19 | Tiny `Error` subclass carrying `{title, description}`. | — |
| `ThemeCreator.jsx` | 1144 | Full-screen theme authoring overlay: type selector, progress, live swatch grid, contrast checks; exports `useThemeCreator` provider hook. | Writes user themes into `themeSlice.userThemes`/overrides; uses `theme-engine`, `contrast-utils`, `theme-creator-schema`. |
| `ThemeEditorPanel.jsx` | 290 | Dock-compatible panel editing `themeSlice.userOverrides[activeThemeId]` via Monaco JSON editor + color-swatch grid. | Two-way with themeSlice; Monaco for raw JSON. |
| `ThemePicker.jsx` | 529 | Full-screen theme chooser overlay (two columns, type-to-filter, arrow navigation); `useThemePicker()` opens it programmatically. | Lists builtin+user themes from themeSlice. |
| `ThemeProvider.jsx` | 134 | Registers builtins, hydrates persisted theme, subscribes to `activeThemeId/previewThemeId`, applies resolved theme to DOM; exposes `useTheme()`. | Root of theming; reads themeSlice. |
| `WorkspaceHydrator.jsx` | 57 | After slug is known, restores that workspace's open tabs + active tab from localStorage keys `synthi:openTabs:<slug>`. | Reads `workspace.slug`; dispatches workspace restore. |
| `WorkspaceNotFoundModal.jsx` | 45 | "Workspace not found" modal with redirect home. | Router only. |

Ref: `synthi/src/components/EditorTabStrip.jsx:L17`, `synthi/src/components/ErrorOverlay.jsx:L18`, `synthi/src/components/ThemeProvider.jsx:L53`.

### 2.2 `components/agent-workflows` (2 files)

**AgentWorkflowPanel.jsx (1918L)** — the browser-agent workflow cockpit, embedded in the docking shell via `AgentWorkflowsPanelWrapper` (see `panel-wrappers.jsx`). Pure controlled/presentational design:

- Exports `WORKFLOW_ACTIONS` (`AgentWorkflowPanel.jsx:L25`): frozen map of agent tool-call names the host can invoke — attach-workspace, observe preview, begin/end teach, run checkride, configure auth, source mapping, compile contract, mutation plan, replay isolation profile, prefix validation, CI isolated replay, generate script, generate manifest, publish skill.
- Props: `{ workspaceSlug, workflowState, onWorkflowAction, isBusy }` — **all domain state arrives from the parent** (`page.jsx` wires `onWorkflowAction` to the agent workflow client); the panel owns only view-local state: `localRecording`, `activeAgentMode` ('plan'), `activeWorkflowSection` ('runbook'), `selectedStageId` (`AgentWorkflowPanel.jsx:L1683`).
- Normalizes incoming state through `normalizeWorkflowPanelState` → derives summary via `deriveWorkflowPanelSummary`; four sections (Runbook / Trace / Hardening / Dojo) rendered from a memoized model; framer-motion with `useReducedMotion`.
- `AgentWorkflowPanel.test.jsx` (541L) covers the view-model functions.

Data source: parent-injected workflow state; no direct service calls from the panel itself (the wrapper imports `agentWorkflowClient`, `agentWorkflowDojoAudit`, `agentWorkflowHandoff`).

Ref: `synthi/src/components/agent-workflows/AgentWorkflowPanel.jsx:L25,L1683`.

### 2.3 `components/analysis` (6 files)

Proactive-analysis feature (VS Code–style Problems):

| File | ~L | Role | State & data |
|---|---|---|---|
| `AnalysisPanel.jsx` | 206 | Generic analysis result panel w/ refresh, offline badge, context-menu actions. | Fetches via `analyzerGatewayClient`; local status state. |
| `ProactiveAnalysisProvider.jsx` | 360 | Context provider owning proactive-analysis lifecycle: debounced analysis on file change, Monaco markers/decorations, problems-panel feed, enable/disable settings. | Owns analysis state in React context (`useProactiveAnalysisContext`); delegates engine to `hooks/useProactiveAnalysis`; markers via `monacoDiagnosticsAdapter`. |
| `ProactiveAnalysisStatus.jsx` | 384 | Status-bar badge / floating pill / inline variants (idle, analyzing, error counts, gateway connection). | Consumes provider context only. |
| `ProblemsPanel.jsx` | 1027 | Dockable problems list: severity icons, file/line, click-to-navigate, severity+tier filters, realtime updates. | Data from provider context + `ruleEngine` lib; dispatches navigation. |
| `ProvenanceOverlay.jsx` | 486 | Overlay querying `/api/provenance` for AI provenance evidence of a file/selection; confirm-guarded actions. | Direct fetch to `/api/provenance` (`DEFAULT_AI_ENGINE_BASE`); local response cache. |
| `index.js` | 22 | Barrel exporting provider/context/status/panel. | — |

Ref: `synthi/src/components/analysis/ProactiveAnalysisProvider.jsx:L1`.

### 2.4 `components/chat` (35 files) — the AI chat rail

#### Deep dive: `AIChatWindow.jsx` (1831L)

The main chat surface, mounted both as a floating overlay and as a docking panel (`ChatPanelWrapper`).

- **Props received**: `onClose, onDockRight, isVisible, activeFile, currentCode/getCurrentCode, editor, docked, onSuggest, onBusy, clearSignal, initialPrompt, initialAttachments` — the editor hands it the live buffer so FILE:-block patches apply to unsaved content.
- **State ownership**: conversation sessions via `useChatSessions` (id/title/messages/suggestedCode/showDiff per session, created locally); composer value via `useChatInput`; attachment list via `useChatAttachments`; the send pipeline via `useAISuggestions`; context assembly via `useContextWindow`; optional multi-agent pipeline via `useAgentPipeline`; code-intel metrics chip via `useCodeIntelMetrics`.
- **Redux**: `useAppSelector(state.workspace.slug / rawFiles)`; subscribes directly to `store` to mirror `workspace.fileContentCache` entries into a ref for attachment payloads (`AIChatWindow.jsx:L118`); dispatches `selectFileThunk`, `setExternalFileContent`, `fetchFilesThunk`, `setShowTerminal` when applying suggested changes.
- **Rendering pipeline**: messages rendered through `formatMessage.formatMessageContent` → `MessageContent` → Shiki-highlighted `CodeBlock` with clickable file/method refs; diffs through `diffUtils.renderDiffChunkList/diffStats`; timeline cards: `CommandApprovalCard` (permission request), `MultiverseCard` (shadow verify universes), `ArbiterCard` (cross-universe verdict), `ReasoningCard` (live thinking timeline), `RegressionFindingsCard`; empty state = `ChatEmptyState` orb hero + `SuggestionChips` below composer; session switcher = `ChatRail` (wide) or `ChatSessionDropdown` (narrow).
- **Identity**: `VectantOrb.jsx` renders the brand orb as a WebGL fragment shader (liquid gradient morph, 2·3·4 harmonics) with CSS fallback in `chat.css`.

#### Chat sub-components

| File | ~L | Role |
|---|---|---|
| `ArbiterCard.jsx` | 173 | Wave-2+ verdict card: single winner + confidence; <0.6 shows "arbiter uncertain"; convergence swaps to Consensus card. Driven entirely by `useShadowVerify(jobId)`. |
| `ChatEmptyState.jsx` | 44 | First-run hero: idle orb + exported `SUGGESTIONS`/`SuggestionChips`. Static. |
| `ChatRail.jsx` | 84 | Slide-in "Rail + Stream" drawer (wide surfaces): session list, New chat, footer slot for DiagnosticsDrawer; collapsed by default. Receives sessions/onSelect. |
| `ChatSessionDropdown.jsx` | 64 | Narrow-surface header session switcher replacing the rail; controlled-open menu. Props-only. |
| `CodeBlock.jsx` (utils/) | 150 | Shiki syntax-highlighted code block; maps language aliases; theme-aware via `useTheme`. |
| `CommandApprovalCard.jsx` | 119 | Inline card when AI requests terminal-command execution; approve/deny wired by parent; Vectant card chrome `.vx-rcard`. |
| `CounterfactualControls.jsx` | 147 | Retention/policy controls for counterfactual telemetry; queries `/api/counterfactual/…` with `workspace_path` + task class. |
| `CounterfactualInspection.jsx` | 56 | Read-only inspection of durable counterfactual evidence (compact, no source content). Same API base. |
| `DiagnosticsDrawer.jsx` | 120 | Collapsible drawer consolidating power-user chips (code-intel metrics, shadow spend, regression findings) out of the chat header. Composition-only. |
| `MessageContent.jsx` (utils/) | 49 | Segments message into prose vs fenced code; delegates to CodeBlock; optional ref-click navigation. |
| `MultiverseCard.jsx` | 206 | N-universe verify panel for a shadow job: stage labels, proof/selection/policy state. All via `useShadowVerify`. |
| `ProviderLogos.jsx` | 127 | Simplified brand marks (Anthropic/OpenAI/Gemini/sparkles) + `PROVIDER_OPTIONS`, `getProviderMeta` for the model picker. Static. |
| `ReasoningCard.jsx` | 140 | Live vertical thinking timeline off one `progress` message; collapses to one-line summary when finished. |
| `RegressionFindingsCard.jsx` | 84 | Continuous-shadow pass→fail findings with "look at this" action; dismiss per-session. Uses `useContinuousFindings`. |
| `ShadowCostPanel.jsx` | 210 | Shadow-verify cost dashboard: est. cost, daily cap (inline-editable), spent today, 30-day sparkline; self-refreshes 30 s against `/api/shadow/cost`. |
| `StalenessBadge.jsx` | 38 | Amber badge while a shadow job runs and the user edits in-flight files. Via `useShadowVerify` + editedFiles prop. |
| `ThinkingDots.jsx` | 21 | Three staggered dots. Static. |
| `VectantOrb.jsx` | 228 | WebGL morphing gradient orb (brand identity). Canvas + shader, no app state. |
| `chat.css` | 914 | Scoped chat styling: orb frame/glow/bloom, fallback, chat surface classes. |

#### Chat utils

| File | ~L | Role |
|---|---|---|
| `utils/diffUtils.js` | 560 | Diff engine for AI patches: `computeDiffChunks` (line diff → renderable rows), fence stripping, FILE:-block parsing/validation, search-replace apply (full + partial), replace-content extraction. Pure functions; consumed by useAISuggestions + AIChatWindow. |
| `utils/formatMessage.js` | 258 | Regex segmentation of AI prose into clickable file refs / method refs / inline code / fences. Pure. |
| `utils/fileSuggestionsUtils.js` | 30 | Status→class/label maps for file suggestion pills (saving/applied/error). Pure. |
| `utils/CodeBlock.jsx` / `utils/MessageContent.jsx` | see above | — |

#### Chat hooks (`components/chat/hooks/`)

| Hook | ~L | Owns | Receives | Calls |
|---|---|---|---|---|
| `useAISuggestions.js` | 2607 | Whole suggestion lifecycle: intent classification, prompt building, streaming response handling, FILE:-block extraction, diff application, multi-file payload, error surfacing. | Editor getters, workspace files (from caller), notebook context serializer. | `/api/classify/intent` (2 s timeout, heuristic fallback with safety-net override to 'change', `L42`), `api` service, `getWorkspaceRuntimeIdentity`, `serializeNotebookContext`; dispatches `selectFileThunk/setExternalFileContent/fetchFilesThunk/setShowTerminal`; composes `useContextWindow` + `useAgentPipeline`. |
| `useAgentPipeline.js` | 821 | Multi-agent orchestration loop: coordinator spawns Reader/Searcher/Analyzer/Planner sub-agents, merges results, synthesizer produces final answer. Modes `direct/auto/plan/research` (`PIPELINE_MODES`, L87); `AGENT_REGISTRY` defines capabilities/tools. | Context window contents. | `@/lib/agent-routing/agent-context-budget`, `agent-pipeline-routing`. |
| `useContextWindow.js` | 507 | Sliding context window: token counting/estimates, summarization of old messages, recency prioritization, budget enforcement. | Message list from caller. | Pure/local heuristics. |
| `useChatSessions.js` | 84 | Local session array CRUD (`chat-<ts>-<rand>` ids, title, messages, suggestedCode, showDiff). | — | None (localStorage-free; ephemeral). |
| `useChatInput.js` | 26 | Composer string + submit guard. | onSubmit callback. | None. |
| `useChatAttachments.js` | 205 | Attachment staging: drag-drop, size cap (120 KB inline to avoid gateway timeouts), conversion to prompt payloads from file-cache entries or raw files. | fileCacheEntries/getter, rawFiles. | None directly. |
| `useContinuousFindings.js` | 86 | Polls `/api/shadow_continuous/state`; returns latest pass→fail regression findings (polling not SSE — infrequent events). | workspacePath. | fetch. |
| `useShadowVerify.js` | 269 | SSE subscription to `/api/shadow/[jobId]/stream`; reduces universe states, learned lines, policy deltas/hints, direction forecast; exports pure `reduce/applySelectionResult/learnedLinesFromPayload` for tests. | jobId. | EventSource stream. |

Tests colocated: `CounterfactualControls.test.jsx`, `CounterfactualInspection.test.jsx`, `MultiverseCard.test.jsx`, `useShadowVerify.test.mjs`.

Ref: `synthi/src/components/chat/AIChatWindow.jsx:L92`, `synthi/src/components/chat/hooks/useAISuggestions.js:L157`.


### 2.5 `components/codesite` (73 files) — CodeSite control-tower panel

#### Deep dive: `CodeSitePanel.jsx` (1530L)

The "airport/control tower" metaphor panel for governing agent work in a workspace. Mounted as a docking panel (`CodeSitePanelWrapper`).

- **Props**: `{ workspaceSlug }` only — everything else self-fetched.
- **Data ingress**: `codesiteClient.js` (`L1`, `BASE = '/api/workspace'`) exposes fetchers (`fetchCodeSiteProjects/Project/DeploymentStatus/ControlState/Events…`) plus `subscribeCodeSiteProjectEvents` — an **SSE-first** stream of **36 named event types** (tower_instruction, holding_pattern, ground_stop, mayday, clearance_*, transaction_*, policy_delta_*, quarantine_*, inspection_result, shadow_run…). Core state refresh on arrival is debounced 400 ms; a 30 s poll is only the dropped-stream safety net; Evidence view keeps a dedicated 5 s cadence because no event type announces metric recomputation (`CodeSitePanel.jsx:L65`).
- **State ownership**: `selectedProjectId`, composite `radarState` (normalized via `normalizeCodeSiteRadarState`), per-view slices held apart from core so a core refresh can't wipe them (metrics/artifactPreview/quarantines/quarantineError, `EMPTY_VIEW_SLICES` L100), deployment status.
- **Actions**: governance mutations through lib builders — `applyCodeSiteRouteRevision`, `applyCodeSiteQuarantine`, `createCodeSiteProject`, `exportCodeSiteArtifacts`; five queue-governance action payloads extracted into shared builders (`lib/governanceActions.js`: documentReviewAction, routeReviewAction, routeApplyAction, maydayResumeAction) so console buttons and required-action path share identity (locked by `payloadIdentity.test.js`).
- **Navigation**: ten sections grouped by `lib/sectionGroups.js` (`SECTION_GROUPS`, `groupForSection`, four-tile CommandStrip over sub-view strip); test-id set is a locked contract enforced by `testIdInvariant.test.js` across the split from the old 9k-line monolith.

**Client & libs**

| File | ~L | Role |
|---|---|---|
| `codesiteClient.js` | 557 | REST + SSE client; `CODE_SITE_LIVE_EVENT_TYPES` frozen list; empty-radar-state factory; normalizer. |
| `lib/format.js` | 644 | `asArray/compact/uniqueValues`, percent/duration/metric formatters, product copy. |
| `lib/governance.js` | 184 | Document/route/incident predicates and labels (needs-review, can-review, can-apply, resume refs). |
| `lib/governanceActions.js` | 151 | Action payload builders + review-candidate resolution. |
| `lib/graph.js` | 203 | Zone naming/classing, path pattern segmentation, glob-overlap detection for topology graph. |
| `lib/quarantine.js` | 422 | Quarantine path/digest/evidence-ref derivation, applied vs remaining paths, display status. |
| `lib/sectionGroups.js` | 88 | Ten sections → four groups mapping with summaries. |
| `lib/motion.js` | 4 | Shared easing curves so moved components keep identical motion. |
| `icons.js` | 56 | Curated lucide icon re-exports (`CodeSiteIcons`). |

**Nav** (`nav/`): `CommandStrip.jsx` (first nav level, container-query driven since docks have independent width), `DesktopSectionRail.jsx`, `MobileSectionTabs.jsx`, `ViewStrip.jsx` (second level; carries locked test ids).

**UI primitives** (`ui/`): `EmptyLine`, `IconButton`, `JsonPreview`, `LoadingSkeleton`, `Metric`, `OperatorPane`, `PathList`, `Pill`, `Row`, `Section`, `SignalBar`, `StatusRailItem`, `TagList` (+ `ui/index.js`). Small presentational atoms styled off theme CSS vars; several honor `useReducedMotion`.

**Views** (`views/`), each receiving its slice of radar state as props:

| View file | ~L | Renders / data |
|---|---|---|
| `OverviewView.jsx` (+ `overview/CodeSiteOperatingModel.jsx` 162, `overview/DeploymentStatusCard.jsx` 102, `overview/TowerNowStrip.jsx` 214, `overview/MetricRow.jsx` 47, `overview/MetricsGroup.jsx` 23) | 291 | Saved-view queues whose row membership is structural (`CodeSiteOperatingModel`); control-plane health checklist; live tower strip; metric rows/groups. Fed by radar-state props + lib/format. |
| `ActivityView.jsx` → `activity/TowerStreamPanel.jsx`, `BlackBoxFlightRecorder.jsx` | 120/187/125 | Live event feed (stream status aware) + event-type histogram flight recorder. |
| `GovernanceView.jsx` → `governance/GovernanceConsole.jsx`, `GovernanceReviewGate.jsx` | 169/670/107 | Permit drafts, RFIs/change orders/policy deltas; review gate demands ≥12-char rationale before confirm. |
| `GraphView.jsx` → `graph/ScopeTopology.jsx`, `WorkGraphNode.jsx`, `WorkGraphConnector.jsx` | 226/575/52/47 | Zones/no-fly-zones/flights/risks topology with collision forecast; motion-aware connectors. |
| `LocksView.jsx` → `locks/RunwayOccupancyBoard.jsx`, `PilotLicenseHealthPanel.jsx` | 151/91/148 | Path locks ("runways"), leases, allowed/blocked paths, agent readiness records. |
| `InspectionsView.jsx` | 150 | Inspection runs + incidents table. |
| `ReplayView.jsx` → `replay/CausalReplayDeck.jsx`, `LineProvenanceDeck.jsx`, `handovers.js` | 64/209/313/59 | Replay packages closed from incidents (replay digest); line-level provenance rows w/ selected transaction+lease+proof detail. |
| `SimulatorView.jsx` → `simulator/TowerSimulatorDeck.jsx`, `AssumptionInvalidatorPanel.jsx` | 49/297/123 | Shadow-run tower simulation decks, universe selection, assumption invalidation. |
| `EvidenceView.jsx` → `evidence/SuccessMetricsDeck.jsx`, `SerializableIsolationDeck.jsx`, `MetricScorecard/Row/MetricsGroup` | 134/131/302/55 | Success metrics watchlist sorted by attention score; serializable-isolation transactions/proof bundles. |
| `QuarantineView.jsx` → `quarantine/QuarantineReviewPanel.jsx`, `FilesystemBoundaryProofPanel.jsx`, `ProofValueList.jsx` | 76/644/165/36 | Actionable quarantine records review flow + filesystem-boundary proof evidence. |
| `ChannelsView.jsx` (`channels/`) | 325 | Registered direct agent channels with open/accept/reject/close buttons (no curl); calls codesiteClient channel endpoints; needs session identity. |
| `knowledge/SharedKnowledgePanel.jsx` | 567 | Tabs of discoveries/decisions shared into project knowledge; empty-state per tab kind. |

Tests: `CodeSitePanel.test.jsx` (1560L), `SharedKnowledgePanel.test.jsx`, `codesiteClient.test.js`, `sectionGroups.test.js`, `governanceActions.test.js`, `payloadIdentity.test.js`, `testIdInvariant.test.js`.

Ref: `synthi/src/components/codesite/CodeSitePanel.jsx:L65,L173,L100`, `synthi/src/components/codesite/lib/governanceActions.js:L1`.

### 2.6 `components/collaboration` (10 files)

| File | ~L | Role | State & data |
|---|---|---|---|
| `CollabToolbar.jsx` | 367 | Top-bar widget: presence avatars popover, bell notifications, Share2 entry to unified ShareModal. | `useCollabSession` + `usePresence`; services `collabSessionService`, `userIdentity`. |
| `FileVersionsPanel.jsx` | 934 | Per-file version history with Shiki-highlighted diffs between versions; restore actions. | `collabSessionService` history API; extension→language map kept in sync with chat CodeBlock; `collab-url` lib. |
| `GuestBanner.jsx` | 152 | Thin top bar for guests/knockers: kicked/terminated/denied alerts (dismissable), knocking/active status strip; exports guest border effect. | Session role from `useCollabSession`. |
| `MissedEventsTray.jsx` | 282 | Popover tray of up to 25 missed collaboration events while away. | Replayed events from `collabSessionService`. |
| `PresenceList.jsx` | 141 | Google-Docs-style avatar bar; colored borders = awareness colors; right-click menu per user (follow etc.). | `usePresence` (Yjs awareness); dispatches follow actions. |
| `SessionControlPanel.jsx` | 407 | Host controls: join link + copy, permission toggles (terminal/git/file-edit/folder-edit), kick, radio broadcast, session lifecycle. | `useCollabSession` actions; local expand/collapse. |
| `ShareModal.jsx` | 621 | Unified share/session management modal: invite link, permissions matrix, participants, knock approvals, leave/end. | `useCollabSession`, session duration timer; `collabSessionService`. |
| `WorkspaceUsersPanel.jsx` | 655 | All active workspace users + their sessions; request-to-join; block/unblock. | `useWorkspacePresence` (SSE), `useBlockedUsers`, `useCollabSession`; services collabClient/collabSessionService/userIdentity. |
| `collabTheme.js` | 25 | Frozen shared palette for all three big collab surfaces. | — |

Ref: `synthi/src/components/collaboration/ShareModal.jsx:L1`, `synthi/src/components/collaboration/WorkspaceUsersPanel.jsx:L1`.

### 2.7 `components/compile` (2 files)

ULTRAPLAN Phase-8 compile-manifest UX:

- `CompileErrorCard.jsx` (233L): renders the 3-option recovery card when the AI-synthesized build manifest is rejected (multi-step build, low runner-synthesis confidence, heal exhausted). Exports `REJECTION_KINDS`; options: simpler framework switch, manual flags, retry synthesis. Receives rejection object from compileManifestSlice selectors.
- `ConfidenceWarning.jsx` (139L): pre-compile nudge when manifest confidence is MEDIUM for runner_synthesis/link_flags; lets user proceed or abort early. Props-driven.

Ref: `synthi/src/components/compile/CompileErrorCard.jsx:L1`.

### 2.8 `components/dashboard` (1)

- `AIJumpstartSection.jsx` (543L): dashboard hero section offering AI jumpstarts (new page/component/image/folder actions); opens `useNewProjectPicker`; icon-rich static config + action callbacks. Data: none beyond picker context.

Ref: `synthi/src/components/dashboard/AIJumpstartSection.jsx:L1`.

### 2.9 `components/dock` + `components/docking` — legacy docking generations

- `dock/DockLayoutManager.jsx` (755L): first VS-style docking system (docked/floating/tabbed/auto-hide, drag-detach at 8 px threshold, dock-zone previews, per-workspace persistence). Exports `useDock`, `DockLayoutProvider`, `DockablePanel`, `TabGroup`, `useDockKeyboardShortcuts`. Superseded by docking-wm but still referenced by `hooks/useDockKeyboardShortcuts`.
- `docking/DockablePanel.jsx` (720L): second generation provider/context API (`PANEL_STATE`, `DOCK_POSITION`, `useDockContext`). Still mounted by legacy `page.jsx` paths alongside DockableWorkspace.

Ref: `synthi/src/components/dock/DockLayoutManager.jsx:L1`, `synthi/src/components/docking/DockablePanel.jsx:L1`.


### 2.10 `components/docking-wm` (63 files) — the active window manager

#### Deep dive

A complete docking window manager: normalized flat-tree layout model in Redux (`state.layout`), HTML5 drag-and-drop tab tearing, floating windows, browser popouts, presets, profiles, undo/redo, keyboard navigation.

**Layout state machine**

- `types.js` (188L): `NODE_TYPE` (split/tabgroup), `DIRECTION`, `DROP_ZONE`, `DOCK_POSITION`, `LAYOUT_VERSION`, `MIN_PANEL_SIZE`, `DEFAULT_SPLIT_RATIO`; documents the flat-map-with-parent-pointers layout (O(1) lookups, Redux-friendly).
- `utils/layout-node.js` (232L): factories — createSplitNode/createTabGroupNode/createTab/createFloatingWindow/createPopoutWindow/normalizeSizes/createDefaultIDELayout.
- `utils/layout-ops.js` (697L): pure immutable mutations — splitNode, add/remove/activate/close/moveTab, resizeSplit, toggleMaximize; consumed by the slice's reducers.
- `utils/layout-query.js` (274L): getNode/getParent/getChildIndex/getAllTabGroups/isAncestor/getPathFromRoot traversal.
- `utils/layout-validation.js` (301L): deep validation + auto-repair of dangling refs/orphans before persistence restore.
- `utils/serialization.js` (244L): serialize/deserialize/migrate by schema version; localStorage save/load/clear; profile save.
- `state/layout-slice.js` (585L): **the Redux slice `layout`** (`createSlice` at L55) delegating all tree math to layout-ops; selectors `selectLayout/selectRootId/selectNodes/selectTabs/selectNode/selectFloating/selectPopouts`; also editor-pane actions (`splitEditorPanel`, `setPaneFile`). Tests cover editor-split, floating panels, and panel multiplicity.

**React shell components** (`components/`)

| File | ~L | Role |
|---|---|---|
| `DockableWorkspace.jsx` | 239 | Drop-in replacement for the rigid ResizablePanelGroup in page.jsx: registers all IDE panels, initializes layout from storage or preset, renders DockingContainer, enables keyboard nav + history + persistence (`L75` definition). |
| `DockingProvider.jsx` | 169 | Root context provider wrapping PanelRegistryProvider + persistence wiring. |
| `DockingContainer.jsx` | 101 | Renders layout tree + floating windows; hosts global drag state. Selectors only. |
| `LayoutRenderer.jsx` | 100 | Recursive dispatch to SplitContainer / TabGroup per node type. |
| `SplitContainer.jsx` / `SplitterHandle.jsx` | 84/89 | Row/column children with pointer-drag resizable splitters (`useSplitter`, keyboard-resizable). |
| `TabGroup.jsx` | 293 | Leaf unit: TabBar + PanelContainer + DropOverlay; sidebar auto-collapse aware. |
| `TabBar.jsx` / `Tab.jsx` | 144/280 | Draggable closable tabs w/ context menu (`useDragPanel` source side). |
| `PanelContainer.jsx` | 153 | Resolves panel component from registry and renders it. |
| `ContextMenu.jsx` | 284 | Portal menu for tabs/groups: close variants, split L/R/U/D, maximize; exports `buildTabContextMenu` + shared `useContextMenu`. |
| `FloatingWindow.jsx` (+ hooks/use-floating-window.js) | 268/172 | Portal overlay windows with 8-way resize, z-order, dropdown controls. |
| `PopoutWindow.jsx` (+ use-popout.js) | 157/205 | Detached browser-window content synced over BroadcastChannel (`?tab=<id>&window=<id>` params). |
| `DropOverlay.jsx` | 128 | Translucent landing preview per drop zone. |
| `DockingActivityBar.jsx` | 486 | Activity bar wired to docking: each button toggles/opens its panel via `useActivityBarDocking`. |
| `WorkspaceProfileManager.jsx` / `LayoutPresetPicker.jsx` | 336/188 | Save/load/delete named workspace profiles; SVG-thumbnail preset grid. |
| `LayoutDebugOverlay.jsx` | 210 | Dev-only Ctrl+Shift+D tree inspector. |
| `PanelGrip.jsx` | 66 | Drag-affordance dots for title bars. |

**Panels & registry** (`panels/`)

- `panel-types.js` (32L): frozen `IDE_PANEL` constants (explorer, search, …) kept separate to avoid slice↔component cycles.
- `ide-panels.js` (309L): declarative definitions (display name, icon, default size, region, allowMultiple, serialization) → `registerAllIDEPanels()`.
- `panel-wrappers.jsx` (1258L): docking-aware wrappers bridging real components to WorkspacePanelContext — `ExplorerPanelWrapper` (FileTree), `EditorPanelWrapper` (Monaco panes), `TerminalPanelWrapper`, `ChatPanelWrapper` (AIChatWindow), `AgentWorkflowsPanelWrapper`, `CodeSitePanelWrapper`, Problems/Search wrappers. Each adds `data-panel-type` and reads shared state from context rather than prop-threading; imports agentWorkflow clients + gitClient + runtimeScope/userIdentity for its children.
- `OutputPanel.jsx` (279L): terminal-like stdout/stderr view subscribing to window events `synthi:program-output` ({type,line,sessionId}) and `synthi:build-log`.
- `layout-presets.js` (557L): Classic/Focus/SideBySide/AIAssisted/ThreeColumn factories returning normalized trees.
- Registry: `panel-registry-core.js` (JSX-free global Map so reducers can consult metadata), `panel-registry.js` (React provider + `usePanelRegistry`), `utils/panel-dedupe.js` (dedupe rules: extension-view & program-session match by instance data).
- Shared context: `context/workspace-panel-context.js` — threads workspace-level props to panel wrappers without DockableWorkspace↔panel-wrappers import cycles.

**Hooks** (`hooks/`) — see §3.2.

**Utils**: `aria.js` (WAI-ARIA tab/splitter props), `editor-panes.js` (projects editor tabgroups → ordered panes with stable numbers + PANE_PALETTE colors; feeds EditorTabStrip/EditorPaneHeader), `geometry.js` (drop-zone hit-testing + preview rects), `id-generator.js`, `panel-dedupe.js`.

Tests: `layout-ops.test.js`, three layout-slice suites, `editor-panes.test.js`.

Ref: `synthi/src/components/docking-wm/state/layout-slice.js:L55`, `synthi/src/components/docking-wm/components/DockableWorkspace.jsx:L75`, `synthi/src/components/docking-wm/panels/panel-wrappers.jsx:L255`.

### 2.11 `components/dojo` (48 files)

The Dojo: skill licensing/governance dashboards rendered under `/workspace/[slug]/dojo/*` routes. Shared visual grammar: a common `panelStyle` object (bordered gradient panel using theme CSS vars) opens nearly every file.

| File | ~L | Role | Data |
|---|---|---|---|
| `DojoShell.jsx` | 386 | Shell + nav rail (Overview/Skills/Evidence/Governance/Practice…) with abortable summary load; base hrefs per skill. | `getDojoWorkspaceSummary` from `dojoClient` (injected as `loadSummary` for tests); local loading/error/nav state. |
| `GovernanceDashboard.jsx` | 358 | Org-wide compliance: permission-upgrade reviews, case-law reviews, recertification, compliance-pack export. | dojoClient mutators (`reviewDojoPermissionUpgrade`, `recertifyDojoSkill`, `exportDojoCompliancePack`, …); org/tenant identity keys. |
| `EvidenceDashboard.jsx` | 221 | Evidence ledger metrics + drill-ins. | dojoClient. |
| `PracticeWorldDashboard.jsx` | 312 | Practice-world runs/scenarios board. | dojoClient. |
| `SkillCortexGraph.jsx` | 1394 | Interactive force-style cortex graph of skills/nodes with `GraphCanvas` export; node inspector integration. | dojoClient graph endpoints; heavy canvas math inline. |
| `SkillPassport.jsx` | 370 | Per-skill passport: coverage, proofs, revoke proof capsule action. | `getDojoWorkspaceSummary`, `revokeDojoProofCapsule`. |
| `SkillCardGrid.jsx` | 148 | Grid of licensed-skill cards with readiness/coverage. | Injected loader pattern (`loadSummary = getDojoWorkspaceSummary`). |
| `TherapeuticTomographyTrace.jsx` | 653 | Therapeutic-access runtime trace viewer; review/revoke grants. | `getTherapeuticRuntime`, `reviewTherapeuticAccess`, `revokeTherapeuticGrants`. |
| `TimeMachineDebugger.jsx` | 194 | Deterministic replay debugger panel for practice worlds. | dojoClient. |
| `CaseLawDashboard.jsx` / `CaseLawRegistry.jsx` | 118/64 | Case-law review dashboard + registry table. | `reviewDojoCaseLaw`. |
| `ConsumerSkillCard.jsx` | 140 | Consumer-facing skill card (compact lists, percent math). Props-only. |
| `CortexNodeInspector.jsx` | 283 | Detail pane for a selected cortex node. Props/state-local. |
| Smaller panels | 48–152 | `AntibodyRegistry`, `ApiCandidateReview`, `ApprovalQueue`, `AuditExportPanel`, `CheckrideReportView`, `ComplianceEvidencePack`, `EvidenceLedgerChain`, `GeneratedToolReview`, `GhostModePanel`, `GovernanceOverview`, `GuardrailProvenance`, `HumanVsAgentActionDiff`, `LicenseHealthBoard`, `PolicyGateTable`, `RecertificationQueue`, `RedactedEvidenceExportPanel`, `RefusalExplainerDrawer`, `ProofCapsuleDrawer`, `SkillRegistryTable`, `SourceAffordancePrPlan`, `SourceApiDashboard`, `SubstrateLadderView` | Mostly presentational tables/queues fed by parent dashboards or direct dojoClient calls where noted. |

13 colocated test files mock `dojoClient` + `userIdentity` and render with React act environment.

Ref: `synthi/src/components/dojo/DojoShell.jsx:L21`, `synthi/src/components/dojo/SkillCortexGraph.jsx:L33`.

### 2.12 `components/emulator` (6 files)

Mobile runtime viewer (worker-driven video stream):

- `emulatorStates.js` (41L): frozen `EMULATOR_STATES` (OFF/BOOTING/IDLE/…), pure transitions `nextStateOnPower/Home`.
- `EmulatorControls.jsx` (46L): power/home/rotate button row (props callbacks).
- `EmulatorFrame.jsx` (76L): device chrome frame; portrait/landscape or responsive sizing.
- `EmulatorScreen.jsx` (601L): screen surface incl. fake status bar; right-click menu; receives video stream element when a worker session exists.
- `EmulatorPanel.jsx` (428L): docked panel orchestrating states; deterministic standby surface without session; session truth arrives from worker events.
- `FloatingEmulatorWindow.jsx` (570L): draggable floating variant at fixed 9:19.5 aspect, integrated controls, `useReducedMotion`.

Ref: `synthi/src/components/emulator/emulatorStates.js:L1`.

### 2.13 `components/extensions` (2 files)

- `ExtensionSidebar.jsx` (1210L): sidebar view with Installed/Marketplace tabs; Open-VSX search against `/api/extensions/search`; sample-extension quick-install; drives the `useExtensions()` API.
- `ExtensionViewContainer.jsx` (581L): renders extension-contributed viewContainers (tree views, webview views) with collapsible sections + webview panels.

Ref: `synthi/src/components/extensions/ExtensionSidebar.jsx:L506`.

### 2.14 `components/git` (26 files) — Source Control

#### Deep dive: the SCM column redesign (`git/scm/*` + root files)

Legacy `GitStatus.jsx` (~1.6k lines) was decomposed into:

- `scm/SourceControlPanel.jsx` (747L): top-level container owning local UI state (commit message/body/amend, sub-view selection, ripplingPaths animation set, syncing flag, error dismissal, clone form). Services: prClient; hooks: confirm/prompt dialogs, `useFocalCardState`, session.
- `scm/BranchBridge.jsx` (128L): header — V glyph (opens BranchSelector dropdown) + branch name + ahead/behind chips + gear OverflowMenu.
- `scm/FileSections.jsx` (226L): scrollable middle: CONFLICTS → STAGED → CHANGES fixed order.
- `scm/FileRow.jsx` (239L): one file row; derives M/A/D/R/?/U badges from porcelain codes; stage/unstage/view-diff callbacks.
- `scm/FocalCard.jsx` (165L) + `scm/useFocalCardState.js` (93L): morphing "what matters now" card choosing exactly ONE of eight states via precedence ladder (no-repo → conflicts → … → clean).
- `scm/CommitComposer.jsx` (374L): sticky chat-style composer w/ gradient focus ring; `CommitTypeChips.jsx` prepends conventional-commit prefixes.
- `scm/SubViewPills.jsx` (76L): Files / History / Stashes switcher (PRs live elsewhere).
- `scm/StashList.jsx` (137L): apply/pop/drop rows.
- `scm/OverflowMenu.jsx` (182L): rare ops (fetch/pull/push/force-push, init/clone, remotes, stash all).
- `scm/scm-tokens.css` (733L): component-scoped token layer over global Vectant vars.

**Feature panels (root)**

| File | ~L | Role | Data |
|---|---|---|---|
| `BranchSelector.jsx` | 359 | Branch dropdown + checkout w/ conflict handling; push/pull entry points. | gitSlice thunks (`checkoutBranch`, `pushChanges`, `pullChanges`); confirm/prompt dialogs. |
| `CommitGraphColumn.jsx` | 288 | Shared lane-rail + Bézier merge-curve commit graph used by history views. Pure geometry from commit list. |
| `CommitHistoryPanel.jsx` | 857 | Full history list/detail: cherry-pick, revert, tag creation, unpushed/incoming filters. | gitSlice thunks (`fetchCommitHistory`, `cherryPickCommit`, `createTag`, …). |
| `HunkStagingView.jsx` | 729 | Line/hunk-level selective staging with per-line checkboxes over parsed diff. | `gitClient` diff/stage APIs + dispatch. |
| `InteractiveRebasePanel.jsx` | 367 | Reorderable commit plan assigning pick/reword/squash/fixup/drop. | Local plan state → gitSlice rebase thunk. |
| `MergeConflictEditor.jsx` | 490 | Side-distinguished conflict blocks with resolution actions. | `gitClient` resolve APIs. |
| `CreatePRForm.jsx` | 292 | PR creation form (branch/label selects). | prSlice (`createPR`, repo branches/labels). |
| `PullRequestsPanel.jsx` | 578 | PR list w/ filters, token gate. | prSlice (`fetchGithubInfo/fetchPRList/setActivePR`). |
| `PRDetail.jsx` | 1275 | Full PR surface: files, comments, reviews, checks, labels/assignees, merge/close/reopen. | prSlice detail thunks (`submitReview/postComment/setLabels/...`). |
| `MarkdownRenderer.jsx` | 670 | GitHub-parity markdown renderer + editor toolbar (zero deps). Pure. |
| `GitSummaryPanel.jsx` | 308 | Compact SCM summary docked in Explorer sidebar (collapsed strip ↔ expanded file list). | Read-only gitSlice selectors. |
| `GitStatus.jsx` | 22 | Preserved import surface pointing at SourceControlPanel. |
| `GitHubTokenModal.jsx` | 66 | Stub redirecting to Settings (per-user PAT, server-side encrypted). |
| `gitUtils.js` | 427 | Pure helpers: credential masking, provider detection, commit URLs, conventional-commit parsing, graph layout. |
| `CommitTypeChips.jsx` / `SubViewPills.jsx` / `FocalCard.jsx` / `useFocalCardState.js` | see above | — |

Ref: `synthi/src/components/git/scm/SourceControlPanel.jsx:L78`, `synthi/src/components/git/scm/useFocalCardState.js:L1`, `synthi/src/components/git/gitUtils.js:L1`.


### 2.15 `components/healing` (27 files)

UI for the two-tier self-healing system (regex micro-fixes + LLM deep fixes):

**Panels**

| File | ~L | Role | State & data |
|---|---|---|---|
| `HealingSettingsPanel.jsx` | 701 | Plain-English settings: boldness presets (Careful/Balanced/Aggressive), trigger choice (save/diagnostics-stable/…), AI-for-hard-errors toggle. | healingSlice config reducers. |
| `HealingRulesEditor.jsx` | 752 | Sentence-style rule builder ("Always fix missing imports in any file") — dropdowns, no regex; optional file scoping. | ruleEngine lib + healingSlice rules; analyzer gateway for validation. |
| `HealingPendingPanel.jsx` | 218 | Confirmation queue when `requireConfirmation` on: approve/reject each pending fix. | `selectPendingFixes` + remove/reject reducers. |
| `HealingHistoryPanel.jsx` | 362 | Time-travel list of applied fixes; expand inline before/after diff from undo stack; "Revert to here" walks Monaco undo; exports HEAL_REVERT_EVENT_NAME. | Undo stack selectors; theme-aware. |
| `AIStatsPanel.jsx` | 251 | Agent stats dashboard: detection counts, LLM call metrics, acceptance rates, suppressed patterns. | `useAIHealing` + gateway stats. |
| `AISuppressedRulesPanel.jsx` | 171 | List/unsuppress suppressed fingerprints. | aiSuppressedRules service. |
| `FailureDistillerPanel.jsx` | 233 | Failure-capsule workbench: distill failure → capsule → run/explain/materialize/patch/delete. | `useAnalyzerGateway` distiller methods; `failure-distiller-runtime-evidence` lib. |
| `HealingStatsDashboard.jsx` | 86 | Live engine metrics (rules, fixes detected/applied/rejected, cache hit rate). | `useHealingStats` (SSE-driven). |
| `HealingPresetSelector.jsx` | 145 | Quick preset switcher chips. | healingSlice. |
| `HealingIndicator.jsx` | 184 | Status-bar island: active/idle/cooldown/off state, fix counts, popover w/ recent activity, quick toggle. | healingSelectors + `useAIForHard`. |
| `HealingToast.jsx` | 114 | Bridges Redux toast queue → Sonner; category→label map. | healingSlice toasts. |
| `PreCompileHealToast.jsx` | 56 | Toast on pre-compile heal via window event `synthi:pre-compile-heal`. | Window event only. |
| `RuntimeHealingIndicator.jsx` | 159 | Bottom-right overlay while HMR runtime healing runs: status, attempt/max, auto-heal countdown. | `useRuntimeHealing`. |

**Fix cards & editor integrations (Monaco)**

- `AIFixCard.jsx` (294L): one AI-detected fix card — description/category/confidence + Apply/Dismiss.
- `AIDiffPreview.jsx` (97L): Monaco diff editor preview of the proposed change.
- `AIConfidenceGate.jsx` (93L): confidence-tiered presentation (auto-apply badge vs Apply/Dismiss vs maybe-only).
- `AIActivityTimeline.jsx` (102L): compact recent-actions timeline.
- `AIErrorBoundary.jsx` (72L): recovery boundary around healing UI.
- `AIInlineWidget.js` (376L): Monaco inline content widgets (lightbulb hint + popover) — create/dispose API.
- `aiCodeActions.js` (115L): CodeActionProvider registering "AI Fix: …" lightbulb actions; reports acceptance feedback.
- `aiDiagnostics.js` (136L): converts fixes → Monaco IMarkerData squiggles (set/clear/count).
- `aiHoverProvider.js` (120L): hover tooltip with severity/confidence/category/replacement/shortcuts.
- `pendingFixCodeActions.js` (128L): lightbulb provider for suggest-bucket fixes from `state.healing.pendingFixes`.
- `healingDecorations.js` (85L): brand-tinted sweep + gutter glow on healed lines, auto-decaying styles.
- `aiNotifications.js` (130L): border flash / browser Notification / alert sound for high-severity findings.
- `index.js`: barrel re-exporting the editor-integration APIs consumed by useAIHealing/useSelfHealing.

Ref: `synthi/src/components/healing/HealingSettingsPanel.jsx:L1`, `synthi/src/components/healing/aiCodeActions.js:L1`.

### 2.16 `components/integrations` (5 files)

Third-party connection management (settings panel sections):

- `ConnectedToolsPanel.jsx` (209L): connected MCP/integration tools with relative-time "last used"; loads via `integrationsClient.fetchConnections`; workspace slug from selectors.
- `AddConnectionDialog.jsx` (153L): create-connection dialog → `createConnection`.
- `GitProvidersSection.jsx` (74L) & `CliAccessSection.jsx` (81L): git-provider OAuth status and CLI token create/revoke (show-once semantics).
- `integrationsClient.js` (85L): fetch wrapper over `/api/integrations/connections|tokens` (CRUD + test).

Ref: `synthi/src/components/integrations/integrationsClient.js:L1`.

### 2.17 `components/local-support` (3 files)

Local support/relay transparency surface:

- `LocalSupportTransparency.jsx` (1335L): user-facing transparency console — pairing state, relay payloads inspection, security events, policy toggles, redacted downloads (`L231` component def).
- `LocalSupportAdmin.jsx` (175L): admin gate matrix over `EMPTY_POLICY` flags (global/org/pairing/preview/agent-access).
- `local-support.css` (123L): scoped surface tokens.

Ref: `synthi/src/components/local-support/LocalSupportTransparency.jsx:L231`.

### 2.18 `components/notebook` (2 files)

- `NotebookViewer.jsx` (115L): sanitized .ipynb renderer (DOMPurify-style allow-list `NOTEBOOK_HTML_POLICY`); uses `@/lib/jupyter/notebook`, output-safety + feature flags libs.
- `JupyterConnectionSettings.jsx` (15L): add/list Jupyter server connections per workspace (name/origin/token/mountPath); slug from workspace selector.

Ref: `synthi/src/components/notebook/NotebookViewer.jsx:L1`.

### 2.19 `components/ports` (2 files)

- `PortsPanel.jsx` (85L): docked panel listing forwardable ports from both runtime scopes — containerPorts (hybrid path) and runtimePorts (per-workspace pod), plus runtimeScope label; deep-links through program-session client proxies. Read-only over `portsSlice`.
- `PortsPanel.test.jsx`: drives selectors from hoisted fake state.

Ref: `synthi/src/components/ports/PortsPanel.jsx:L4`.

### 2.20 `components/programs` (40 files)

Programs marketplace + session management (installing/running containerized apps in the workspace):

**Top level**: `ProgramsPanel.jsx` (538L) orchestrates Library/MyApps/Store subviews; thunks via `programsClient` + programSessionClient (`fetchProgramSessions`, install/launch/stop/restart/delete); terminal routing tests assert how sessions open terminals.

| Group | Files | Role |
|---|---|---|
| Store | `StoreView.jsx`(105) `StoreTile.jsx`(77) `ProgramDetail.jsx`(50) `FilterStrip.jsx`(116) | Marketplace grid with price formatting, category filter strip (custom scrollbar chip row), consent-gated detail/install flow (requestedScopes). Data: `/api/workspace/[slug]/programs/marketplace|pricing`. |
| Library | `LibraryView.jsx`(136) `ProgramTile.jsx`(45) `RunningCard.jsx`(86) `ProgramThumbnail.jsx`(70) `ScaleToFitFrame.jsx`(61) | Installed apps grid + running sessions (state-toned cards: running green/crashed red/stopped muted). Thumbnails are ONE KasmVNC screenshot ~60–90 s after start via `/wsport` proxy, never polled. ScaleToFit = aspect-preserving letterbox math. |
| MyApps | `MyAppsView.jsx`(30) `MyAppCard.jsx`(46) | Publisher board of submissions with review pipeline states (queued/scanning/AI review/pending human…). |
| Session | `ProgramSessionPanel.jsx`(382) + `programSessionSections.js`(86) | Per-session dock panel: logs/events/app-url/restart/stop; pure section builders (active states, age/ports formatting). Data: `programSessionClient` events stream. |
| Shared | `ConfirmDialog.jsx`(105) `FirstPublishTutorial.jsx`(53) `GenerateManifestDialog.jsx`(53) `ProgramIcon.jsx`(49) `programLogos.js`(18) `programTokens.js`(63) `programsClient.js`(196) | Vectant confirm modal; first-publish tutorial gated by per-user localStorage key; AI-manifest review dialog (server re-validates fail-closed); inlined CC0 brand SVGs (no external requests under COEP/CSP); style tokens from design spec; REST client over `/api/workspace/[slug]/programs*`. |

17 colocated test files cover install flows, terminal routing, thumbnails (fake timers only), tokens, tiles/views.

Ref: `synthi/src/components/programs/ProgramsPanel.jsx:L1`, `synthi/src/components/programs/library/ProgramThumbnail.jsx:L1`, `synthi/src/components/programs/programsClient.js:L1`.

### 2.21 `components/ui` (20 files)

shadcn/radix primitives restyled with Vectant tokens: `button`, `card`, `checkbox`, `context-menu`, `dialog`, `dropdown-menu`, `input`, `label`, `popover`, `resizable` (panel-group wrapper), `scroll-area`, `select`, `separator`, `sonner` (Toaster bound to app theme), `tabs`, `textarea`. Plus:

- `PromptDialog.jsx` (103L) / `UnsavedChangesDialog.jsx` (114L): branded modals (focus-trapped Save/Discard/Cancel with Enter/Escape).
- `useConfirmDialog.js` / `usePromptDialog.js` (32L each): promise-resolver hook pattern (`const { confirm, confirmDialog } = useConfirmDialog()`).

Ref: `synthi/src/components/ui/useConfirmDialog.js:L1`.

## 3. Hooks

### 3.1 `src/hooks/` (38 files)

**Analysis & intelligence**

| Hook | ~L | Owns | Receives | Calls / data source |
|---|---|---|---|---|
| `useAnalyzerGateway.js` | 853 | Shared analyzer-gateway client lifecycle: WS URL resolution (`NEXT_PUBLIC_GATEWAY_WS_URL` or derived `/gateway/ws`, L16), connect/reconnect, request multiplexing, status broadcast. | options (slug etc.). | `analyzerGatewayClient` service; exported singleton `getSharedAnalyzerClient`. |
| `useProactiveAnalysis.js` | 474 | Debounced (500 ms default) multi-tier analysis triggers + result caching keyed by content hash. | file/content refs. | `analyzerGatewayClient`; feeds ProactiveAnalysisProvider. |
| `useWorkspaceAnalysis.js` | 657 | Workspace-wide incremental analysis (changed files + dependents), cross-file issues, batched AI calls, content hashing. | slug. | composes useVFSWorkspaceAnalysis + gateway. |
| `useVFSWorkspaceAnalysis.js` | 588 | Guarantees analyzer reads VFS content (VFS is single source of truth), not stale editor state. | slug/file set. | `VirtualFileSystem` service + gateway. |
| `useCodeIntelIndex.js` | 258 | Auto-index workspace on open; incremental updates; index status tracking. | slug. | `/api/code-intel/*` fetches. |
| `useCodeIntelMetrics.js` | 78 | Code-intel metrics; SSE event `code-intel-metrics` with initial fetch + 120 s fallback poll when SSE down. | workspacePath. | sseClient + `/api/code-intel`. |
| `useBoundaryTrigger.js` | 229 | Keystroke-level smart triggering: EAGER fire on semantic boundaries (`
 ; } )`), abort on disruptive keys — replaces dumb debounce. | editor ref. | Pure heuristics; consumer: useAIAutoAnalysis. |
| `useAIAutoAnalysis.js` | 61 | Wires boundary-trigger to AI analysis invocations. | editor. | useBoundaryTrigger + AI analysis cb. |
| `useAISelectionAnalysis.js` | 80 | Analyze only the Monaco selection (cheaper prompt, faster response) via right-click/shortcut. | editor. | useAIHealing machinery. |

**Self-healing family**

| Hook | ~L | Owns | Receives | Calls / data source |
|---|---|---|---|---|
| `useSelfHealing.js` | 1049 | Real-time regex micro-fix engine orchestration: debounced content-hash-deduped scans, small-fix-only policy (imports/syntax sugar/whitespace), Ctrl+Z-able application via pushUndoStop, Monaco decorations. | monaco editor (lazy-required for SSR, L27). | healingSelectors slice reads/writes; `ruleEngine` lib; `analyzerGatewayClient`; `healingDecorations`. |
| `useAIHealing.js` | 1036 | On-demand LLM analysis catching deep bugs (logic/null-safety/missing-await/off-by-one/type mismatches); manual or on-save triggers; hybrid merge with regex results; apply/dismiss per fix; agent statistics. | editor instance. | `aiFixHistory`, `aiSuppressedRules` services; `ruleEngine`; full healing/* editor integration barrel (inline widgets, code actions, hover, diagnostics, notifications). |
| `useAIHealingKeyboard.js` | 105 | Ctrl+Shift shortcuts: I analyze, Y apply safe, N dismiss all, M toggle ai↔hybrid. | none (global). | useAIHealing + dispatch. |
| `useHealingKeyboard.js` | 83 | Ctrl+Shift H toggle / A accept-all / Z undo / B batch shortcuts. | none. | healingSelectors + dispatch + self-healing. |
| `useBatchHealing.js` | 74 | Batch-heal open/changed files concurrently; aggregate into Redux. | file list. | gateway `healBatch`. |
| `useHealingUndo.js` | 169 | Undo-stack operations bridging slice state ↔ Monaco undo stops. | editor. | healingSelectors (selectCanUndo/selectTopUndo). |
| `useHealingStats.js` | 78 | Healing stats via SSE `healing-stats-update` (+120 s fallback poll). | slug. | sseClient. |
| `usePendingFixCodeActions.js` | 82 | Mirrors `healing.pendingFixes` into Monaco lightbulb quick-fixes for active file. | editor. | healing slice watch. |
| `useSmartRuleSuggestions.js` | 140 | Pattern detection on accepts/dismissals (3× same category ⇒ propose auto-fix or mute rule). | none. | ruleEngine + dispatch. |
| `useRuntimeHealing.js` | 123 | Reactive view of HMR runtime error interceptor: status/attempt/lastResult/auto-heal countdown. | none. | `runtimeErrorInterceptor` service singleton. |

**Compilation / preview / HMR**

| Hook | ~L | Owns | Receives | Calls / data source |
|---|---|---|---|---|
| `useCompiler.js` | 153 | CompilerClient lifecycle: status machine, mediaStream, auto-reconnect timer. | none. | `compilerClient` service. |
| `useHMR.js` | 366 | HMR status tracking (idle/check/prepare/dispose/apply/applied/full-reload/failed) + GPU-mode pair `useGpuMode` reading uiSlice gpuModeEnabled/gpuTarget (L34). | none. | hmr-runtime + adapter-status/gpu-hmr-status libs; uiSlice dispatch. |
| `usePreviewLifecycle.js` | 56 | Compiled-preview lifecycle state + predicates + transitions for direct consumers. | none. | preview-store lib. |
| `useRetryCompile.js` | 103 | Exposes retry action when lifecycle is in error state (re-dispatches compile via CompilerClient). | none. | preview-store + preview-lifecycle libs. |
| `useHotSwap.js` | 48 | Dynamic-library hot-swap status for preview panels. | none. | dynlib-status lib. |
| `useCompileManifestListener.js` | 80 | Window CustomEvent `synthi:compile-manifest` → compileManifestSlice dispatch (ULTRAPLAN Phase 8). | none. | window events. |

**Collaboration / presence**

| Hook | ~L | Owns | Receives | Calls / data source |
|---|---|---|---|---|
| `useCollabSession.js` | 320 | Full session state + action dispatchers for host & guest roles; permission helpers (`useSessionPermissions`). | none. | `collabSessionService` (subscribes), `userIdentity`. |
| `useCollabStatus.js` | 21 | Aggregated WS connection status ('connected'|'connecting'|'disconnected'). | none. | `collabClient.connectionStatus`. |
| `useCollabNotifications.js` | 243 | Maps collab events → toasts (with "Open popup" action). | slug. | collabSessionService. |
| `usePresence.js` | 99 | Active users from Yjs awareness aggregation `{clientId,user{...,activeFile}}`. | slug/userId exclusions. | collabClient awareness. |
| `useFilePresence.js` | 100 | Map filePath → editors-with-colors from awareness; excludes self. | slug/myUserId. | collabClient awareness. |
| `useWorkspacePresence.js` | 94 | activeUsers + activeSessions; SSE `workspace-presence` driven with initial fetch. | slug. | sseClient + collabSessionService. |
| `useBlockedUsers.js` | 66 | Block-list CRUD + isBlocked. | none. | collabSessionService endpoints. |

**Extension system**

- `useExtensions.js` (1950L, `L104`): boots the extension host worker, bridges it to Redux (extensionSlice), restores persisted extensions from IndexedDB; exposes ready/extensions/errors/install/uninstall/enable/disable/commands APIs; integrates `compilerClient`, `lspRegistry`, `vscodeTunnelService`. The largest hook in the codebase.

**SSE & infra utilities**

| Hook | ~L | Role |
|---|---|---|
| `useSSE.js` | 72 | Workspace SSE subscription with ref-counted connect/disconnect + typed listener attach (`useSSEEvent`). Backs metrics/stats/presence hooks. |
| `useDeferredValue.js` | 110 | Concurrency helpers keeping typing at top priority: `useDeferredSelector`, `useTransitionDispatch`, `useLowPriorityState`, `useIdleCallback`. |
| `useVirtualizedTree.js` | 113 | Flattens recursive file tree into visible rows for react-virtuoso (FileItem shallow mode). Reads expandedFolders via selector. |
| `useViewport.js` | 71 | Tailwind-aligned breakpoints (<640 mobile / <1024 tablet / <1280 narrow / desktop) for JS behavior switches. |

Ref: `synthi/src/hooks/useSelfHealing.js:L242`, `synthi/src/hooks/useExtensions.js:L104`, `synthi/src/hooks/useHMR.js:L34`.


### 3.2 Nested hook groups

**`components/docking-wm/hooks/` (13)**

| Hook | ~L | Role |
|---|---|---|
| `use-docking.js` | 208 | Unified facade: state selectors + action creators (`useDocking`, `useDockingActions`). |
| `use-activity-bar-docking.js` | 244 | Maps activity-bar clicks → toggle/open/focus panel ops, placing sidebar vs bottom panels in the right region. |
| `use-drag-panel.js` | 139 | HTML5 DnD source side for tab tears; payload parsing. |
| `use-drop-zone.js` | 143 | Drop-target side with zone detection via geometry.js hit-testing. |
| `use-floating-window.js` | 172 | Drag/resize (8 directions)/z-order for floating windows. |
| `use-keyboard-navigation.js` | 309 | Global shortcuts: Ctrl+Arrow group focus, Ctrl+Tab cycle, Ctrl+W close, Ctrl+Shift+M maximize; focus indicator ARIA. |
| `use-layout-history.js` | 199 | Ring-buffer layout undo/redo (30 deep), Ctrl+Z / Ctrl+Shift+Z scoped to layout. |
| `use-layout-persistence.js` | 123 | Debounced localStorage autosave of serialized layout; restore on boot. |
| `use-popout.js` | 205 | Opens detached windows; BroadcastChannel state sync. |
| `use-responsive-layout.js` | 137 | Container/viewport hints: auto-collapse sidebar, vertical stacking, touch DnD disable (`BREAKPOINT`). |
| `use-sidebar-auto-collapse.js` | 255 | Hover-out collapse after delay; purely visual — never mutates layout slice so docked widths survive. |
| `use-splitter.js` | 195 | Pointer drag + keyboard resize between split children. |

**`components/chat/hooks/` and `components/git/scm/useFocalCardState.js`, `components/ui/useConfirmDialog|usePromptDialog`**: covered in their sections above.

## 4. Context providers

Only one dedicated context module:

- `context/notebook/serializeNotebookContext.js` (19L): not a React context but the shared notebook-context serializer used by chat attachments. Normalizes a notebook (`@/lib/jupyter/notebook`), filters selected cells, caps body at 40 000 chars, wraps content in an **untrusted-data instruction guard**, and returns `{kind:'jupyter-notebook', path, provenance:'explicit-user-selection', truncated, content…}`. Consumed by `useAISuggestions`; tested by `serializeNotebookContext.test.js`.

Provider-pattern components living elsewhere (React contexts): `ThemeProvider` (+ useTheme), `ThemePickerProvider`/`useThemePicker`, `ThemeCreatorProvider`/`useThemeCreator`, `NewProjectPickerProvider`/`useNewProjectPicker`, `ProactiveAnalysisProvider`/`useProactiveAnalysisContext`, docking's `DockingProvider`/`useDockingContext`, `PanelRegistryProvider`/`usePanelRegistry`, `WorkspacePanelContext`/`useWorkspacePanelContext`, legacy `DockablePanelProvider`/`useDockContext`, `DockLayoutProvider`/`useDock`. See respective sections.

Ref: `synthi/src/context/notebook/serializeNotebookContext.js:L1`.

## 5. Redux store

### 5.1 Store composition (`redux/store.js`, 340L)

```js
configureStore({
  reducer: {
    workspace, ui, git, extensions, theme,
    layout: /* from components/docking-wm/state/layout-slice */,
    healing, pr, compileManifest, ports,
  },
  middleware: serializableCheck ignores workspace.fileContentCache (a Map) + selectFile actions
})
```
(`store.js:L2` configureStore block). Immer `enableMapSet()` is on. Persistence helpers exported for hydration components: `loadUiPrefs`, `loadExpandedFolders`, `loadThemePrefs`, `loadHealingPrefs`, `loadOpenTabs(slug)`, `loadActiveTab(slug)` with keys `synthi:ui`, `synthi:theme`, `synthi:healing` (versioned, HEALING_CONFIG_VERSION=2), `synthi:openTabs:<slug>`, `synthi:activeTab:<slug>`; a window-side subscription writes prefs back debounced.

Typed hook aliases: `redux/hooks.js` re-exports `useAppDispatch = useDispatch`, `useAppSelector = useSelector`, `useAppStore = useStore` (7L).

### 5.2 Slices

| Slice file | ~L | State shape (key fields) | Async thunks & services | Consumers |
|---|---|---|---|---|
| `workspaceSlice.js` | 1440 | `initialWorkspaceState` (L84): slug, rawFiles, openFiles[{path,name,language,isUnsaved}], activeFile, current/saved/originalContent, diffMode, fileContentCache Map (deprecated→services/fileCache), loadingFiles, `_savedContentByPath` baseline cache, `_conflictRecovery` stashed pre-conflict CRDT content. | `fetchFilesThunk`, `selectFileThunk`, `saveFileContentThunk` (in-flight save coalescing registry keyed `slug:path` prevents double-writes, L120+), create/rename/delete/move thunks, `scaffoldProjectThunk`. Services: api, collabClient (Yjs docs), compilerClient, fileCache, gitClient, loadScheduler, perfMarkers; libs: jupyter/notebook, project-templates, workspaceInstallPlan. | FileTree, Editor panes, TopNav tab strip, chat (rawFiles/slug), StatusBar. |
| `uiSlice.js` | 225 | showTerminal, showEmulatorPreview (never persisted), treeOnRight, autoSave/autoCompletion toggles, gpuModeEnabled/gpuTarget, bringYourOwnRunnerEnabled, uiActionState (create-file/rename flows), expandedFolders, presence settings (showAnonymousPresence, granularity line/file/workspace), cursorPosition, sidebarAutoCollapse{Enabled,Delay,pinnedSidebarPanelTypes} (L16). | Sync reducers only. | SettingsPanel, TopNav, StatusBar, FileTree, docking sidebar hooks. |
| `gitSlice.js` | 920 | status, branches, current branch, ahead/behind, conflicts, loading/error/actionError flags, dedup/refetch guards (`_pendingRefetchSlug`). | `fetchGitStatus` (dedup+queued refetch), `forceRefreshGitStatus`, checkout/stage/unstage/commit/push/pull/fetch/cherry-pick/revert/tag/rebase/stash thunks → `gitClient`; token from per-user bridge (`getGithubToken` L8); collabClient for repo events. | SCM column, BranchSelector, CommitHistory, StatusBar branch chip. |
| `prSlice.js` | 584 | githubInfo(owner/repo/provider), PR list + listState, activePR detail(files/comments/reviews/checks), hasToken, action errors. | fetchGithubInfo/PRList/PRDetail, create/update/merge/close/reopen, submitReview/postComment/setLabels/setAssignees → `prClient`+`gitClient`. | PullRequestsPanel, PRDetail, CreatePRForm. |
| `healingSlice.js` | 727 | Config: boldness, triggers, rules[], customThresholds, maxFixesPerPass/maxAiCallsPerMinute, debugLogging, dryRun, notifications/sound, autoHealCategories, minConfidence, cooldownMs/debounceMs, requireConfirmation. Stats: totals by category/language/action, accepts/dismissals, sessionStartedAt. Runtime: enabled, mode(regex|ai|hybrid), isAnalyzing, pendingFixes[], undo stack, error (state key dump verified at slice). | Sync reducers; constants HealingCategory/HealingSeverity/BoldnessThresholds/RuleAction/TriggerMode. | Every healing component/hook (§2.15/§3.1); selectors memoized in `healingSelectors.js` (259L: selectHealing*, selectPendingFixes, selectUndoStack, selectEffectiveThresholds…). |
| `extensionSlice.js` | 386 | hostStatus/hostError, extensions map w/ lifecycle states, registered commands, diagnostics, errors. | Reducers driven by useExtensions worker bridge events. | ExtensionPanel, ExtensionSidebar, ExtensionViewContainer. |
| `themeSlice.js` | 228 | activeThemeId, previewThemeId, builtin/extension/user registries, userOverrides[baseThemeId], editor panel open flag. | Sync reducers; DOM application done by ThemeProvider/theme-engine. | ThemePicker/Creator/EditorPanel, ThemeProvider. |
| `compileManifestSlice.js` | 108 | Latest AI-synthesized build manifest + architecture cache + rejection + confidence + parsed language/framework. | Populated by compile client CustomEvents (via useCompileManifestListener). | StatusBar language/framework chip, CompileErrorCard, ConfidenceWarning. |
| `portsSlice.js` | 43 | containerPorts[] (hybrid runtime) vs runtimePorts[] (per-workspace pod), runtimeScope. | set/clear reducers driven externally. | PortsPanel. |
| `layout-slice.js` (docking-wm) | 585 | versioned flat tree {rootId,nodes,tabs,floatingWindows,popouts,maximizedNodeId,…} v4. | Delegates to layout-ops; actions splitEditorPanel/setPaneFile etc.; selectors selectLayout/selectRootId/selectNodes/selectTabs/selectFloating/selectPopouts. | Entire docking-wm shell; paneActiveFile glue. |

**Glue modules**

- `paneActiveFile.js` (19L): dependency-free decision helpers linking workspace file model ↔ docking editor panes (`resolveOpenTarget`, `resolveMirrorFile`); unit-tested.
- `isolatedSelectors.js` (93L): narrow primitive-returning selectors (`selectCurrentBranch`, `selectAheadBehind`, `selectChangedFilesCount`, …) to stop wide-selector render cascades.
- Tests: `pane-active-file.test.js`, `portsSlice.test.js`.

Ref: `synthi/src/redux/store.js:L2`, `synthi/src/redux/workspaceSlice.js:L84`, `synthi/src/redux/healingSlice.js:L1`, `synthi/src/components/docking-wm/state/layout-slice.js:L55`.

## 6. Themes (`src/themes`, 13 files)

- **Schema** — `theme-schema.js` (12161 B): canonical JS schema (importable by engine AND Monaco JSON validation without build step). Groups: meta (id/name/type/source/parentThemeId), UI Shell color keys mapped 1-to-1 to CSS custom properties (`bgApp → --bg-app`, borders, text…), Monaco editor chrome colors (VS Code key format), terminal ANSI 0–15 + bg/fg/cursor, TextMate-style `tokenColors`, LSP `semanticTokenColors`. Constants: `THEME_TYPES=['dark','light']`, `THEME_SOURCES=['builtin','extension','user']`, `DEFAULT_THEME_ID='synthi-dark'`.
- **Barrel** — `index.js` (47L): imports all builtins into `BUILTIN_THEMES` keyed by id + ordered `BUILTIN_THEME_LIST` (dark first, then light, community classics, high-contrast last).
- **Builtins** (10 JSON documents, all conforming: id/name/type/source/parentThemeId/ui/editor/terminal/tokenColors/semanticTokenColors): `synthi-dark` (default, richest at ~20 KB), `synthi-classic`, `synthi-light`, `vectant-sand`, `vectant-sky`, `midnight`, `high-contrast-dark`, `high-contrast-light`, `solarized-dark`, `solarized-light`.
- **Migration ledger** — `THEME_MIGRATION.md`: infrastructure complete (globals.css/editor-overrides.css/panel wrappers converted); ~500 hardcoded color instances remain in JSX, with a priority table (TopNav ~30, FileTree ~20, TerminalManager ~20, Editor.jsx ~15, page.jsx/SearchView ~15 …).
- **Lifecycle**: registered by ThemeProvider → selection persisted via themeSlice + `synthi:theme` storage → resolved theme applied as CSS custom properties by `@/lib/theme-engine`; overrides layered per base theme via `themeSlice.userOverrides`; authoring via ThemeCreator/ThemeEditorPanel.

Ref: `synthi/src/themes/theme-schema.js:L1`, `synthi/src/themes/index.js:L19`, `synthi/src/themes/THEME_MIGRATION.md:L1`.

## 7. Cross-cutting data-flow summary

1. **Editor buffer truth**: VFS/fileCache is authoritative; workspaceSlice mirrors open files; healing + analysis hooks read VFS (`useVFSWorkspaceAnalysis` principle) and write back through dispatches; chat patches apply against live editor content passed as props.
2. **Event buses**: window CustomEvents carry cross-layer signals (`synthi:compile-manifest`, `synthi:pre-compile-heal`, `synthi:program-output`, `synthi:build-log`, `synthi:jumpstart`, heal-revert); SSE carries server push (code-intel metrics, healing stats, workspace presence, CodeSite 36 event types); WebSocket carries PTY + collab/Yjs; BroadcastChannel syncs popouts.
3. **Persistence layers**: Redux→localStorage for ui/theme/healing/tabs-per-slug/layout/profiles; IndexedDB for extension packages; server-side for GitHub PATs (encrypted, per-user).
4. **Render-isolation strategy**: `RenderBoundary`, `isolatedSelectors.js`, deferred selectors (`useDeferredValue.js`) and memoized panel wrappers exist specifically to keep Monaco typing at highest priority while panels/status bars update at lower priority.
5. **Test-id contracts**: CodeSite locks its data-testid baseline across refactors (`testIdInvariant.test.js`); programs/docking rely on colocated vitest suites around pure builders (`programSessionSections`, `layout-ops`, `editor-panes`).
6. **Service-client convention**: feature folders own thin REST clients (`codesiteClient`, `programsClient`, `integrationsClient`) while cross-cutting transports (SSE/WS/analyzer gateway/compiler) live in `@/services` and are wrapped by hooks before components touch them.

---

*Coverage note: all 467 in-scope files enumerated; every component group and every hook file described. Files under `app/workspace/*` (page.jsx, FileTree.jsx, TerminalPane.jsx, TerminalManager.jsx, StatusBar.jsx, TopNav.jsx, Editor/) are documented only as integration surfaces since they belong to other area docs.*
