# Workspace Instruction Projection — Symlink Resilience

**Goal:** Stop a cloned repo that ships `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` as symlinks from taking down the entire hosted workspace (file tree, saves, runtime pod, terminal), and make any future instruction‑projection failure non‑fatal.

**Architecture:** Two layers. (L1) The projection service skips a symlinked *projection target* instead of throwing, so `reconcileWorkspace` runs to completion (which also lets the git‑isolation clean filter install and self‑heal a half‑projected `AGENTS.md`). (L2) The two runtime call sites (collab git route, runtime‑filesystem hydration) treat any `reconcile()` failure as "projection unavailable for this request" and degrade to feature‑off behaviour instead of returning 503 / 500. Plus a write‑path guard so a skipped (symlinked) path never gets the managed block merged into it.

**Tech stack:** Node.js (CJS), `node:test`, collab-server (`backend/collab-server/`).

---

## Context

### The bug (confirmed on current `origin/main`)

`backend/collab-server/workspaceInstructionProjectionService.js` — `_assertSafeTarget()` throws `workspace_instruction_projection_target_symlink_refused` the moment a registered projection target (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md` — see `INSTRUCTION_PROJECTIONS` in `workspaceInstructionProjection.js`) is a symlink:

```js
if (stat.isSymbolicLink()) {
  throw projectionError(
    isTarget ? 'workspace_instruction_projection_target_symlink_refused' : 'workspace_instruction_projection_unsafe_directory',
  );
}
```

`reconcileWorkspace()` iterates `[AGENTS.md, CLAUDE.md, GEMINI.md]` **non‑transactionally** and `removeWorkspaceProjection()` reads every target unconditionally. `de4a20377` (2026‑08‑21) set `DEFAULT_ROLLOUT_MODE = 'full'`, so the projector runs for **every** workspace with no env override in the k8s manifests. Any repo that symlinks one of those files (a common pattern — the repo the user cloned, `pascalorg/editor`, symlinks `CLAUDE.md` + `GEMINI.md` → `AGENTS.md`) makes the projector throw, and the throw cascades:

| Surface | Path | Result |
|---|---|---|
| `POST /collab/git/<slug>/sync`, `GET …/files-meta`, `files`, `file`, `write-file`, `write-files-batch` | `server.js` — `shouldReconcileInstructionProjection(action)` → `workspaceInstructionProjectionRuntime.reconcile()` throws → caught → `res.writeHead(503, …'workspace_instruction_projection_unavailable')` | file tree never loads, every save fails |
| `POST /collab/api/spawner/ensure` | `server.js` → `ensureRuntimeFilesystem()` → `runtimeFilesystem.js` `reconcileRuntimeInstructionProjection()` → `reconcile()` throws (unguarded) → 500 | no worker pod → "Runtime unavailable", VS Code server never connects |
| terminal | `terminalService.js` → same `ensureRuntimeFilesystem()` | `Failed to prepare workspace filesystem: …_symlink_refused` |

Collateral: the loop writes the managed block into the real `AGENTS.md` on disk **before** it throws on `CLAUDE.md`, and the git clean/smudge filter that hides that block from `git diff` is configured *after* the loop (`gitAdapter.reconcileWorkspace`, never reached) — so affected workspaces have a visibly‑modified `AGENTS.md`. L1 makes the loop complete, so the filter installs and this self‑heals on the next reconcile after deploy.

Not in scope (separate, pre‑existing): the AI‑backend `/api/completion` + `/api/next-edit` **502s** (ai‑engine/ai‑gateway down on beta), and the benign `/api/auth/token …?workspaceSlug=local-… 404` (throwaway pre‑clone workspace).

### Deploy state

Last recorded deploy (`tasks/todo.md`, commit `bc6989ae2`, 2026‑08‑25) shipped `main` at image `4fece6bc-…`; that build contains the projection feature (landed 2026‑08‑14, enabled‑by‑default 2026‑08‑21). GitHub Actions auto‑deploy is disabled (flagged org) — nothing merged since is live. `origin/main` is now `b5cd5cc1b` (2026‑08‑29), ~1,761 commits ahead of that deploy. **Deploying `main` after this fix ships those 1,761 other commits too** — that is how beta deploys work here (per the incident writeup); it is the user's call. `dev` predates the projection feature entirely and needs no change.

---

## File structure

Source (all under `backend/collab-server/`):

| File | Responsibility | Change |
|---|---|---|
| `workspaceInstructionProjectionService.js` | physical projection lifecycle | L1 — skip symlinked target |
| `workspaceInstructionProjectionCollabAdapter.js` | collab HTTP presentation boundary | L2 helper + carry `external` in metadata |
| `workspaceInstructionIdePresentation.js` | IDE read/write/tree classification | write‑path guard: external → treat as plain file |
| `server.js` | collab HTTP router | L2 — use the helper, never 503 on projection failure |
| `runtimeFilesystem.js` | runtime hydration + projection bridge | L2 — `reconcile()` failure is non‑fatal |

Tests (`backend/collab-server/__tests__/`): `workspaceInstructionProjectionService.test.js`, `workspaceInstructionProjectionCollabAdapter.test.js`, `workspaceInstructionIdePresentation.test.js`, `runtimeFilesystem.test.js`.

CI: `.github/workflows/codesite-tests.yml` (add the two lifecycle suites to the collab‑server job — they currently aren't covered).

**Execution note:** line numbers below are from `bc6989ae2`; `origin/main` differs by a few lines (commit `8d1041417` added `EEXIST` tolerance to `_assertSafeTarget`'s parent‑mkdir). **Re‑read each file on the fix branch before editing.** The symlink logic itself is byte‑identical on `origin/main`.

---

## Task 0: Isolate the work (git worktree off current `origin/main`)

The primary working tree (`demo/blue-door-seed`) has uncommitted investor‑demo changes (incl. a 1‑line `terminalService.js` log tweak — unrelated, no overlap with our files) and untracked demo dirs. Do **not** disturb it. Use `superpowers:using-git-worktrees`.

- [ ] **Step 1: Fetch and confirm base**

```bash
git fetch origin main
git log -1 --format='%h %ci %s' origin/main
```
Expected: the current `origin/main` tip (≥ `b5cd5cc1b`, 2026‑08‑29 or newer).

- [ ] **Step 2: Create the worktree + branch**

```bash
git worktree add C:/Users/HP/source/repos/vectant-fix-instruction-projection -b fix/workspace-instruction-projection-symlink-resilience origin/main
```
All remaining work happens in `C:/Users/HP/source/repos/vectant-fix-instruction-projection`.

- [ ] **Step 3: Copy this plan into the repo + add a `tasks/todo.md` pointer** (CLAUDE.md convention)

```bash
# in the worktree
cp <this plan> docs/superpowers/plans/2026-09-08-workspace-instruction-projection-symlink-resilience.md
```
Append to `tasks/todo.md` a `# Task: Workspace instruction projection — symlink resilience (2026-09-08)` section with the task checkboxes and a link to the plan doc. Commit these two together at the end (Task 6) or as a first `docs:` commit.

- [ ] **Step 4: Baseline the test suite** (know the pre‑existing failures before changing anything)

```bash
cd backend/collab-server
node --test __tests__/workspaceInstruction*.test.js __tests__/runtimeFilesystem.test.js __tests__/workspaceInstructionIdePresentation.test.js
node --test __tests__/codesiteFs.test.js __tests__/codesiteActivityRegistry.test.js __tests__/agentSessionAttachService.test.js __tests__/terminalServiceAgentLifecycle.test.js __tests__/runtimeObservationPublisher.test.js __tests__/programRuntimeManager.test.js __tests__/sessionWorkspaceAccess.test.js
```
Expected: projection + runtimeFilesystem suites **all pass**; the CI batch passes except possibly known Windows‑only symlink/procfs failures in `codesiteFs.test.js` (per project memory — record the exact count/names).

---

## Task 1: L1 — projection service skips a symlinked target

**Files:**
- Modify: `backend/collab-server/workspaceInstructionProjectionService.js`
- Test: `backend/collab-server/__tests__/workspaceInstructionProjectionService.test.js`

Use `superpowers:test-driven-development` (red → green per step). All new tests use an **injected fake `fsApi`** whose `lstat` returns `{ isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false }` for the target — this is the existing Windows‑safe pattern already used by the test at `workspaceInstructionProjectionService.test.js:148`, and it also exercises the real code path on Linux CI.

- [ ] **Step 1: Rewrite the existing symlink test to expect a skip, not a throw**

Replace the test currently named `'refuses a symlink projection target without following or changing its destination'` (≈ line 148) with:

```js
test('skips a symlinked projection target without following or changing its destination', async (t) => {
  const root = await temporaryWorkspace(t);
  const outside = path.join(root, 'outside.md');
  const projection = path.resolve(path.join(root, 'AGENTS.md'));
  await fs.promises.writeFile(outside, 'Do not touch.\n', 'utf8');

  const fsApi = {
    ...fs.promises,
    async lstat(filePath) {
      if (path.resolve(filePath) === projection) {
        return { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false };
      }
      return fs.promises.lstat(filePath);
    },
  };

  const result = await createService({ fsApi }).reconcileWorkspace(workspace(root));

  assert.equal(await fs.promises.readFile(outside, 'utf8'), 'Do not touch.\n');
  const agents = result.projections.find((p) => p.path === 'AGENTS.md');
  assert.equal(agents.skipped, true);
  assert.equal(agents.reason, 'external-symlink');
  // The real, non-symlinked projections are still created + projected.
  assert.match(await fs.promises.readFile(path.join(root, 'CLAUDE.md'), 'utf8'), /Vectant_MANAGED_INSTRUCTIONS_BEGIN/);
});
```

- [ ] **Step 2: Run it — verify it fails**

```bash
node --test --test-name-pattern="skips a symlinked projection target" __tests__/workspaceInstructionProjectionService.test.js
```
Expected: FAIL — `reconcileWorkspace` rejects with `workspace_instruction_projection_target_symlink_refused`.

- [ ] **Step 3: Add the `EXTERNAL_SYMLINK` sentinel + `allowExternalSymlink` in `_assertSafeTarget`**

Near the other module consts (after `DEFAULT_MAX_WRITE_RETRIES`):

```js
const EXTERNAL_SYMLINK = Object.freeze({ external: true });
```

In `_assertSafeTarget`, add the option and short‑circuit only for the final segment:

```js
async _assertSafeTarget(activeWorkspaceRoot, targetPath, { createParent = false, allowExternalSymlink = false } = {}) {
```

```js
      if (stat.isSymbolicLink()) {
        if (isTarget && allowExternalSymlink) return EXTERNAL_SYMLINK;
        throw projectionError(
          isTarget
            ? 'workspace_instruction_projection_target_symlink_refused'
            : 'workspace_instruction_projection_unsafe_directory',
        );
      }
```

- [ ] **Step 4: Thread the flag through `_readSnapshot`**

```js
async _readSnapshot(activeWorkspaceRoot, targetPath, { allowExternalSymlink = false } = {}) {
  const stat = await this._assertSafeTarget(activeWorkspaceRoot, targetPath, { allowExternalSymlink });
  if (stat === EXTERNAL_SYMLINK) {
    return { exists: false, external: true, content: '', hash: null, mode: null };
  }
  if (!stat) {
    return { exists: false, content: '', hash: null, mode: null };
  }
  // ...unchanged from here (real-file read + post-read re-check)...
}
```

- [ ] **Step 5: Bail on external in `_writeWithOptimisticRetry`**

Add `allowExternalSymlink = false` to its options param, pass it to the first `_readSnapshot` call inside the loop, and immediately after that read:

```js
      if (snapshot.external) {
        return { before: snapshot, after: snapshot, changed: false, external: true };
      }
```

- [ ] **Step 6: Skip in `_reconcileProjection`**

```js
async _reconcileProjection(activeWorkspaceRoot, state, canonical, projection) {
  const { normalizedRelativePath, target } = resolveProjectionTarget(activeWorkspaceRoot, projection.path);
  const previous = state.projections[normalizedRelativePath] || null;
  const write = await this._writeWithOptimisticRetry(
    activeWorkspaceRoot,
    target,
    (snapshot) => mergeVectantBlock(snapshot.content, canonical.block),
    { rebaseOnConflict: true, allowExternalSymlink: true },
  );
  if (write.external) {
    this._emit('workspace_instruction_projection_skipped_external', {
      workspaceId: canonical.workspaceId,
      path: normalizedRelativePath,
      reason: 'external-symlink',
    });
    return { path: normalizedRelativePath, target, skipped: true, reason: 'external-symlink', changed: false };
  }
  // ...unchanged: _nextStateEntry, state.projections[...] = entry, emit, return result...
}
```

- [ ] **Step 7: In `reconcileWorkspace`, keep skipped results out of the git adapter**

```js
      projections: results
        .filter((entry) => !entry.skipped)
        .map(({ path: projectionPath, ownership }) => ({ path: projectionPath, ownership })),
```
(Required — `configureWorkspaceInstructionGitIsolation` → `validateOptions` throws `workspace_instruction_git_isolation_invalid_projection_ownership` on any `ownership` that isn't `existing-user-file` / `synthetic-only`; see `workspaceInstructionGitIsolation.js:266`.)

- [ ] **Step 8: Run the rewritten test — verify it passes**

```bash
node --test --test-name-pattern="skips a symlinked projection target" __tests__/workspaceInstructionProjectionService.test.js
```
Expected: PASS.

- [ ] **Step 9: Add the exact reported scenario as a test**

```js
test('projects the real AGENTS.md and skips symlinked CLAUDE.md / GEMINI.md (pascalorg/editor layout)', async (t) => {
  const root = await temporaryWorkspace(t);
  await fs.promises.writeFile(path.join(root, 'AGENTS.md'), '# Agent Instructions\n', 'utf8');
  const symlinked = new Set(
    [path.join(root, 'CLAUDE.md'), path.join(root, 'GEMINI.md')].map((p) => path.resolve(p)),
  );
  const fsApi = {
    ...fs.promises,
    async lstat(filePath) {
      if (symlinked.has(path.resolve(filePath))) {
        return { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false };
      }
      return fs.promises.lstat(filePath);
    },
  };
  const gitCalls = [];
  const service = createService({
    fsApi,
    gitAdapter: { async reconcileWorkspace(ctx) { gitCalls.push(ctx.projections.map((p) => p.path)); } },
  });

  const result = await service.reconcileWorkspace(workspace(root));

  const byPath = Object.fromEntries(result.projections.map((p) => [p.path, p]));
  assert.equal(byPath['AGENTS.md'].skipped, undefined);
  assert.equal(byPath['CLAUDE.md'].skipped, true);
  assert.equal(byPath['GEMINI.md'].skipped, true);
  assert.match(await fs.promises.readFile(path.join(root, 'AGENTS.md'), 'utf8'), /Vectant_MANAGED_INSTRUCTIONS_BEGIN/);
  assert.deepEqual(gitCalls, [['AGENTS.md']]);
});
```

- [ ] **Step 10: Add a cleanup‑path test (`removeWorkspaceProjection`)**

```js
test('removeWorkspaceProjection skips a symlinked target instead of throwing', async (t) => {
  const root = await temporaryWorkspace(t);
  const claude = path.resolve(path.join(root, 'CLAUDE.md'));
  const fsApi = {
    ...fs.promises,
    async lstat(filePath) {
      if (path.resolve(filePath) === claude) {
        return { isSymbolicLink: () => true, isFile: () => false, isDirectory: () => false };
      }
      return fs.promises.lstat(filePath);
    },
  };
  const result = await createService({ fsApi })
    .removeWorkspaceProjection(workspace(root, { workspaceId: 'workspace_service_test' }));
  assert.equal(result.projections.find((p) => p.path === 'CLAUDE.md').external, true);
});
```

- [ ] **Step 11: Implement the cleanup skip in `removeWorkspaceProjection`**

At the top of the per‑projection loop, replace the unconditional `_readSnapshot` with:

```js
    const snapshot = await this._readSnapshot(activeWorkspaceRoot, target, { allowExternalSymlink: true });
    if (snapshot.external) {
      results.push({ path: normalizedRelativePath, removed: false, external: true });
      continue;
    }
    if (!snapshot.exists) {
      results.push({ path: normalizedRelativePath, removed: false, missing: true });
      continue;
    }
```

Also filter `.external` entries out of the list handed to `gitAdapter.removeWorkspace(... projections: results ...)`:

```js
      projections: results.filter((entry) => !entry.external),
```

- [ ] **Step 12: Run the full service suite**

```bash
node --test __tests__/workspaceInstructionProjectionService.test.js
```
Expected: all pass, including the untouched `'refuses an intermediate symlink in a future declarative projection path'` (that test targets an intermediate directory symlink, which still throws `unsafe_directory` — `allowExternalSymlink` only affects `isTarget`).

- [ ] **Step 13: Commit**

```bash
git add backend/collab-server/workspaceInstructionProjectionService.js backend/collab-server/__tests__/workspaceInstructionProjectionService.test.js
git commit -m "fix(collab): skip a symlinked instruction-projection target instead of aborting the workspace"
```

---

## Task 2: L1 write‑path guard — never merge the managed block into a skipped path

**Files:**
- Modify: `backend/collab-server/workspaceInstructionProjectionCollabAdapter.js`, `backend/collab-server/workspaceInstructionIdePresentation.js`
- Test: `backend/collab-server/__tests__/workspaceInstructionProjectionCollabAdapter.test.js`, `backend/collab-server/__tests__/workspaceInstructionIdePresentation.test.js`

With L1, a `sync`/`write-file` on the symlinked `CLAUDE.md` now succeeds (no 503). `prepareFileContentForIdeWrite()` → `mergeInstructionProjectionWriteFromIde()` currently decides "merge the block" purely from registry membership, so it would still inject the Vectant block into content written through the `CLAUDE.md` symlink. Fix: propagate the skip and make the classifier treat an `external` projection path as a plain file (no merge, no strip, no hide).

- [ ] **Step 1: Test — write path leaves a skipped projection unmerged**

In `workspaceInstructionProjectionCollabAdapter.test.js`:

```js
test('prepareFileContentForIdeWrite leaves a skipped (symlinked) projection path unmerged', () => {
  const projectionResult = {
    skipped: false,
    canonicalBlock: buildVectantBlock({ workspaceId: 'w', version: 2, content: 'x' }),
    projections: [
      { path: 'AGENTS.md', ownership: 'existing-user-file' },
      { path: 'CLAUDE.md', skipped: true, reason: 'external-symlink' },
    ],
  };
  assert.equal(
    prepareFileContentForIdeWrite({ path: 'CLAUDE.md', userContent: 'hi\n', projectionResult }),
    'hi\n',
  );
  assert.match(
    prepareFileContentForIdeWrite({ path: 'AGENTS.md', userContent: 'hi\n', projectionResult }),
    /Vectant_MANAGED_INSTRUCTIONS_BEGIN/,
  );
});
```
(`buildVectantBlock` is already imported at the top of that test file.)

- [ ] **Step 2: Run it — verify it fails** (`CLAUDE.md` output contains the block)

```bash
node --test --test-name-pattern="leaves a skipped" __tests__/workspaceInstructionProjectionCollabAdapter.test.js
```

- [ ] **Step 3: Carry `external` in `metadataFromProjectionResult`** (`workspaceInstructionProjectionCollabAdapter.js`)

```js
function metadataFromProjectionResult(result) {
  if (!result || result.skipped || !Array.isArray(result.projections)) return null;
  return {
    projections: Object.fromEntries(result.projections.map((projection) => [projection.path, {
      ownership: projection.ownership,
      external: Boolean(projection.skipped || projection.external),
    }])),
  };
}
```

- [ ] **Step 4: Honour `external` in `classifyInstructionProjectionForIde`** (`workspaceInstructionIdePresentation.js`)

After `const state = …projectionStateForPath(…)`:

```js
  const externalProjection = Boolean(state && state.external === true);
  const managedProjection = isInstructionProjection && !externalProjection;
```

Then replace subsequent uses of `isInstructionProjection` in that function with `managedProjection` for classification/return, and add `externalProjection` to the returned frozen object:

```js
  const classified = classifierResult(classifyProjection, {
    path: normalizedPath || String(path || ''),
    projectionMetadata,
    registry: enabledRegistry,
  }, state);
  const ownership = managedProjection ? validOwnership(classified?.ownership) : null;
  const syntheticOnly = managedProjection && ownership === PROJECTION_OWNERSHIP.SYNTHETIC_ONLY;

  return Object.freeze({
    path: normalizedPath || String(path || ''),
    isInstructionProjection: managedProjection,
    ownership,
    syntheticOnly,
    hideFromExplorer: syntheticOnly,
    externalProjection,
  });
```
This makes `mergeInstructionProjectionWriteFromIde` (checks `presentation.isInstructionProjection`) pass a skipped path straight through, and keeps it visible in the tree. The read path (`readInstructionProjectionForIde`) is unaffected — it receives no `projectionMetadata`, so `state`/`externalProjection` are always null/false there; a skipped symlink carries no block, so its `stripVectantBlock` stays a harmless no‑op.

- [ ] **Step 5: Test — classifier treats external as a plain file** (`workspaceInstructionIdePresentation.test.js`)

```js
test('classifyInstructionProjectionForIde treats an external (skipped) projection as a plain file', () => {
  const c = classifyInstructionProjectionForIde({
    path: 'CLAUDE.md',
    projectionMetadata: { projections: { 'CLAUDE.md': { external: true } } },
  });
  assert.equal(c.isInstructionProjection, false);
  assert.equal(c.hideFromExplorer, false);
  assert.equal(c.externalProjection, true);
});
```

- [ ] **Step 6: Run both suites — verify pass**

```bash
node --test __tests__/workspaceInstructionProjectionCollabAdapter.test.js __tests__/workspaceInstructionIdePresentation.test.js
```

- [ ] **Step 7: Commit**

```bash
git add backend/collab-server/workspaceInstructionProjectionCollabAdapter.js backend/collab-server/workspaceInstructionIdePresentation.js backend/collab-server/__tests__/workspaceInstructionProjectionCollabAdapter.test.js backend/collab-server/__tests__/workspaceInstructionIdePresentation.test.js
git commit -m "fix(collab): never merge the managed instruction block into a skipped (symlinked) projection path"
```

---

## Task 3: L2 — a projection failure is never fatal to a file op or the runtime

**Files:**
- Modify: `backend/collab-server/workspaceInstructionProjectionCollabAdapter.js` (new helper), `backend/collab-server/server.js`, `backend/collab-server/runtimeFilesystem.js`
- Test: `backend/collab-server/__tests__/workspaceInstructionProjectionCollabAdapter.test.js`, `backend/collab-server/__tests__/runtimeFilesystem.test.js`

- [ ] **Step 1: Tests for a new adapter helper `reconcileInstructionProjectionForIdeAction`**

In `workspaceInstructionProjectionCollabAdapter.test.js`:

```js
test('reconcileInstructionProjectionForIdeAction returns null for non-IDE actions', async () => {
  const r = await reconcileInstructionProjectionForIdeAction({
    runtime: { reconcile: async () => { throw new Error('should not run'); } },
    action: 'commit', workspaceId: 'w', repositoryRoot: '/tmp/w',
  });
  assert.equal(r, null);
});

test('reconcileInstructionProjectionForIdeAction degrades to skipped when reconcile throws', async () => {
  const warnings = [];
  const r = await reconcileInstructionProjectionForIdeAction({
    runtime: { reconcile: async () => { const e = new Error('boom'); e.code = 'workspace_instruction_projection_target_symlink_refused'; throw e; } },
    action: 'files-meta', workspaceId: 'w', repositoryRoot: '/tmp/w',
    logger: { warn: (evt, d) => warnings.push([evt, d]) },
  });
  assert.deepEqual(r, { skipped: true, reason: 'reconcile_failed' });
  assert.equal(warnings[0][0], 'workspace_instruction_projection_reconcile_failed');
  assert.equal(warnings[0][1].code, 'workspace_instruction_projection_target_symlink_refused');
});

test('reconcileInstructionProjectionForIdeAction passes a successful reconcile result through', async () => {
  const ok = { skipped: false, projections: [{ path: 'AGENTS.md', ownership: 'existing-user-file' }] };
  const r = await reconcileInstructionProjectionForIdeAction({
    runtime: { reconcile: async () => ok }, action: 'sync', workspaceId: 'w', repositoryRoot: '/tmp/w',
  });
  assert.equal(r, ok);
});
```

- [ ] **Step 2: Run — verify fail** (`reconcileInstructionProjectionForIdeAction is not defined`)

- [ ] **Step 3: Implement the helper** (`workspaceInstructionProjectionCollabAdapter.js`) and export it

```js
async function reconcileInstructionProjectionForIdeAction({
  runtime, action, workspaceId, repositoryRoot, activeWorkspacePath = '', logger = null,
}) {
  if (!shouldReconcileInstructionProjection(action)) return null;
  try {
    return await runtime.reconcile({ workspaceId, repositoryRoot, activeWorkspacePath: activeWorkspacePath || '' });
  } catch (error) {
    if (logger && typeof logger.warn === 'function') {
      logger.warn('workspace_instruction_projection_reconcile_failed', {
        workspaceId,
        action,
        code: error?.code || null,
        message: error?.message || String(error),
      });
    }
    return { skipped: true, reason: 'reconcile_failed' };
  }
}
```
Add `reconcileInstructionProjectionForIdeAction` to `module.exports`.

- [ ] **Step 4: Run — verify the 3 helper tests pass**

- [ ] **Step 5: Wire the helper into `server.js`**

Add `reconcileInstructionProjectionForIdeAction` to the destructured `require('./workspaceInstructionProjectionCollabAdapter')`. Replace the `if (shouldReconcileInstructionProjection(action)) { try { instructionProjection = await workspaceInstructionProjectionRuntime.reconcile({…}); } catch (projectionError) { logger.warn(…); res.writeHead(503, …); res.end(…'workspace_instruction_projection_unavailable'…); return; } }` block with:

```js
            let result;
            const instructionProjection = await reconcileInstructionProjectionForIdeAction({
              runtime: workspaceInstructionProjectionRuntime,
              action,
              workspaceId: slug,
              repositoryRoot: gitService.getEffectiveRepoPath(slug, effectiveUserId),
              activeWorkspacePath: data.activeWorkspacePath || '',
              logger,
            });
```
(The old code declared `let instructionProjection = null;` then reassigned; the helper returns `null` for non‑IDE actions, so a single `const` is correct. Confirm nothing later in that scope reassigns `instructionProjection` — grep shows it is only read: `projectionResult: instructionProjection`.) Downstream `presentFileTreeForIde` / `presentFileContentForIde` / `prepareFileContentForIdeWrite` already treat `{ skipped: true }` as feature‑off.

- [ ] **Step 6: `node --check` server.js**

```bash
node --check backend/collab-server/server.js
```

- [ ] **Step 7: Test — runtime hydration tolerates a `reconcile` throw** (`runtimeFilesystem.test.js`, follow the `setWorkspaceInstructionProjectionRuntimeForTests` pattern already in that file)

```js
test('runtime hydration tolerates an instruction projection reconcile failure', async () => {
  activityRegistry.resetRegistry();
  const restoreProjectionRuntime = setWorkspaceInstructionProjectionRuntimeForTests({
    reconcile: async () => { const e = new Error('boom'); e.code = 'workspace_instruction_projection_target_symlink_refused'; throw e; },
    cleanup: async () => ({ skipped: true }),
  });
  const restore = patchGitService({
    initRepo: async () => ({ success: true }),
    ensureUserRepo: async () => ({ path: '/tmp/runtime-proj-fail/user-1', created: true }),
    getEffectiveRepoPath: () => '/tmp/runtime-proj-fail/user-1',
  });
  try {
    await withControlPlaneActiveList('runtime-proj-fail', [], async () => {
      const result = await ensureRuntimeFilesystem({
        workspaceSlug: 'runtime-proj-fail', filesystemUserId: 'user-1',
        runtimeScope: 'proj-fail-term', pin: true, reason: 'interactive_terminal',
      });
      assert.equal(result.path, '/tmp/runtime-proj-fail/user-1');
      assert.equal(result.instructionProjection.skipped, true);
      assert.equal(result.instructionProjection.reason, 'reconcile_failed');
    });
  } finally {
    await releaseRuntimeFilesystem('proj-fail-term');
    restoreProjectionRuntime();
    activityRegistry.resetRegistry();
    restore();
  }
});
```

- [ ] **Step 8: Run — verify fail** (`ensureRuntimeFilesystem` currently rejects)

- [ ] **Step 9: Guard the `reconcile()` call in `runtimeFilesystem.js` `reconcileRuntimeInstructionProjection`**

```js
async function reconcileRuntimeInstructionProjection(result, activeWorkspacePath = '') {
  const projectionInput = { workspaceId: result.slug, repositoryRoot: result.path };
  if (activeWorkspacePath) projectionInput.activeWorkspacePath = activeWorkspacePath;
  let projection;
  try {
    projection = await workspaceInstructionProjectionRuntime.reconcile(projectionInput);
  } catch (error) {
    console.warn(
      `[RuntimeFS] Instruction projection reconcile failed for ${result.slug}`
      + `${activeWorkspacePath ? ` (${activeWorkspacePath})` : ''}: ${error?.code || error?.message || error}`,
    );
    return {
      ...result,
      activeWorkspacePath: activeWorkspacePath || '',
      instructionProjection: { skipped: true, reason: 'reconcile_failed' },
    };
  }
  return {
    ...result,
    activeWorkspaceRoot: projection.activeWorkspaceRoot || result.path,
    // ...rest unchanged...
  };
}
```

- [ ] **Step 10: Run — verify pass**

```bash
node --check backend/collab-server/runtimeFilesystem.js
node --test __tests__/runtimeFilesystem.test.js __tests__/workspaceInstructionProjectionCollabAdapter.test.js
```

- [ ] **Step 11: Commit**

```bash
git add backend/collab-server/workspaceInstructionProjectionCollabAdapter.js backend/collab-server/server.js backend/collab-server/runtimeFilesystem.js backend/collab-server/__tests__/workspaceInstructionProjectionCollabAdapter.test.js backend/collab-server/__tests__/runtimeFilesystem.test.js
git commit -m "fix(collab): treat any instruction-projection reconcile failure as non-fatal (no 503/500)"
```

---

## Task 4: Add the lifecycle suites to CI

`.github/workflows/codesite-tests.yml`'s `collab-server` job runs a fixed list of suites and does **not** include the projection lifecycle or `runtimeFilesystem` suites — so this class of bug had zero CI coverage.

- [ ] **Step 1:** In the `collab-server` job's `node --test` command, append:

```
               __tests__/workspaceInstructionProjectionService.test.js \
               __tests__/workspaceInstructionProjectionRuntime.test.js \
               __tests__/workspaceInstructionProjectionCollabAdapter.test.js \
               __tests__/workspaceInstructionIdePresentation.test.js \
               __tests__/runtimeFilesystem.test.js
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/codesite-tests.yml
git commit -m "ci(collab): cover the instruction-projection + runtime-filesystem lifecycle suites"
```

---

## Task 5: Full verification

- [ ] **Step 1: Every touched + adjacent suite**

```bash
cd backend/collab-server
node --test \
  __tests__/workspaceInstructionProjectionService.test.js \
  __tests__/workspaceInstructionProjectionRuntime.test.js \
  __tests__/workspaceInstructionProjectionConfig.test.js \
  __tests__/workspaceInstructionProjectionCollabAdapter.test.js \
  __tests__/workspaceInstructionProjectionObservability.test.js \
  __tests__/workspaceInstructionIdePresentation.test.js \
  __tests__/workspaceInstructionGitIsolation.test.js \
  __tests__/workspaceInstructionMetadataStore.test.js \
  __tests__/workspaceInstructionProjection.test.js \
  __tests__/runtimeFilesystem.test.js
```
Expected: **all pass**, zero regressions vs the Task 0 baseline.

- [ ] **Step 2: The CI collab‑server batch (with the additions from Task 4)**

```bash
node --test \
  __tests__/codesiteFs.test.js __tests__/codesiteActivityRegistry.test.js \
  __tests__/agentSessionAttachService.test.js __tests__/terminalServiceAgentLifecycle.test.js \
  __tests__/runtimeObservationPublisher.test.js __tests__/programRuntimeManager.test.js \
  __tests__/sessionWorkspaceAccess.test.js \
  __tests__/workspaceInstructionProjectionService.test.js __tests__/workspaceInstructionProjectionRuntime.test.js \
  __tests__/workspaceInstructionProjectionCollabAdapter.test.js __tests__/workspaceInstructionIdePresentation.test.js \
  __tests__/runtimeFilesystem.test.js
```
Expected: pass, except the exact pre‑existing Windows‑only `codesiteFs.test.js` failures recorded in Task 0 (re‑run just those on the Linux worktree if possible, or note they are environmental).

- [ ] **Step 3: Broad sweep + syntax check**

```bash
node --test __tests__/ 2>&1 | tail -30
node --check backend/collab-server/server.js
node --check backend/collab-server/runtimeFilesystem.js
node --check backend/collab-server/workspaceInstructionProjectionService.js
node --check backend/collab-server/workspaceInstructionProjectionCollabAdapter.js
node --check backend/collab-server/workspaceInstructionIdePresentation.js
```

- [ ] **Step 4: Manual reproduction trace** (documented in the commit / `tasks/todo.md` review section, not automated): confirm that with a real on‑disk layout of `AGENTS.md` (file) + `CLAUDE.md`/`GEMINI.md` (symlinks) — creatable on the Linux worktree with `fs.symlinkSync` — `reconcileWorkspace` resolves, `AGENTS.md` gains the block, both symlinks and their target are byte‑unchanged, and `git -C <root> check-attr filter -- AGENTS.md` shows the managed `vectant-instr-*` filter is installed (self‑heal path).

- [ ] **Step 5: Write the review section** into `tasks/todo.md` (CLAUDE.md step 5): what changed, the baseline vs post‑change test deltas, and the manual‑trace result.

---

## Task 6: Land on `main`

Local `main` is at `bc6989ae2` with **zero** unique commits (a pure ancestor of `origin/main`), so it fast‑forwards cleanly.

- [ ] **Step 1: Push the fix branch**

```bash
git push -u origin fix/workspace-instruction-projection-symlink-resilience
```

- [ ] **Step 2: Fast‑forward local `main` to `origin/main` and merge (in the worktree — `main` is checked out nowhere)**

```bash
git fetch origin main
git branch -f main origin/main
git checkout main
git merge --no-ff fix/workspace-instruction-projection-symlink-resilience \
  -m "Merge: workspace instruction projection symlink resilience (fixes cloned-repo workspace outage)"
```

- [ ] **Step 3: Re‑run the Task 5 Step 1 + Step 2 suites on the merged `main`** (catch any interaction with commits that landed on `origin/main` since branch creation). Expected: green.

- [ ] **Step 4: CHECKPOINT — do not push `main` yet.** Report to the user: the merge commit, `git log --oneline origin/main..main`, the full Task 5 test output, and the `git diff --stat origin/main..main`. Wait for an explicit go‑ahead before:

```bash
git push origin main
```

- [ ] **Step 5: Release the worktree**

```bash
git checkout fix/workspace-instruction-projection-symlink-resilience   # free the main ref
# keep the worktree until the user confirms the Cloud Build deploy succeeded, then:
git worktree remove C:/Users/HP/source/repos/vectant-fix-instruction-projection
```

- [ ] **Step 6: Confirm the primary tree is untouched**

```bash
git -C C:/Users/HP/source/repos/synthi-ide status --porcelain
```
Expected: byte‑identical to the session start (the demo WIP + untracked demo dirs, nothing else).

---

## Deploy (user‑run, out of scope for implementation)

Per `tasks/todo.md` / project memory: GitHub Actions does not deploy. The user runs `gcloud builds submit --config cloudbuild.yaml .` (standard prod invocation, `k8s/overlays/dojo-release-gate`), then verifies the live collab‑server pod image tag. Ships all of current `main`, not just this fix.

Post‑deploy check: open a workspace that previously hit the bug (or re‑clone `pascalorg/editor`); confirm the file tree loads, saves work, the runtime comes up, and `AGENTS.md` no longer shows a spurious `git` modification (the git filter installs on the first successful reconcile).

---

## Risks / notes

- **Scope of the deploy:** shipping `main` carries ~1,761 unrelated commits since the last deploy. That is the established beta process, but it is not a minimal hot‑fix. If the user wants a minimal ship, an alternative is a `hotfix/` branch off the **currently deployed** commit (`bc6989ae2`) with only these changes — more work to reconcile, and still needs a manual build. Default plan targets `main`.
- **No live end‑to‑end test from here** (no GKE access). Confidence rests on: unit/integration tests that reproduce the exact failure chain (service throw → 503/500), the full collab‑server suite, and the manual symlink trace on Linux. The user performs the live check post‑deploy.
- **Windows dev box:** new tests use injected fake `fsApi` (existing pattern) so they pass locally and on Linux CI. Real `fs.symlink` on Windows needs developer mode; the Task 5 Step 4 manual trace runs on the Linux worktree checkout.
- **Intermediate‑directory symlinks** (`unsafe_directory`) intentionally still throw — not reachable with the current flat `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` registry, and L2 now catches it anyway if a future nested projection hits it.
- **Rollback:** `WORKSPACE_INSTRUCTION_PROJECTION_ROLLOUT=off` is **not** a usable emergency lever today (the cleanup path also throws on symlinked targets) — L1 fixes both paths. If needed after deploy, reverting the merge commit and rebuilding is the rollback.
