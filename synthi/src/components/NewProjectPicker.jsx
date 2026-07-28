'use client';

/**
 * NewProjectPicker - modal shown in two contexts:
 *
 *   1. **Scaffold mode** (default, opened from FileTree on an empty
 *      workspace): templates write starter files via
 *      `scaffoldProjectThunk`. The "Other" tile opens an inline
 *      build-brief input; on submit the picker dispatches a window
 *      `synthi:jumpstart-trigger` event that the workspace page wires
 *      into the existing AI chat jumpstart path.
 *
 *   2. **Jumpstart mode** (opened from the dashboard's brief launcher
 *      section): the picker only *records* the user's project-type
 *      choice; no scaffolding happens, no thunks fire. The chosen
 *      template + variant is returned via `onPick` so the dashboard
 *      can persist it alongside the build brief. "Other" returns a
 *      null project type (blank canvas).
 *
 * Opened from anywhere wrapped by `<NewProjectPickerProvider>` (mounted
 * in [app/layout.js](../app/layout.js)).
 *   - `openPicker()`             → scaffold mode (back-compat)
 *   - `openPickerForJumpstart()` → jumpstart mode; returns a promise
 *     that resolves with the user's pick (or null if dismissed)
 *
 * See [project-templates/index.js](../lib/project-templates/index.js) for
 * the template registry, and
 * [workspaceSlice.js](../redux/workspaceSlice.js) for the scaffold thunks.
 */

import {
  useState,
  useCallback,
  useMemo,
  useRef,
  createContext,
  useContext,
} from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, FilePlus, FolderPlus } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { useAppDispatch } from '@/redux/hooks';
import {
  scaffoldProjectThunk,
  createFileWithExtensionThunk,
} from '@/redux/workspaceSlice';
import {
  PROJECT_TEMPLATES,
  OTHER_TEMPLATE,
  OTHER_TEMPLATE_ID,
  FILE_TYPES,
  hasVariants,
  formatSystemPromptAddition,
} from '@/lib/project-templates';

// ─── Context ───────────────────────────────────────────────────────

const NewProjectPickerContext = createContext({
  openPicker: () => {},
  openPickerForJumpstart: async () => null,
  isPickerOpen: false,
});

export function useNewProjectPicker() {
  return useContext(NewProjectPickerContext);
}

// ─── Provider ──────────────────────────────────────────────────────

export function NewProjectPickerProvider({ children }) {
  // `mode` - 'scaffold' (default) or 'jumpstart'.
  const [state, setState] = useState({ open: false, mode: 'scaffold' });
  // Jumpstart-mode resolver: when the dashboard calls
  // openPickerForJumpstart() it awaits a Promise that resolves with the
  // user's pick (or null on dismiss).
  const resolveRef = useRef(null);

  const openPicker = useCallback(() => {
    setState({ open: true, mode: 'scaffold' });
  }, []);

  const openPickerForJumpstart = useCallback(() => {
    return new Promise((resolve) => {
      resolveRef.current = resolve;
      setState({ open: true, mode: 'jumpstart' });
    });
  }, []);

  const closePicker = useCallback((result) => {
    setState({ open: false, mode: 'scaffold' });
    if (resolveRef.current) {
      resolveRef.current(result || null);
      resolveRef.current = null;
    }
  }, []);

  const ctx = useMemo(
    () => ({
      openPicker,
      openPickerForJumpstart,
      isPickerOpen: state.open,
    }),
    [openPicker, openPickerForJumpstart, state.open],
  );

  return (
    <NewProjectPickerContext.Provider value={ctx}>
      {children}
      <NewProjectPickerDialog
        open={state.open}
        mode={state.mode}
        onClose={closePicker}
      />
    </NewProjectPickerContext.Provider>
  );
}

// ─── Tile ──────────────────────────────────────────────────────────

function Tile({ icon: Icon, label, description, onClick, disabled, highlight }) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.button
      type="button"
      onClick={onClick}
      disabled={disabled}
      whileHover={disabled || reduceMotion ? undefined : { x: 2 }}
      whileTap={disabled || reduceMotion ? undefined : { scale: 0.992 }}
      transition={{ duration: reduceMotion ? 0 : 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="group grid min-h-[76px] grid-cols-[2.25rem_minmax(0,1fr)_auto] items-center gap-3 rounded-[var(--radius-control)] border px-3 py-2 text-left transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        borderColor: highlight ? 'var(--accent-primary)' : 'var(--border-medium)',
        background: highlight
          ? 'color-mix(in srgb, var(--accent-primary) 9%, var(--bg-panel))'
          : 'color-mix(in srgb, var(--bg-panel) 78%, var(--bg-editor) 22%)',
      }}
      onMouseEnter={(e) => {
        if (disabled) return;
        e.currentTarget.style.borderColor = 'var(--accent-primary)';
        e.currentTarget.style.background = 'color-mix(in srgb, var(--accent-primary) 7%, var(--bg-panel))';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = highlight
          ? 'var(--accent-primary)'
          : 'var(--border-medium)';
        e.currentTarget.style.background = highlight
          ? 'color-mix(in srgb, var(--accent-primary) 9%, var(--bg-panel))'
          : 'color-mix(in srgb, var(--bg-panel) 78%, var(--bg-editor) 22%)';
      }}
    >
      <div
        className="flex h-9 w-9 items-center justify-center rounded-[var(--radius-control)] border transition-colors duration-150"
        style={{
          background: 'color-mix(in srgb, var(--accent-primary) 8%, transparent)',
          borderColor: 'color-mix(in srgb, var(--accent-primary) 24%, transparent)',
        }}
      >
        {Icon ? (
          <Icon
            className="h-5 w-5"
            style={{ color: 'var(--accent-primary)' }}
          />
        ) : null}
      </div>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium text-sm" style={{ color: 'var(--text-primary)' }}>
          {label}
        </span>
        {description && (
          <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>
            {description}
          </span>
        )}
      </div>
      <ArrowRight
        className="h-4 w-4 opacity-55 transition-transform duration-150 group-hover:translate-x-0.5"
        style={{ color: 'var(--text-muted)' }}
      />
    </motion.button>
  );
}

// ─── Dialog ────────────────────────────────────────────────────────

function NewProjectPickerDialog({ open, mode, onClose }) {
  const dispatch = useAppDispatch();
  const [tab, setTab] = useState('projects');
  // Step: "list" | "variant" | "file-name" | "other-prompt"
  const [step, setStep] = useState('list');
  const [pendingTemplate, setPendingTemplate] = useState(null);
  const [pendingFile, setPendingFile] = useState(null);
  const [fileName, setFileName] = useState('');
  const [otherPrompt, setOtherPrompt] = useState('');
  const [busy, setBusy] = useState(false);

  const reset = useCallback(() => {
    setTab('projects');
    setStep('list');
    setPendingTemplate(null);
    setPendingFile(null);
    setFileName('');
    setOtherPrompt('');
    setBusy(false);
  }, []);

  const handleClose = useCallback(
    (result) => {
      reset();
      onClose(result);
    },
    [reset, onClose],
  );

  // ─── Project tile handler ────────────────────────────────────────
  const handleProjectTile = useCallback(
    (template) => {
      // OTHER's behavior diverges by mode.
      if (template.id === OTHER_TEMPLATE_ID) {
        if (mode === 'jumpstart') {
          // Dashboard flow: just record "no project type" and close.
          handleClose({ template: OTHER_TEMPLATE, variant: null });
          return;
        }
        // Scaffold flow: show an inline AI-description input.
        setStep('other-prompt');
        return;
      }
      if (hasVariants(template)) {
        setPendingTemplate(template);
        setStep('variant');
        return;
      }
      if (mode === 'jumpstart') {
        handleClose({ template, variant: null });
        return;
      }
      void runScaffold(template, null);
    },
    [mode, handleClose],
  );

  const handleVariantTile = useCallback(
    (variant) => {
      if (mode === 'jumpstart') {
        handleClose({ template: pendingTemplate, variant });
        return;
      }
      void runScaffold(pendingTemplate, variant);
    },
    [mode, pendingTemplate, handleClose],
  );

  async function runScaffold(template, variant) {
    setBusy(true);
    try {
      const files = variant?.files || template.files;
      const manifest = variant?.manifest || template.manifest;
      const label = variant ? `${template.label} (${variant.label})` : template.label;
      const res = await dispatch(scaffoldProjectThunk({ files, manifest, label }));
      if (scaffoldProjectThunk.rejected.match(res)) {
        toast.error(`Scaffold failed: ${res.error?.message || 'Unknown error'}`);
        setBusy(false);
        return;
      }
      const install = res.payload?.install;
      if (install?.error) {
        toast.success(`Created ${label} project`);
        toast.error(`Could not start ${install.label || 'dependency install'}: ${install.error}`);
      } else if (install?.sessionId) {
        toast.success(`Created ${label} project. Running ${install.label} in Terminal.`);
      } else if (install?.started) {
        toast.success(`Created ${label} project and installed dependencies.`);
      } else {
        toast.success(`Created ${label} project`);
      }
      handleClose();
    } catch (err) {
      toast.error(`Scaffold failed: ${err?.message || err}`);
      setBusy(false);
    }
  }

  // ─── Other → in-workspace build brief ────────────────────────────
  async function handleOtherSubmit() {
    const text = otherPrompt.trim();
    if (!text) return;
    setBusy(true);
    // Compose a small directive header so the jumpstart route can pick
    // the stack itself.
    const composed = `[PROJECT TYPE: Custom / blank canvas]\nThe user is starting from an empty workspace and wants Vectant to choose the stack and create all files needed. Bias toward the simplest viable tech for the request.\n\n${text}`;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(
        new CustomEvent('synthi:jumpstart-trigger', {
          detail: { prompt: composed, attachments: [] },
        }),
      );
    }
    toast.success('Build brief dispatched');
    handleClose();
  }

  // ─── File tile handlers ──────────────────────────────────────────
  const handleFileTile = useCallback((fileType) => {
    setPendingFile(fileType);
    setFileName(fileType.defaultName);
    setStep('file-name');
  }, []);

  async function handleConfirmFile() {
    if (!pendingFile || !fileName.trim()) return;
    setBusy(true);
    try {
      const res = await dispatch(
        createFileWithExtensionThunk({ name: fileName.trim(), ext: pendingFile.ext }),
      );
      if (createFileWithExtensionThunk.rejected.match(res)) {
        toast.error(`Create failed: ${res.error?.message || 'Unknown error'}`);
        setBusy(false);
        return;
      }
      toast.success(`Created ${fileName.trim()}.${pendingFile.ext}`);
      handleClose();
    } catch (err) {
      toast.error(`Create failed: ${err?.message || err}`);
      setBusy(false);
    }
  }

  const handleBack = useCallback(() => {
    setStep('list');
    setPendingTemplate(null);
    setPendingFile(null);
    setFileName('');
    setOtherPrompt('');
  }, []);

  // ─── Variant sub-step ────────────────────────────────────────────
  if (step === 'variant' && pendingTemplate) {
    return (
      <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleBack}
                className="vt-icon-button th-focus-ring"
                aria-label="Back"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <DialogTitle>{pendingTemplate.label} - choose build setup</DialogTitle>
            </div>
            <DialogDescription>Pick which build system to scaffold.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2 pt-2">
            {pendingTemplate.variants.map((v) => (
              <Tile
                key={v.id}
                icon={pendingTemplate.icon}
                label={v.label}
                description={v.description}
                onClick={() => handleVariantTile(v)}
                disabled={busy}
              />
            ))}
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // ─── File-name sub-step ──────────────────────────────────────────
  if (step === 'file-name' && pendingFile) {
    return (
      <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleBack}
                className="vt-icon-button th-focus-ring"
                aria-label="Back"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <DialogTitle>Name your {pendingFile.label} file</DialogTitle>
            </div>
            <DialogDescription>
              Will be saved as <code>{fileName || pendingFile.defaultName}.{pendingFile.ext}</code>
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2 pt-2">
            <Input
              value={fileName}
              autoFocus
              onChange={(e) => setFileName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleConfirmFile();
              }}
              placeholder={pendingFile.defaultName}
            />
            <span
              className="text-sm font-mono"
              style={{ color: 'var(--text-secondary)' }}
            >
              .{pendingFile.ext}
            </span>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={handleBack} disabled={busy}>
              Back
            </Button>
            <Button onClick={() => void handleConfirmFile()} disabled={busy || !fileName.trim()}>
              Create
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // ─── Other → build brief sub-step (scaffold mode only) ───────────
  if (step === 'other-prompt') {
    return (
      <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleBack}
                className="vt-icon-button th-focus-ring"
                aria-label="Back"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <DialogTitle>Write the build brief</DialogTitle>
            </div>
            <DialogDescription>
              Vectant will choose the runtime, scaffold the files, and keep the first pass inspectable.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 pt-2">
            <textarea
              autoFocus
              value={otherPrompt}
              onChange={(e) => {
                if (e.target.value.length <= 2000) setOtherPrompt(e.target.value);
              }}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void handleOtherSubmit();
              }}
              rows={6}
              maxLength={2000}
              placeholder="Internal Go CLI that watches a folder, validates changed files, and ships them to S3."
              className="w-full resize-y rounded-[var(--radius-panel)] px-3 py-2.5 text-sm outline-none transition-colors"
              style={{
                background: 'var(--bg-editor)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-medium)',
                minHeight: 120,
                maxHeight: 280,
              }}
            />
            <div className="flex items-center justify-between">
              <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
                {otherPrompt.length}/2000
              </span>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={handleBack} disabled={busy}>
              Back
            </Button>
            <Button
              onClick={() => void handleOtherSubmit()}
              disabled={busy || !otherPrompt.trim()}
            >
              Dispatch brief
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  // ─── Default: tab list ───────────────────────────────────────────
  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            {mode === 'jumpstart' ? 'Choose a project shape' : 'Start a new workspace'}
          </DialogTitle>
          <DialogDescription>
            {mode === 'jumpstart'
              ? 'Select the closest runtime shape. The detailed brief comes next.'
              : 'Choose a scaffold or create a single file without leaving the workspace.'}
          </DialogDescription>
        </DialogHeader>
        {mode === 'jumpstart' ? (
          <div className="grid max-h-[60vh] gap-2 overflow-y-auto pt-2 pr-1">
            {PROJECT_TEMPLATES.map((t) => (
              <Tile
                key={t.id}
                icon={t.icon}
                label={t.label}
                description={t.description}
                onClick={() => handleProjectTile(t)}
                disabled={busy}
              />
            ))}
            <Tile
              key={OTHER_TEMPLATE.id}
              icon={OTHER_TEMPLATE.icon}
              label={OTHER_TEMPLATE.label}
              description="Open brief - Vectant chooses the runtime"
              onClick={() => handleProjectTile(OTHER_TEMPLATE)}
              disabled={busy}
              highlight
            />
          </div>
        ) : (
          <Tabs value={tab} onValueChange={setTab} className="pt-2">
            <TabsList>
              <TabsTrigger value="projects">
                <FolderPlus className="h-3.5 w-3.5" />
                Projects
              </TabsTrigger>
              <TabsTrigger value="files">
                <FilePlus className="h-3.5 w-3.5" />
                Files
              </TabsTrigger>
            </TabsList>
            <TabsContent value="projects">
              <div className="grid max-h-[60vh] gap-2 overflow-y-auto pt-2 pr-1">
                {PROJECT_TEMPLATES.map((t) => (
                  <Tile
                    key={t.id}
                    icon={t.icon}
                    label={t.label}
                    description={t.description}
                    onClick={() => handleProjectTile(t)}
                    disabled={busy}
                  />
                ))}
                <Tile
                  key={OTHER_TEMPLATE.id}
                  icon={OTHER_TEMPLATE.icon}
                  label={OTHER_TEMPLATE.label}
                  description={OTHER_TEMPLATE.description}
                  onClick={() => handleProjectTile(OTHER_TEMPLATE)}
                  disabled={busy}
                  highlight
                />
              </div>
            </TabsContent>
            <TabsContent value="files">
              <div className="grid max-h-[60vh] gap-2 overflow-y-auto pt-2 pr-1">
                {FILE_TYPES.map((f) => (
                  <Tile
                    key={f.id}
                    icon={f.icon}
                    label={f.label}
                    description={`.${f.ext}`}
                    onClick={() => handleFileTile(f)}
                    disabled={busy}
                  />
                ))}
              </div>
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ─── Public helper re-exports ───────────────────────────────────────
// Surface the prompt-formatting helper from this module too so the
// dashboard can `import { formatSystemPromptAddition } from
// '@/components/NewProjectPicker'` if it prefers a single import path.
export { formatSystemPromptAddition };
