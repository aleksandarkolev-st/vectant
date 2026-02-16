/**
 * gitGutterPeek.js — Peek diff widget for git gutter bars
 *
 * When the user clicks a colored gutter bar, an inline viewZone appears
 * showing the original HEAD content for that change region, with
 * Revert and Close actions.
 *
 * Styled in Synthi design language (dark + teal accent).
 */

// ─── Constants ──────────────────────────────────────────────────────────────

const PEEK_STYLE_ID = 'git-peek-style';
const LINE_HEIGHT   = 18;
const HEADER_HEIGHT = 33;
const MAX_VISIBLE   = 12;
const BODY_PAD      = 8;

// ─── Style injection ────────────────────────────────────────────────────────

export function ensurePeekStyles() {
    if (typeof document === 'undefined') return;
    if (document.getElementById(PEEK_STYLE_ID)) return;

    const s = document.createElement('style');
    s.id = PEEK_STYLE_ID;
    s.textContent = `
/* ── Peek container ─────────────────────────────── */
.git-peek-container {
    background: #0c0d12;
    border: 1px solid rgba(58, 133, 116, 0.18);
    border-top: 2px solid #3a8574;
    border-radius: 0 0 6px 6px;
    box-shadow: 0 6px 28px rgba(0,0,0,0.45);
    overflow: hidden;
    font-family: 'JetBrains Mono', 'Cascadia Code', Consolas, monospace;
    font-size: 12px;
    line-height: ${LINE_HEIGHT}px;
}

/* ── Header ─────────────────────────────────────── */
.git-peek-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: ${HEADER_HEIGHT}px;
    padding: 0 10px;
    background: #101118;
    border-bottom: 1px solid #1a1b24;
    user-select: none;
}
.git-peek-title {
    color: #9ba2b8;
    font-size: 11px;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 8px;
}
.git-peek-badge {
    display: inline-flex;
    align-items: center;
    padding: 1px 7px;
    border-radius: 4px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.4px;
    text-transform: uppercase;
}
.git-peek-badge-modified {
    background: rgba(136, 192, 252, 0.10);
    color: #1871d0;
}
.git-peek-badge-deleted {
    background: rgba(255, 107, 107, 0.10);
    color: #ff6b6b;
}
.git-peek-badge-added {
    background: rgba(74, 222, 128, 0.10);
    color: #3def3a;
}
.git-peek-actions {
    display: flex;
    align-items: center;
    gap: 4px;
}

/* ── Buttons ────────────────────────────────────── */
.git-peek-btn {
    border: none;
    border-radius: 4px;
    font-family: inherit;
    font-size: 11px;
    cursor: pointer;
    transition: background 0.12s, color 0.12s;
    outline: none;
    line-height: 1;
}
.git-peek-revert-btn {
    background: rgba(58, 133, 116, 0.12);
    color: #4aba9a;
    border: 1px solid rgba(58, 133, 116, 0.25);
    padding: 4px 10px;
    border-radius: 999px;
}
.git-peek-revert-btn:hover {
    background: rgba(58, 133, 116, 0.24);
    color: #5ddbb5;
    border-color: rgba(58, 133, 116, 0.45);
}
.git-peek-close-btn {
    background: transparent;
    color: #5a6178;
    font-size: 16px;
    padding: 3px 7px;
    border-radius: 4px;
}
.git-peek-close-btn:hover {
    color: #f4f5f8;
    background: rgba(255,255,255,0.06);
}

/* ── Body (code lines) ──────────────────────────── */
.git-peek-body {
    padding: 4px 0;
    max-height: ${MAX_VISIBLE * LINE_HEIGHT + BODY_PAD}px;
    overflow-y: auto;
}
.git-peek-body::-webkit-scrollbar { width: 5px; }
.git-peek-body::-webkit-scrollbar-track { background: transparent; }
.git-peek-body::-webkit-scrollbar-thumb {
    background: #2a2b38; border-radius: 3px;
}
.git-peek-line {
    display: flex;
    min-height: ${LINE_HEIGHT}px;
    padding: 0 8px 0 0;
}
.git-peek-line-removed {
    background: rgba(255, 107, 107, 0.05);
}
.git-peek-linenum {
    flex-shrink: 0;
    width: 46px;
    text-align: right;
    padding-right: 14px;
    color: #454a5e;
    user-select: none;
}
.git-peek-code {
    flex: 1;
    white-space: pre;
    tab-size: 4;
    color: #8b92a8;
    overflow-x: auto;
}
.git-peek-line-removed .git-peek-code {
    color: #d98888;
}

/* ── Empty message ──────────────────────────────── */
.git-peek-empty {
    padding: 8px 16px;
    color: #5a6178;
    font-size: 11px;
    font-style: italic;
}

/* ── Highlight on changed lines while peek is open ─ */
.git-peek-highlight {
    background: rgba(58, 133, 116, 0.06) !important;
}
`;
    document.head.appendChild(s);
}

// ─── DOM builders ───────────────────────────────────────────────────────────

function buildHeader(change, onRevert, onClose) {
    const header = document.createElement('div');
    header.className = 'git-peek-header';

    const title = document.createElement('span');
    title.className = 'git-peek-title';

    const label = change.type === 'deleted' ? 'Deleted'
                : change.type === 'added'   ? 'New Code'
                : 'Changed';
    title.textContent = label + ' ';

    const badge = document.createElement('span');
    badge.className = `git-peek-badge git-peek-badge-${change.type}`;
    badge.textContent = change.type === 'modified' ? 'MOD'
                      : change.type === 'deleted'  ? 'DEL'
                      : 'ADD';
    title.appendChild(badge);

    const actions = document.createElement('div');
    actions.className = 'git-peek-actions';

    const revertBtn = document.createElement('button');
    revertBtn.className = 'git-peek-btn git-peek-revert-btn';
    revertBtn.textContent = '↩ Revert';
    revertBtn.onclick = e => { e.stopPropagation(); onRevert(); };

    const closeBtn = document.createElement('button');
    closeBtn.className = 'git-peek-btn git-peek-close-btn';
    closeBtn.textContent = '×';
    closeBtn.onclick = e => { e.stopPropagation(); onClose(); };

    actions.appendChild(revertBtn);
    actions.appendChild(closeBtn);
    header.appendChild(title);
    header.appendChild(actions);

    return header;
}

function buildBody(change, headLines) {
    const body = document.createElement('div');
    body.className = 'git-peek-body';

    const hasOld = change.oldStartLine > 0 && change.oldEndLine > 0;

    if (hasOld && headLines.length > 0) {
        const lines = headLines.slice(change.oldStartLine - 1, change.oldEndLine);
        if (lines.length === 0) {
            appendEmpty(body, 'No original content');
            return body;
        }
        lines.forEach((text, i) => {
            const row = document.createElement('div');
            row.className = 'git-peek-line git-peek-line-removed';

            const num = document.createElement('span');
            num.className = 'git-peek-linenum';
            num.textContent = String(change.oldStartLine + i);

            const code = document.createElement('span');
            code.className = 'git-peek-code';
            code.textContent = text;

            row.appendChild(num);
            row.appendChild(code);
            body.appendChild(row);
        });
    } else {
        appendEmpty(
            body,
            change.type === 'added'
                ? 'New code — not present in HEAD'
                : 'No original content available',
        );
    }

    return body;
}

function appendEmpty(parent, msg) {
    const el = document.createElement('div');
    el.className = 'git-peek-empty';
    el.textContent = msg;
    parent.appendChild(el);
}

// ─── Widget lifecycle ───────────────────────────────────────────────────────

/**
 * Create a peek viewZone showing HEAD content for the given change.
 *
 * @param {import('monaco-editor').editor.IStandaloneCodeEditor} editor
 * @param {object} change - GutterChange with oldStartLine/oldEndLine
 * @param {string[]} headLines - HEAD file split into lines
 * @param {() => void} onRevert - Called when user clicks Revert
 * @param {() => void} onClose  - Called when user clicks Close
 * @returns {{ zoneId: string, domNode: HTMLElement }}
 */
export function createPeekWidget(editor, change, headLines, onRevert, onClose) {
    const container = document.createElement('div');
    container.className = 'git-peek-container';

    // Prevent the editor from eating our mouse events
    container.addEventListener('mousedown', e => e.stopPropagation());

    container.appendChild(buildHeader(change, onRevert, onClose));
    container.appendChild(buildBody(change, headLines));

    // ── Height calculation ───────────────────────────────────────────
    const hasOld     = change.oldStartLine > 0 && change.oldEndLine > 0;
    const numOld     = hasOld ? Math.max(0, change.oldEndLine - change.oldStartLine + 1) : 0;
    const visLines   = Math.min(numOld, MAX_VISIBLE);
    const bodyH      = hasOld && numOld > 0 ? visLines * LINE_HEIGHT + BODY_PAD : 36;
    const totalH     = HEADER_HEIGHT + bodyH + 2; // +2 for borders

    // Place zone above the changed region
    const afterLine = change.type === 'deleted'
        ? change.startLine
        : Math.max(0, change.startLine - 1);

    let zoneId = null;
    editor.changeViewZones(acc => {
        zoneId = acc.addZone({
            afterLineNumber: afterLine,
            heightInPx: totalH,
            domNode: container,
            suppressMouseDown: false,
        });
    });

    return { zoneId, domNode: container };
}

/**
 * Remove a peek viewZone.
 */
export function dismissPeekWidget(editor, peekState) {
    if (!peekState?.zoneId) return;
    try {
        editor.changeViewZones(acc => acc.removeZone(peekState.zoneId));
    } catch (_) { /* already removed */ }
}

// ─── Revert operation ───────────────────────────────────────────────────────

/**
 * Revert an entire hunk (all changes sharing the same hunkId).
 *
 * @param {import('monaco-editor').editor.IStandaloneCodeEditor} editor
 * @param {*} monacoModule - Global monaco namespace
 * @param {Array} hunkChanges - All GutterChange objects in this hunk
 * @param {string[]} headLines - HEAD file split into lines
 */
export function revertHunk(editor, monacoModule, hunkChanges, headLines) {
    const model = editor.getModel();
    if (!model) return;

    const oldSL   = hunkChanges[0].oldStartLine;
    const oldEL   = hunkChanges[0].oldEndLine;
    const hasOld  = oldSL > 0 && oldEL > 0;
    const oldText = hasOld ? headLines.slice(oldSL - 1, oldEL) : [];

    const allDeleted = hunkChanges.every(c => c.type === 'deleted');

    if (allDeleted && oldText.length > 0) {
        // Deleted lines — re-insert them
        const marker = hunkChanges[0].startLine;
        editor.executeEdits('git-gutter-revert', [{
            range: new monacoModule.Range(
                marker, model.getLineMaxColumn(marker),
                marker, model.getLineMaxColumn(marker),
            ),
            text: '\n' + oldText.join('\n'),
        }]);
        return;
    }

    // Compute the full current-file range spanned by non-deleted changes
    const nonDel = hunkChanges.filter(c => c.type !== 'deleted');
    if (nonDel.length === 0) return;

    const minLine = Math.min(...nonDel.map(c => c.startLine));
    const maxLine = Math.max(...nonDel.map(c => c.endLine));

    if (hasOld) {
        // Replace current lines with HEAD content
        editor.executeEdits('git-gutter-revert', [{
            range: new monacoModule.Range(minLine, 1, maxLine, model.getLineMaxColumn(maxLine)),
            text: oldText.join('\n'),
        }]);
    } else {
        // Pure addition — remove entirely
        let range;
        if (minLine > 1) {
            range = new monacoModule.Range(
                minLine - 1, model.getLineMaxColumn(minLine - 1),
                maxLine, model.getLineMaxColumn(maxLine),
            );
        } else if (maxLine < model.getLineCount()) {
            range = new monacoModule.Range(1, 1, maxLine + 1, 1);
        } else {
            range = new monacoModule.Range(1, 1, maxLine, model.getLineMaxColumn(maxLine));
        }
        editor.executeEdits('git-gutter-revert', [{ range, text: '' }]);
    }
}
