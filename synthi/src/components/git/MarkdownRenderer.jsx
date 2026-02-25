'use client';
import React, { useState, useMemo, useCallback } from 'react';

/**
 * GitHub-parity Markdown renderer — zero external dependencies.
 *
 * Supports:
 *  - Headings (# - ######)
 *  - Bold, italic, strikethrough, inline code
 *  - Fenced code blocks (``` with language tag)
 *  - Block quotes (>)
 *  - Ordered + unordered lists (with nesting)
 *  - Task lists (- [x] / - [ ])
 *  - Tables (| col | col |)
 *  - Images ![alt](src)
 *  - Links [text](url)
 *  - @mentions → link to GitHub profile
 *  - #123 → link to issue/PR
 *  - Horizontal rules (---, ***, ___)
 *  - Automatic URL detection
 */

// ── Inline parser ────────────────────────────────────────────────────────────

const INLINE_RULES = [
  // Images must come before links
  { pattern: /!\[([^\]]*)\]\(([^)]+)\)/, render: (m, k) => (
    <img key={k} src={m[2]} alt={m[1]} className="max-w-full rounded my-1 inline-block" style={{ maxHeight: 320 }} />
  )},
  // Links
  { pattern: /\[([^\]]+)\]\(([^)]+)\)/, render: (m, k) => (
    <a key={k} href={m[2]} target="_blank" rel="noopener noreferrer"
      className="underline decoration-1 underline-offset-2 hover:opacity-80 transition"
      style={{ color: 'var(--accent-primary, #60a5fa)' }}>{m[1]}</a>
  )},
  // Bold + italic ***text***
  { pattern: /\*\*\*(.+?)\*\*\*/, render: (m, k) => (
    <strong key={k} className="font-bold italic" style={{ color: 'var(--text-primary)' }}>{m[1]}</strong>
  )},
  // Bold **text**
  { pattern: /\*\*(.+?)\*\*/, render: (m, k) => (
    <strong key={k} className="font-semibold" style={{ color: 'var(--text-primary)' }}>{m[1]}</strong>
  )},
  // Italic *text* or _text_ (non-greedy, word-boundary-ish)
  { pattern: /(?<!\w)\*(.+?)\*(?!\w)/, render: (m, k) => <em key={k}>{m[1]}</em> },
  { pattern: /(?<!\w)_(.+?)_(?!\w)/, render: (m, k) => <em key={k}>{m[1]}</em> },
  // Strikethrough ~~text~~
  { pattern: /~~(.+?)~~/, render: (m, k) => <del key={k} className="opacity-60">{m[1]}</del> },
  // Inline code `text`
  { pattern: /`([^`]+)`/, render: (m, k) => (
    <code key={k} className="font-mono text-[0.85em] px-1 py-0.5 rounded"
      style={{ background: 'var(--bg-app, #18181b)', color: 'var(--accent-primary, #60a5fa)' }}>{m[1]}</code>
  )},
  // @mention
  { pattern: /@([a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)/, render: (m, k) => (
    <a key={k} href={`https://github.com/${m[1]}`} target="_blank" rel="noopener noreferrer"
      className="font-semibold hover:underline"
      style={{ color: 'var(--accent-primary, #60a5fa)' }}>@{m[1]}</a>
  )},
  // #issue/PR reference
  { pattern: /#(\d+)/, render: (m, k) => (
    <span key={k} className="font-semibold cursor-pointer hover:underline"
      style={{ color: 'var(--accent-primary, #60a5fa)' }}>#{m[1]}</span>
  )},
  // Bare URLs
  { pattern: /(https?:\/\/[^\s<>)"']+)/, render: (m, k) => (
    <a key={k} href={m[1]} target="_blank" rel="noopener noreferrer"
      className="underline decoration-1 underline-offset-2 hover:opacity-80"
      style={{ color: 'var(--accent-primary, #60a5fa)' }}>{m[1]}</a>
  )},
];

function parseInline(text) {
  if (!text) return null;
  const parts = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    let earliest = null;
    let earliestIdx = Infinity;
    let earliestRule = null;

    for (const rule of INLINE_RULES) {
      const match = remaining.match(rule.pattern);
      if (match && match.index < earliestIdx) {
        earliest = match;
        earliestIdx = match.index;
        earliestRule = rule;
      }
    }

    if (!earliest || !earliestRule) {
      parts.push(<span key={key++}>{remaining}</span>);
      break;
    }

    // Text before the match
    if (earliestIdx > 0) {
      parts.push(<span key={key++}>{remaining.slice(0, earliestIdx)}</span>);
    }

    parts.push(earliestRule.render(earliest, key++));
    remaining = remaining.slice(earliestIdx + earliest[0].length);
  }

  return parts;
}

// ── Block parser ─────────────────────────────────────────────────────────────

/**
 * Parse markdown text into block-level elements.
 */
function parseBlocks(text) {
  if (!text) return [];
  const lines = text.split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    const fenceMatch = line.match(/^(`{3,}|~{3,})\s*(\S*)/);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      const lang = fenceMatch[2] || '';
      const codeLines = [];
      i++;
      while (i < lines.length && !lines[i].startsWith(fence)) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ type: 'code', lang, content: codeLines.join('\n') });
      continue;
    }

    // Horizontal rule
    if (/^(\*{3,}|-{3,}|_{3,})\s*$/.test(line.trim())) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // Heading
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      blocks.push({ type: 'heading', level: headingMatch[1].length, content: headingMatch[2] });
      i++;
      continue;
    }

    // Table (look ahead for separator row)
    if (i + 1 < lines.length && /^\|/.test(line) && /^\|[\s-:|]+\|/.test(lines[i + 1])) {
      const headerCells = line.split('|').filter(c => c.trim() !== '').map(c => c.trim());
      const alignRow = lines[i + 1].split('|').filter(c => c.trim() !== '');
      const aligns = alignRow.map(c => {
        const t = c.trim();
        if (t.startsWith(':') && t.endsWith(':')) return 'center';
        if (t.endsWith(':')) return 'right';
        return 'left';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) {
        rows.push(lines[i].split('|').filter(c => c.trim() !== '').map(c => c.trim()));
        i++;
      }
      blocks.push({ type: 'table', headers: headerCells, aligns, rows });
      continue;
    }

    // Blockquote
    if (line.startsWith('>')) {
      const quoteLines = [];
      while (i < lines.length && (lines[i].startsWith('>') || (lines[i].trim() !== '' && quoteLines.length > 0 && !lines[i].startsWith('#')))) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', content: quoteLines.join('\n') });
      continue;
    }

    // Unordered list
    if (/^(\s*)([-*+])\s/.test(line)) {
      const listItems = [];
      while (i < lines.length && /^(\s*)([-*+])\s/.test(lines[i])) {
        const itemMatch = lines[i].match(/^(\s*)([-*+])\s(.+)/);
        if (itemMatch) {
          const text = itemMatch[3];
          // Task list check
          const taskMatch = text.match(/^\[([ xX])\]\s?(.*)/);
          if (taskMatch) {
            listItems.push({ text: taskMatch[2], checked: taskMatch[1] !== ' ', isTask: true });
          } else {
            listItems.push({ text, isTask: false });
          }
        }
        i++;
      }
      blocks.push({ type: 'ul', items: listItems });
      continue;
    }

    // Ordered list
    if (/^\s*\d+[.)]\s/.test(line)) {
      const listItems = [];
      while (i < lines.length && /^\s*\d+[.)]\s/.test(lines[i])) {
        const itemMatch = lines[i].match(/^\s*\d+[.)]\s(.+)/);
        if (itemMatch) listItems.push({ text: itemMatch[1] });
        i++;
      }
      blocks.push({ type: 'ol', items: listItems });
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      blocks.push({ type: 'empty' });
      i++;
      continue;
    }

    // Paragraph — collect consecutive non-empty lines
    const paraLines = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#{1,6}\s|```|~~~|>|\s*[-*+]\s|\s*\d+[.)]\s|\|.*\|)/.test(lines[i]) && !/^(\*{3,}|-{3,}|_{3,})\s*$/.test(lines[i].trim())) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', content: paraLines.join('\n') });
    }
  }

  return blocks;
}

// ── Code block with basic syntax highlighting ────────────────────────────────

// Very basic keyword highlighting for common languages
const LANG_KEYWORDS = {
  javascript: /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|default|async|await|try|catch|throw|new|this|null|undefined|true|false|typeof|instanceof)\b/g,
  typescript: /\b(const|let|var|function|return|if|else|for|while|class|import|export|from|default|async|await|try|catch|throw|new|this|null|undefined|true|false|typeof|instanceof|interface|type|enum|as|is)\b/g,
  python: /\b(def|class|return|if|elif|else|for|while|import|from|as|try|except|raise|with|yield|async|await|True|False|None|self|lambda|in|not|and|or|is)\b/g,
  rust: /\b(fn|let|mut|pub|struct|enum|impl|trait|use|mod|match|if|else|for|while|loop|return|self|Self|true|false|None|Some|Ok|Err|async|await|move|ref|where)\b/g,
  go: /\b(func|var|const|type|struct|interface|return|if|else|for|range|switch|case|default|import|package|defer|go|chan|select|nil|true|false|make|append|len)\b/g,
  java: /\b(public|private|protected|static|final|class|interface|extends|implements|return|if|else|for|while|new|this|null|true|false|void|int|String|boolean|import|package|try|catch|throw|throws)\b/g,
  css: /\b(display|flex|grid|margin|padding|border|color|background|font|width|height|position|top|left|right|bottom|z-index|overflow|opacity|transition|transform|animation)\b/g,
  html: /(<\/?[a-zA-Z][a-zA-Z0-9]*)/g,
  json: /("(?:[^"\\]|\\.)*")\s*:/g,
  bash: /\b(if|then|else|fi|for|do|done|while|case|esac|function|return|echo|exit|export|source|cd|ls|grep|sed|awk|cat|mkdir|rm|cp|mv|chmod)\b/g,
  sh: /\b(if|then|else|fi|for|do|done|while|case|esac|function|return|echo|exit|export)\b/g,
};

// Language aliases
const LANG_ALIAS = {
  js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
  py: 'python', rs: 'rust', yml: 'yaml', yaml: 'yaml',
  shell: 'bash', zsh: 'bash', sh: 'bash',
};

function CodeBlock({ lang, content }) {
  const [copied, setCopied] = useState(false);
  const resolvedLang = LANG_ALIAS[lang] || lang;

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

  const highlighted = useMemo(() => {
    const kwRegex = LANG_KEYWORDS[resolvedLang];
    if (!kwRegex) return null;

    return content.split('\n').map((line, i) => {
      // Highlight strings
      let parts = line;
      // Simple: just highlight keywords with a span
      const tokens = [];
      let rest = parts;
      let key = 0;
      const regex = new RegExp(kwRegex.source, 'g');
      let match;
      let lastIdx = 0;

      while ((match = regex.exec(rest)) !== null) {
        if (match.index > lastIdx) {
          tokens.push(<span key={key++}>{rest.slice(lastIdx, match.index)}</span>);
        }
        tokens.push(
          <span key={key++} style={{ color: '#c084fc' }}>{match[0]}</span>
        );
        lastIdx = match.index + match[0].length;
      }
      if (lastIdx < rest.length) {
        tokens.push(<span key={key++}>{rest.slice(lastIdx)}</span>);
      }

      return (
        <div key={i} className="flex">
          <span className="select-none pr-3 text-right min-w-[2.5em] opacity-30">{i + 1}</span>
          <span className="flex-1">{tokens.length > 0 ? tokens : line}</span>
        </div>
      );
    });
  }, [content, resolvedLang]);

  return (
    <div className="rounded-lg border overflow-hidden my-2 group/code"
      style={{ borderColor: 'var(--border-subtle, #27272a)' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-1 border-b"
        style={{ background: 'var(--bg-panel, #1a1a1e)', borderColor: 'var(--border-subtle, #27272a)' }}>
        <span className="text-[10px] font-mono opacity-50">{lang || 'text'}</span>
        <button onClick={handleCopy}
          className="text-[10px] px-1.5 py-0.5 rounded opacity-0 group-hover/code:opacity-100 transition hover:opacity-80"
          style={{ color: 'var(--text-muted, #71717a)' }}>
          {copied ? '✓ Copied' : 'Copy'}
        </button>
      </div>
      {/* Code */}
      <pre className="text-[11px] font-mono px-3 py-2 overflow-x-auto leading-relaxed"
        style={{ background: 'var(--bg-app, #09090b)', color: 'var(--text-secondary, #d4d4d8)' }}>
        {highlighted || content.split('\n').map((line, i) => (
          <div key={i} className="flex">
            <span className="select-none pr-3 text-right min-w-[2.5em] opacity-30">{i + 1}</span>
            <span className="flex-1">{line}</span>
          </div>
        ))}
      </pre>
    </div>
  );
}

// ── Block renderer ───────────────────────────────────────────────────────────

function renderBlock(block, idx) {
  switch (block.type) {
    case 'heading': {
      const Tag = `h${block.level}`;
      const sizes = { 1: 'text-lg', 2: 'text-base', 3: 'text-sm', 4: 'text-xs', 5: 'text-xs', 6: 'text-xs' };
      const weights = { 1: 'font-bold', 2: 'font-bold', 3: 'font-bold', 4: 'font-semibold', 5: 'font-semibold', 6: 'font-medium' };
      return (
        <Tag key={idx}
          className={`${sizes[block.level]} ${weights[block.level]} mt-3 mb-1 pb-1 ${block.level <= 2 ? 'border-b' : ''}`}
          style={{ color: 'var(--text-primary)', borderColor: 'var(--border-subtle, #27272a)' }}>
          {parseInline(block.content)}
        </Tag>
      );
    }

    case 'paragraph':
      return (
        <p key={idx} className="text-xs leading-relaxed my-1.5"
          style={{ color: 'var(--text-secondary, #a1a1aa)' }}>
          {parseInline(block.content)}
        </p>
      );

    case 'code':
      return <CodeBlock key={idx} lang={block.lang} content={block.content} />;

    case 'blockquote':
      return (
        <blockquote key={idx}
          className="border-l-2 pl-3 my-2 italic"
          style={{ borderColor: 'var(--border-medium, #3f3f46)', color: 'var(--text-muted, #71717a)' }}>
          <MarkdownRenderer text={block.content} />
        </blockquote>
      );

    case 'ul':
      return (
        <ul key={idx} className="my-1.5 space-y-0.5">
          {block.items.map((item, j) => (
            <li key={j} className="flex items-start gap-1.5 text-xs"
              style={{ color: 'var(--text-secondary, #a1a1aa)' }}>
              {item.isTask ? (
                <span className={`mt-0.5 w-3.5 h-3.5 rounded border flex-shrink-0 flex items-center justify-center text-[9px] ${
                  item.checked
                    ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400'
                    : 'border-zinc-600'
                }`}>
                  {item.checked && '✓'}
                </span>
              ) : (
                <span className="mt-1 w-1.5 h-1.5 rounded-full bg-current opacity-40 flex-shrink-0" />
              )}
              <span className={item.isTask && item.checked ? 'line-through opacity-60' : ''}>
                {parseInline(item.text)}
              </span>
            </li>
          ))}
        </ul>
      );

    case 'ol':
      return (
        <ol key={idx} className="my-1.5 space-y-0.5">
          {block.items.map((item, j) => (
            <li key={j} className="flex items-start gap-1.5 text-xs"
              style={{ color: 'var(--text-secondary, #a1a1aa)' }}>
              <span className="text-[10px] font-mono opacity-50 mt-0.5 flex-shrink-0 min-w-[1.2em] text-right">
                {j + 1}.
              </span>
              <span>{parseInline(item.text)}</span>
            </li>
          ))}
        </ol>
      );

    case 'table':
      return (
        <div key={idx} className="my-2 overflow-x-auto rounded-lg border"
          style={{ borderColor: 'var(--border-subtle, #27272a)' }}>
          <table className="w-full text-xs">
            <thead>
              <tr style={{ background: 'var(--bg-panel, #1a1a1e)' }}>
                {block.headers.map((h, j) => (
                  <th key={j} className="px-2.5 py-1.5 font-semibold border-b text-left"
                    style={{ borderColor: 'var(--border-subtle, #27272a)', textAlign: block.aligns[j] || 'left', color: 'var(--text-primary)' }}>
                    {parseInline(h)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, j) => (
                <tr key={j} className="border-b last:border-b-0 hover:opacity-80"
                  style={{ borderColor: 'var(--border-subtle, #27272a)' }}>
                  {row.map((cell, k) => (
                    <td key={k} className="px-2.5 py-1.5"
                      style={{ textAlign: block.aligns[k] || 'left', color: 'var(--text-secondary, #a1a1aa)' }}>
                      {parseInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case 'hr':
      return <hr key={idx} className="my-3 border-0 h-px" style={{ background: 'var(--border-subtle, #27272a)' }} />;

    case 'empty':
      return <div key={idx} className="h-2" />;

    default:
      return null;
  }
}

// ── Toolbar for Write/Preview mode ───────────────────────────────────────────

const MD_TOOLBAR_ITEMS = [
  { label: 'B', title: 'Bold (Ctrl+B)', before: '**', after: '**', shortcut: { key: 'b', ctrl: true } },
  { label: 'I', title: 'Italic (Ctrl+I)', before: '_', after: '_', className: 'italic', shortcut: { key: 'i', ctrl: true } },
  { label: 'S', title: 'Strikethrough (Ctrl+Shift+X)', before: '~~', after: '~~', className: 'line-through', shortcut: { key: 'x', ctrl: true, shift: true } },
  { label: '<>', title: 'Inline code', before: '`', after: '`', className: 'font-mono text-[10px]' },
  { sep: true },
  { label: 'H1', title: 'Heading 1', before: '# ', after: '', block: true },
  { label: 'H2', title: 'Heading 2', before: '## ', after: '', block: true },
  { label: 'H3', title: 'Heading 3', before: '### ', after: '', block: true },
  { sep: true },
  { label: '•', title: 'Bullet list', before: '- ', after: '', block: true },
  { label: '1.', title: 'Numbered list', before: '1. ', after: '', block: true },
  { label: '☑', title: 'Task', before: '- [ ] ', after: '', block: true },
  { sep: true },
  { label: '""', title: 'Blockquote', before: '> ', after: '', block: true },
  { label: '```', title: 'Code block', before: '```\n', after: '\n```', block: true },
  { label: '🔗', title: 'Link (Ctrl+K)', before: '[', after: '](url)', shortcut: { key: 'k', ctrl: true } },
  { label: '📷', title: 'Image', before: '![alt](', after: ')' },
];

/**
 * Insert markdown formatting around the selection of a textarea.
 * Uses execCommand for undo support. Returns early if ref is null.
 */
export function insertMarkdownFormatting(textareaRef, item) {
  const ta = textareaRef?.current;
  if (!ta) return;
  const start = ta.selectionStart;
  const end = ta.selectionEnd;
  const text = ta.value;
  const selected = text.slice(start, end);

  let insert;
  if (item.block && start > 0 && text[start - 1] !== '\n') {
    insert = '\n' + item.before + (selected || 'text') + item.after;
  } else {
    insert = item.before + (selected || 'text') + item.after;
  }

  ta.focus();
  document.execCommand('insertText', false, insert);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * onKeyDown handler for Markdown keyboard shortcuts.
 * Attach to any textarea that has a corresponding ref.
 *
 * Supported: Ctrl+B (Bold), Ctrl+I (Italic), Ctrl+K (Link), Ctrl+Shift+X (Strikethrough)
 */
export function handleMarkdownKeyDown(e, textareaRef) {
  const ctrl = e.ctrlKey || e.metaKey;
  if (!ctrl) {
    // Smart list continuation on Enter (no modifier)
    if (e.key === 'Enter' && !e.shiftKey) {
      const ta = textareaRef?.current;
      if (!ta) return;
      const { selectionStart } = ta;
      const text = ta.value;

      // Find the current line
      const lineStart = text.lastIndexOf('\n', selectionStart - 1) + 1;
      const currentLine = text.slice(lineStart, selectionStart);

      // Match list markers: "  - ", "  * ", "  1. ", "  - [ ] ", "  - [x] "
      const listMatch = currentLine.match(/^(\s*)([-*]|\d+\.)(\s+(?:\[[ x]\]\s*)?)/);
      if (listMatch) {
        const indent = listMatch[1];
        const marker = listMatch[2];
        const afterMarker = listMatch[3];
        const contentAfterMarker = currentLine.slice(listMatch[0].length);

        // If line only has the marker (empty item) → remove the marker
        if (!contentAfterMarker.trim()) {
          e.preventDefault();
          // Select the empty list marker line and replace with empty line
          ta.setSelectionRange(lineStart, selectionStart);
          document.execCommand('insertText', false, '');
          ta.dispatchEvent(new Event('input', { bubbles: true }));
          return;
        }

        // Auto-insert next marker
        e.preventDefault();
        let nextMarker;
        if (/^\d+/.test(marker)) {
          // Increment numbered list
          const num = parseInt(marker, 10) + 1;
          nextMarker = `${num}.`;
        } else {
          nextMarker = marker;
        }

        // Check if current line had a checkbox
        const hasCheckbox = /\[[ x]\]/.test(afterMarker);
        const checkboxPart = hasCheckbox ? '[ ] ' : afterMarker;

        const insertText = `\n${indent}${nextMarker}${hasCheckbox ? ' ' + checkboxPart : afterMarker}`;
        document.execCommand('insertText', false, insertText);
        ta.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }
    }
    return;
  }

  for (const item of MD_TOOLBAR_ITEMS) {
    if (!item.shortcut) continue;
    const s = item.shortcut;
    if (
      e.key.toLowerCase() === s.key &&
      ctrl === !!s.ctrl &&
      e.shiftKey === !!s.shift
    ) {
      e.preventDefault();
      insertMarkdownFormatting(textareaRef, item);
      return;
    }
  }
}

/**
 * Markdown toolbar that wraps a textarea ref.
 * Inserts formatting at cursor position / around selection.
 */
export function MarkdownToolbar({ textareaRef }) {
  const handleInsert = useCallback((item) => {
    insertMarkdownFormatting(textareaRef, item);
  }, [textareaRef]);

  return (
    <div className="flex items-center gap-0.5 px-2 py-1 border-b overflow-x-auto"
      style={{ borderColor: 'var(--border-subtle, #27272a)' }}>
      {MD_TOOLBAR_ITEMS.map((item, i) => {
        if (item.sep) return <div key={i} className="w-px h-3 mx-0.5" style={{ background: 'var(--border-subtle, #27272a)' }} />;
        return (
          <button key={i} onClick={() => handleInsert(item)} title={item.title}
            className={`px-1.5 py-0.5 rounded text-[10px] font-medium hover:opacity-80 transition ${item.className || ''}`}
            style={{ color: 'var(--text-muted, #71717a)' }}>
            {item.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Write / Preview tabs wrapper ─────────────────────────────────────────────

/**
 * A textarea with Write/Preview tabs and a formatting toolbar.
 *
 * Props:
 *  - value: string
 *  - onChange: (text: string) => void
 *  - placeholder?: string
 *  - rows?: number
 *  - className?: string
 */
export function MarkdownEditor({ value, onChange, placeholder = 'Write…', rows = 6, className = '' }) {
  const [mode, setMode] = useState('write');
  const textareaRef = React.useRef(null);

  return (
    <div className={`rounded-lg border overflow-hidden ${className}`}
      style={{ borderColor: 'var(--border-medium, #3f3f46)' }}>
      {/* Tabs */}
      <div className="flex items-center border-b"
        style={{ background: 'var(--bg-panel, #1a1a1e)', borderColor: 'var(--border-subtle, #27272a)' }}>
        <button onClick={() => setMode('write')}
          className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition ${
            mode === 'write' ? '' : 'border-transparent'
          }`}
          style={{
            borderBottomColor: mode === 'write' ? 'var(--accent-primary, #3b82f6)' : 'transparent',
            color: mode === 'write' ? 'var(--text-primary)' : 'var(--text-muted)',
          }}>
          Write
        </button>
        <button onClick={() => setMode('preview')}
          className={`px-3 py-1.5 text-xs font-medium border-b-2 -mb-px transition ${
            mode === 'preview' ? '' : 'border-transparent'
          }`}
          style={{
            borderBottomColor: mode === 'preview' ? 'var(--accent-primary, #3b82f6)' : 'transparent',
            color: mode === 'preview' ? 'var(--text-primary)' : 'var(--text-muted)',
          }}>
          Preview
        </button>
      </div>

      {/* Toolbar (write mode only) */}
      {mode === 'write' && <MarkdownToolbar textareaRef={textareaRef} />}

      {/* Content */}
      {mode === 'write' ? (
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => onChange(e.target.value)}
          onKeyDown={e => handleMarkdownKeyDown(e, textareaRef)}
          placeholder={placeholder}
          rows={rows}
          className="w-full px-3 py-2 text-xs resize-y outline-none font-mono min-h-[80px]"
          style={{ background: 'var(--bg-app, #09090b)', color: 'var(--text-primary, #e4e4e7)' }}
        />
      ) : (
        <div className="px-3 py-2 min-h-[80px]"
          style={{ background: 'var(--bg-app, #09090b)' }}>
          {value?.trim() ? (
            <MarkdownRenderer text={value} />
          ) : (
            <p className="text-xs italic" style={{ color: 'var(--text-muted, #71717a)' }}>Nothing to preview</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main renderer ────────────────────────────────────────────────────────────

export function MarkdownRenderer({ text }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);

  if (!text?.trim()) {
    return (
      <span className="text-xs opacity-50 italic" style={{ color: 'var(--text-muted, #71717a)' }}>
        No description.
      </span>
    );
  }

  return <div className="markdown-body">{blocks.map((b, i) => renderBlock(b, i))}</div>;
}

export default MarkdownRenderer;
