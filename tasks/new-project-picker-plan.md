# New-Workspace Project & File Picker — Plan 2026-05-12

## Goal
When a user opens a workspace with **zero files** and clicks "New File", show a
two-tab modal (Files / Projects) styled like ThemeCreator. Projects tab
scaffolds an entire starter project from a frontend template registry (or, for
React-Native-Android, drops a `package.json` so the worker's existing
`ensure_android_gradle_project()` fires on first compile). After scaffold,
populate `compileManifestSlice` so the bottom-right framework pill shows
immediately.

## Architectural decisions (confirmed with user)
1. Project types with no existing scaffolder → ship as **frontend template registry**.
2. Trigger: **only** when "New File" is invoked on an empty workspace. Normal new-file UX is preserved once files exist.
3. Auto-tag: write into [compileManifestSlice](synthi/src/redux/compileManifestSlice.js) directly (synthetic arch markdown with `## Language & Framework`).
4. Files tab: type-tile → name prompt → single file with right extension.

## Constraints from research
- [ensure_android_gradle_project()](backend/synthi-webrtc-compiler/worker/src/android/react_native/project_init.rs#L10) lives in the **Rust worker** and only fires inside `build_apk_for_emulator()`. The frontend cannot call it directly — the only way to trigger it is to compile.
- ✅ Workaround for RN-Android: write a valid `package.json` (with `react-native` dep) + a stub `App.tsx`. On first compile the worker auto-scaffolds `android/`.
- ❌ Flutter-Android: same constraint, needs `pubspec.yaml` + `lib/main.dart`.
- No iOS scaffolder in the worker — skip iOS entirely or treat as "React Native (iOS deferred)".

## File layout (new code)

```
synthi/src/components/NewProjectPicker.jsx        ← Provider + modal (NEW)
synthi/src/lib/project-templates/
  index.js                                        ← registry + types (NEW)
  templates/
    python.js                                     ← {files: [...], manifest}
    node.js
    react.js
    cpp.js
    rust.js
    java.js
    react-native-android.js
    flutter-android.js
    typescript.js
```

Each template exports:
```js
{
  id: 'python',
  label: 'Python',
  icon: 'Python',           // lucide name or local svg key
  description: 'main.py + requirements.txt',
  files: [
    { path: 'main.py', content: 'print("Hello from Synthi")\n' },
    { path: 'requirements.txt', content: '' },
  ],
  manifest: { languageAndFramework: 'Python' },   // pre-canned arch md fragment
}
```

## Wiring points (edits to existing code)

| # | File | Change |
|---|------|--------|
| 1 | [synthi/src/app/layout.js:47-53](synthi/src/app/layout.js#L47-L53) | Wrap children in `<NewProjectPickerProvider>` alongside ThemeCreatorProvider. |
| 2 | [synthi/src/app/workspace/[slug]/FileTree.jsx:101-115](synthi/src/app/workspace/[slug]/FileTree.jsx#L101-L115) | In `handleTreeAction`, if `action === 'new-file*'` AND `files.length === 0`, call `openPicker()` instead of dispatching `startCreate`. |
| 3 | [synthi/src/redux/workspaceSlice.js](synthi/src/redux/workspaceSlice.js) | Add new thunk `scaffoldProjectThunk({ template })` that calls `gitClient.writeFilesBatch(slug, template.files, { syncToGcs: true })`, then dispatches `setCompileManifest({architecture: synthMdFromTemplate(template)})`, then `fetchFilesThunk`. |
| 4 | [synthi/src/components/NewProjectPicker.jsx](synthi/src/components/NewProjectPicker.jsx) | New: Radix Dialog with two-tab UI (`Files` / `Projects`), tile grid, name-prompt for files tab, calls `scaffoldProjectThunk` for projects tab. |

## Template list (initial)

**Projects tab**
- Python (main.py + requirements.txt)
- Node.js (package.json + index.js)
- TypeScript (package.json + src/index.ts + tsconfig.json)
- React (Vite minimal — package.json + index.html + src/main.jsx + App.jsx)
- C++ (main.cpp + CMakeLists.txt)
- Rust (Cargo.toml + src/main.rs)
- Java (Main.java + pom.xml *or* plain `src/Main.java`)
- React Native Android (package.json with `react-native: 0.73.6` + App.tsx + app.json + index.js — worker scaffolds `android/` on first compile)
- Flutter Android (pubspec.yaml + lib/main.dart)

**Files tab**
- Python `.py`, TypeScript `.ts`, JavaScript `.js`, C++ `.cpp`, C `.c`, Header `.h`, Java `.java`, Rust `.rs`, Markdown `.md`, JSON `.json`, YAML `.yaml`, Plain text `.txt`

## Auto-tagging implementation

`compileManifestSlice.setCompileManifest({ architecture })` runs `parseLanguageAndFramework()` which is a regex over `## Language & Framework\n<body>`. So `synthMdFromTemplate` just emits:

```
## Language & Framework
React Native (Android)
```

Bottom-right pill picks it up automatically via existing `selectLanguageAndFramework` selector. **Zero changes to StatusBar.jsx.**

## Checklist

- [ ] Create `synthi/src/lib/project-templates/` dir + 9 template files + `index.js` registry
- [ ] Create `synthi/src/components/NewProjectPicker.jsx` (Provider + Dialog + tabs)
- [ ] Add `scaffoldProjectThunk` to `workspaceSlice.js`
- [ ] Mount `NewProjectPickerProvider` in `app/layout.js`
- [ ] Edit `FileTree.jsx` `handleTreeAction` to gate on `files.length === 0`
- [ ] Smoke test: empty workspace → new file → modal opens → pick Python → verify files appear → verify "Python" pill in bottom-right
- [ ] Smoke test: workspace with existing files → new file → inline rename (no modal)
- [ ] Smoke test: RN-Android scaffold → compile → worker scaffolds `android/` without error

## Out of scope (explicit)
- iOS scaffolding (no worker support)
- Editing the worker's `BuildTarget` enum or scaffolders
- Persisting template selection / user-favorite projects
- Multi-language project starters (e.g. fullstack templates)
- Reworking StatusBar.jsx
