"use client";

import { useState, useCallback, useRef, useMemo } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useNewProjectPicker } from "@/components/NewProjectPicker";
import {
  Sparkles,
  Paperclip,
  X,
  FileText,
  ImageIcon,
  AlertCircle,
  FolderPlus,
  Check,
} from "lucide-react";

/* ──────────────────── constants ──────────────────── */

/** Max total attachment size in bytes (10 MB) */
const MAX_TOTAL_SIZE = 10 * 1024 * 1024;
/** Max single file size in bytes (5 MB) */
const MAX_FILE_SIZE = 5 * 1024 * 1024;
/** Max prompt length in characters */
const MAX_PROMPT_LENGTH = 2000;
/** Allowed MIME prefixes */
const ALLOWED_TYPES = [
  "text/",
  "application/json",
  "application/javascript",
  "application/typescript",
  "application/xml",
  "application/yaml",
  "application/x-yaml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
];
/** Max number of attached files */
const MAX_FILES = 10;

/* ──────────────────── helpers ──────────────────── */

function isAllowedType(file) {
  return ALLOWED_TYPES.some((t) => file.type.startsWith(t));
}

function humanFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileIcon(file) {
  if (file.type.startsWith("image/")) {
    return <ImageIcon className="h-3.5 w-3.5 shrink-0" />;
  }
  return <FileText className="h-3.5 w-3.5 shrink-0" />;
}

/**
 * Read a File object as base64 data URL (for images) or text (for text files).
 * Returns { name, size, type, content, kind }.
 */
function readFileAsync(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    const isImage = file.type.startsWith("image/");

    reader.onload = () => {
      resolve({
        id: `upload-${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        size: file.size,
        type: file.type,
        content: reader.result,
        kind: isImage ? "image" : "text",
      });
    };
    reader.onerror = () => reject(new Error(`Failed to read ${file.name}`));

    if (isImage) {
      reader.readAsDataURL(file);
    } else {
      reader.readAsText(file);
    }
  });
}

/* ──────────────────── component ──────────────────── */

/**
 * AI Jumpstart section for the "Create Repository" form.
 *
 * The prompt textarea is gated behind a project-type pick: when AI
 * Jumpstart is enabled, the user must first choose a project type
 * (via the shared NewProjectPicker in jumpstart mode) before the
 * textarea unlocks. The picked type is passed up to the parent via
 * `onProjectTypeChange` so the dashboard can persist it in the
 * sessionStorage payload alongside the prompt.
 *
 * @param {{
 *   enabled: boolean,
 *   onEnabledChange: (v: boolean) => void,
 *   prompt: string,
 *   onPromptChange: (v: string) => void,
 *   attachments: Array,
 *   onAttachmentsChange: (v: Array) => void,
 *   projectType: object|null,
 *   onProjectTypeChange: (pt: object|null) => void,
 *   disabled: boolean,
 * }} props
 */
export default function AIJumpstartSection({
  enabled,
  onEnabledChange,
  prompt,
  onPromptChange,
  attachments,
  onAttachmentsChange,
  projectType,
  onProjectTypeChange,
  disabled = false,
}) {
  const fileInputRef = useRef(null);
  const expandRef = useRef(null);
  const [attachError, setAttachError] = useState(null);
  const { openPickerForJumpstart } = useNewProjectPicker();

  // Prompt textarea is unlocked only after a project type is picked.
  // "Other" / blank canvas is represented as { id: 'other', ... } and
  // also unlocks the input.
  const typeChosen = !!projectType;

  const handlePickType = useCallback(async () => {
    const result = await openPickerForJumpstart();
    if (!result) return;
    // result.template is the template object; result.variant is the
    // variant (or null). Flatten for the parent + payload.
    const tpl = result.template;
    const variant = result.variant;
    const label = variant ? `${tpl.label} (${variant.label})` : tpl.label;
    const hint = variant?.systemPromptHint || tpl.systemPromptHint || "";
    onProjectTypeChange({
      id: tpl.id,
      label,
      variant: variant?.id || null,
      systemPromptHint: hint,
    });
  }, [openPickerForJumpstart, onProjectTypeChange]);

  const handleClearType = useCallback(() => {
    onProjectTypeChange(null);
  }, [onProjectTypeChange]);

  /* ── derived ── */
  const totalSize = useMemo(
    () => attachments.reduce((sum, a) => sum + a.size, 0),
    [attachments],
  );

  /* ── file handling ── */
  const handleFiles = useCallback(
    async (files) => {
      setAttachError(null);
      const incoming = Array.from(files);

      // Validate count
      if (attachments.length + incoming.length > MAX_FILES) {
        setAttachError(`Maximum ${MAX_FILES} files allowed.`);
        return;
      }

      const validFiles = [];
      let newTotalSize = totalSize;

      for (const file of incoming) {
        if (!isAllowedType(file)) {
          setAttachError(`"${file.name}" — unsupported file type.`);
          return;
        }
        if (file.size > MAX_FILE_SIZE) {
          setAttachError(
            `"${file.name}" exceeds the ${humanFileSize(MAX_FILE_SIZE)} limit.`,
          );
          return;
        }
        newTotalSize += file.size;
        if (newTotalSize > MAX_TOTAL_SIZE) {
          setAttachError(
            `Total attachment size would exceed ${humanFileSize(MAX_TOTAL_SIZE)}.`,
          );
          return;
        }
        validFiles.push(file);
      }

      try {
        const processed = await Promise.all(validFiles.map(readFileAsync));
        onAttachmentsChange([...attachments, ...processed]);
      } catch {
        setAttachError("Failed to read one or more files.");
      }
    },
    [attachments, totalSize, onAttachmentsChange],
  );

  const handleFileInputChange = useCallback(
    (e) => {
      if (e.target.files?.length) {
        handleFiles(e.target.files);
      }
      // Reset input so re-selecting the same file works
      e.target.value = "";
    },
    [handleFiles],
  );

  const removeAttachment = useCallback(
    (id) => {
      onAttachmentsChange(attachments.filter((a) => a.id !== id));
      setAttachError(null);
    },
    [attachments, onAttachmentsChange],
  );

  /* ── drop zone ── */
  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.dataTransfer.files?.length) {
        handleFiles(e.dataTransfer.files);
      }
    },
    [handleFiles],
  );

  /* ── render ── */
  return (
    <div className="space-y-3" role="group" aria-label="AI Jumpstart options">
      {/* ── Checkbox toggle ── */}
      <div className="flex items-center gap-2.5">
        <Checkbox
          id="ai-jumpstart"
          checked={enabled}
          onCheckedChange={onEnabledChange}
          disabled={disabled}
          aria-controls="ai-jumpstart-panel"
          className="cursor-pointer"
          style={{
            borderColor: enabled
              ? "var(--accent-primary)"
              : "var(--border-medium)",
            backgroundColor: enabled
              ? "var(--accent-primary)"
              : "transparent",
          }}
        />
        <Label
          htmlFor="ai-jumpstart"
          className="flex items-center gap-1.5 text-sm font-medium cursor-pointer select-none"
          style={{ color: "var(--text-secondary)" }}
        >
          <Sparkles
            className="h-3.5 w-3.5"
            aria-hidden="true"
            style={{
              color: enabled
                ? "var(--accent-primary)"
                : "var(--text-dim)",
            }}
          />
          Jumpstart your project with Synthi AI
        </Label>
      </div>

      {/* ── Expandable section with smooth animation ── */}
      <div
        id="ai-jumpstart-panel"
        ref={expandRef}
        role="region"
        aria-label="AI project description"
        aria-hidden={!enabled}
        className="overflow-hidden transition-all duration-300 ease-in-out"
        style={{
          maxHeight: enabled ? 600 : 0,
          opacity: enabled ? 1 : 0,
        }}
      >
        <div
          className="space-y-3 rounded-lg p-4"
          style={{
            background:
              "color-mix(in srgb, var(--accent-primary) 5%, var(--bg-app))",
            border: "1px solid color-mix(in srgb, var(--accent-primary) 20%, transparent)",
          }}
        >
          {/* Project-type picker — gates the prompt textarea */}
          <div className="space-y-1.5">
            <label
              className="synthi-label"
              style={{ color: "var(--text-muted)" }}
            >
              Project type
            </label>
            {typeChosen ? (
              <div
                className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm"
                style={{
                  background: "var(--bg-editor)",
                  border: "1px solid var(--accent-primary)",
                  color: "var(--text-primary)",
                }}
              >
                <Check
                  className="h-3.5 w-3.5 shrink-0"
                  style={{ color: "var(--accent-primary)" }}
                />
                <span className="flex-1 truncate font-medium">
                  {projectType.label}
                </span>
                <button
                  type="button"
                  onClick={handleClearType}
                  disabled={disabled}
                  className="text-xs underline transition-opacity hover:opacity-80 disabled:opacity-50"
                  style={{ color: "var(--text-secondary)" }}
                >
                  Change
                </button>
              </div>
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={handlePickType}
                disabled={disabled}
                className="w-full justify-start gap-2 transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md"
                style={{
                  borderColor: "var(--border-medium)",
                  background: "var(--bg-editor)",
                  color: "var(--text-primary)",
                }}
              >
                <FolderPlus
                  className="h-3.5 w-3.5"
                  style={{ color: "var(--accent-primary)" }}
                />
                Choose project type…
              </Button>
            )}
          </div>

          {/* Prompt textarea — locked until a project type is chosen */}
          <div className="space-y-1.5">
            <label
              htmlFor="ai-jumpstart-prompt"
              className="synthi-label"
              style={{ color: "var(--text-muted)" }}
            >
              Describe your project idea
              {!typeChosen && (
                <span
                  className="ml-1 text-xs font-normal"
                  style={{ color: "var(--text-dim)" }}
                >
                  (pick a project type first)
                </span>
              )}
            </label>
            <textarea
              id="ai-jumpstart-prompt"
              placeholder={
                typeChosen
                  ? "e.g. A full-stack Next.js task manager with Prisma, auth, and a clean dashboard UI…"
                  : "Pick a project type above to unlock the prompt"
              }
              value={prompt}
              onChange={(e) => {
                if (e.target.value.length <= MAX_PROMPT_LENGTH) {
                  onPromptChange(e.target.value);
                }
              }}
              disabled={disabled || !typeChosen}
              rows={4}
              maxLength={MAX_PROMPT_LENGTH}
              className="th-input w-full px-3 py-2.5 rounded-lg text-sm outline-none transition-colors synthi-focus-ring resize-y disabled:cursor-not-allowed disabled:opacity-60"
              style={{
                background: "var(--bg-editor)",
                color: "var(--text-primary)",
                border: "1px solid var(--border-medium)",
                minHeight: 80,
                maxHeight: 200,
              }}
            />
            <div className="flex justify-end">
              <span
                className="text-xs"
                style={{
                  color: prompt.length > MAX_PROMPT_LENGTH * 0.9
                    ? "var(--accent-warning, var(--accent-danger))"
                    : "var(--text-dim)",
                }}
              >
                {prompt.length}/{MAX_PROMPT_LENGTH}
              </span>
            </div>
          </div>

          {/* File attachments */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label
                className="synthi-label"
                style={{ color: "var(--text-muted)" }}
              >
                Attachments{" "}
                <span style={{ color: "var(--text-dim)" }}>(optional)</span>
              </label>
              <span
                className="text-xs"
                style={{ color: "var(--text-dim)" }}
              >
                {attachments.length}/{MAX_FILES} files
                {totalSize > 0 && ` · ${humanFileSize(totalSize)}`}
              </span>
            </div>

            {/* Drop zone / attach button */}
            <div
              onDragOver={handleDragOver}
              onDrop={disabled ? undefined : handleDrop}
              className="flex items-center justify-center gap-2 rounded-lg py-3 px-4 cursor-pointer transition-colors"
              style={{
                border: "1px dashed var(--border-medium)",
                background: "var(--bg-editor)",
                color: "var(--text-dim)",
              }}
              onClick={() => !disabled && fileInputRef.current?.click()}
              onMouseEnter={(e) => {
                e.currentTarget.style.borderColor = "var(--accent-primary)";
                e.currentTarget.style.color = "var(--text-muted)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.borderColor = "var(--border-medium)";
                e.currentTarget.style.color = "var(--text-dim)";
              }}
            >
              <Paperclip className="h-3.5 w-3.5" />
              <span className="text-xs">
                Drop files here or click to attach
              </span>
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={handleFileInputChange}
                disabled={disabled}
                accept=".js,.jsx,.ts,.tsx,.json,.md,.txt,.py,.rs,.go,.css,.html,.xml,.yaml,.yml,.toml,.svg,.png,.jpg,.jpeg,.gif,.webp"
              />
            </div>

            {/* Error */}
            {attachError && (
              <div
                role="alert"
                aria-live="polite"
                className="flex items-center gap-1.5 text-xs px-2 py-1.5 rounded"
                style={{
                  color: "var(--accent-danger)",
                  background:
                    "color-mix(in srgb, var(--accent-danger) 8%, transparent)",
                }}
              >
                <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
                {attachError}
              </div>
            )}

            {/* Attachment list */}
            {attachments.length > 0 && (
              <ul className="space-y-1">
                {attachments.map((att) => (
                  <li
                    key={att.id}
                    className="flex items-center gap-2 text-xs px-2.5 py-1.5 rounded-md"
                    style={{
                      background: "var(--bg-editor)",
                      border: "1px solid var(--border-subtle)",
                      color: "var(--text-secondary)",
                    }}
                  >
                    {fileIcon(att)}
                    <span className="truncate flex-1">{att.name}</span>
                    <span
                      className="shrink-0"
                      style={{ color: "var(--text-dim)" }}
                    >
                      {humanFileSize(att.size)}
                    </span>
                    <button
                      type="button"
                      onClick={() => removeAttachment(att.id)}
                      disabled={disabled}
                      className="p-0.5 rounded hover:bg-white/10 transition-colors cursor-pointer"
                      style={{ color: "var(--text-dim)" }}
                      title="Remove"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
