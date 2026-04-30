#!/usr/bin/env node
// NEP offline replay harness — Phase 3.
//
// Reads a JSONL log of recorded NEP tuples, replays each through a candidate
// prompt template (or just re-validates against the recorded model output
// for prompt-free regression), and produces aggregate scores.
//
// Tuple shape (one JSON object per line):
//
//   {
//     "session_id": "abc123",
//     "ts": 1730000000000,
//     "recent_edits": [{path, snippet}, ...],
//     "files": {path: content, ...},
//     "applied_edit": {path, search, replace, kind?},   // the edit BEFORE this NEP
//     "predictions_emitted": [{path, kind, search, replace}, ...],
//     "predictions_validated": [{path, kind, search, replace}, ...],
//     "predictions_accepted": [{path, kind, search, replace}, ...],
//     "ground_truth_next_edit": {path, search, replace, ts_offset_ms, n_keystrokes}
//   }
//
// Score per prediction (Plan Section 7):
//
//   score = α · region_iou(predicted_search_region, gt_search_region)
//         + β · text_similarity(predicted_replace, gt_replace)
//
// Defaults: α=0.5, β=0.5.
//
// Region IoU is AST-window (Plan: char-span IoU is the wrong gradient).
// Without a real AST parser available in pure Node, we fall back to a
// ±N-line window IoU which is the plan's stated fallback. The window size
// (default 3) is a flag.
//
// Ground-truth filter: ground_truth.region must NOT overlap applied_edit.region
// — without this, fixing up a wrong predicted edit leaks back into the label
// (Plan Q2 region-exclusion rule).

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const importLocal = (rel) =>
  import(pathToFileURL(path.resolve(__dirname, rel)).href);
const nextEdit = await importLocal('../src/lib/nextEdit.js');
const { validateBlock, parseBlock, NEP_BLOCK_KIND } = nextEdit;

// ───────────────────────── config ─────────────────────────

const args = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = args.indexOf(name);
  if (i === -1) return dflt;
  const v = args[i + 1];
  if (!v || v.startsWith('--')) return true;
  return v;
};

const CFG = {
  log: flag('--log', null),
  alpha: Number(flag('--alpha', '0.5')),
  beta: Number(flag('--beta', '0.5')),
  window: Number(flag('--window', '3')),
  out: flag('--out', null),
  verbose: flag('--verbose', false) === true,
};

if (!CFG.log) {
  console.error('usage: node scripts/nep-replay.mjs --log <path.jsonl> [--alpha 0.5] [--beta 0.5] [--window 3] [--out report.json]');
  process.exit(2);
}

// ───────────────────────── scoring ─────────────────────────

const findOffset = (content, needle) => {
  if (!content || !needle) return -1;
  return content.indexOf(needle);
};

const offsetToLine = (content, offset) => {
  if (offset < 0) return -1;
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i++) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
};

/**
 * ±N-line window around the SEARCH region. Plan: AST-window IoU primary,
 * line-window IoU fallback. Without an AST parser bundled, we only
 * implement the fallback — the score is still correct on the median
 * "predicted line 40, actual line 42" case the plan flagged, just less
 * tight on syntactically-distinct edits at adjacent lines.
 *
 * Returns [startLine, endLine] inclusive, 1-indexed.
 */
const lineWindow = (content, search, windowLines) => {
  const offset = findOffset(content, search);
  if (offset === -1) return null;
  const startLine = offsetToLine(content, offset);
  const lineCount = (search.match(/\n/g) || []).length;
  const endLine = startLine + lineCount;
  return [
    Math.max(1, startLine - windowLines),
    endLine + windowLines,
  ];
};

const rangeIoU = (a, b) => {
  if (!a || !b) return 0;
  const [aStart, aEnd] = a;
  const [bStart, bEnd] = b;
  const interStart = Math.max(aStart, bStart);
  const interEnd = Math.min(aEnd, bEnd);
  const inter = Math.max(0, interEnd - interStart + 1);
  const aLen = aEnd - aStart + 1;
  const bLen = bEnd - bStart + 1;
  const union = aLen + bLen - inter;
  return union > 0 ? inter / union : 0;
};

/**
 * Whitespace/quote-tolerant edit distance over short strings. Plan calls
 * for "normalized edit distance over the REPLACE text, tokenized to be
 * insensitive to whitespace/quotes-style noise". Tokens here are:
 *   - identifier runs ([A-Za-z_][A-Za-z0-9_]*)
 *   - number runs ([0-9]+)
 *   - symbol runs ([^\s])
 * Whitespace and quote-style differences collapse to the same token list.
 */
const tokenize = (s) => {
  if (!s) return [];
  const out = [];
  const re = /[A-Za-z_][A-Za-z0-9_]*|[0-9]+|"|'|`|[^\s]/g;
  let m;
  while ((m = re.exec(s))) out.push(m[0] === '"' || m[0] === "'" || m[0] === '`' ? '"' : m[0]);
  return out;
};

const editDistance = (a, b) => {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) dp[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = dp[j];
      if (a[i - 1] === b[j - 1]) dp[j] = prev;
      else dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = cur;
    }
  }
  return dp[b.length];
};

const textSimilarity = (a, b) => {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 && tb.length === 0) return 1.0;
  const d = editDistance(ta, tb);
  const max = Math.max(ta.length, tb.length, 1);
  return Math.max(0, 1 - d / max);
};

const scorePrediction = ({ prediction, groundTruth, files, alpha, beta, windowLines }) => {
  if (!prediction || !groundTruth) return { score: 0, region_iou: 0, text_sim: 0 };
  const file = files?.[prediction.path] ?? files?.[groundTruth.path];
  if (!file) return { score: 0, region_iou: 0, text_sim: 0 };
  const predRegion = lineWindow(file, prediction.search, windowLines);
  const gtRegion = lineWindow(file, groundTruth.search, windowLines);
  const region_iou = rangeIoU(predRegion, gtRegion);
  const text_sim = textSimilarity(prediction.replace || '', groundTruth.replace || '');
  const score = alpha * region_iou + beta * text_sim;
  return { score, region_iou, text_sim };
};

const overlapsAppliedRegion = ({ groundTruth, applied, files, windowLines }) => {
  if (!groundTruth || !applied) return false;
  if (groundTruth.path !== applied.path) return false;
  const file = files?.[applied.path];
  if (!file) return false;
  const gt = lineWindow(file, groundTruth.search, windowLines);
  const ap = lineWindow(file, applied.search, windowLines);
  return rangeIoU(gt, ap) > 0;
};

// ───────────────────────── main ─────────────────────────

const readJsonl = (filePath) => {
  const text = fs.readFileSync(filePath, 'utf8');
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (e) {
      console.error('skipping malformed JSONL line:', e.message);
    }
  }
  return out;
};

const main = async () => {
  const tuples = readJsonl(CFG.log);
  console.log(`loaded ${tuples.length} replay tuples from ${CFG.log}`);
  console.log(`scoring with α=${CFG.alpha} β=${CFG.beta} window=±${CFG.window} lines\n`);

  const summary = {
    n_tuples: tuples.length,
    n_with_ground_truth: 0,
    n_ground_truth_filtered: 0,
    n_emitted_predictions: 0,
    n_validated_predictions: 0,
    score_sum: 0,
    score_count: 0,
    per_tuple: [],
  };

  for (const t of tuples) {
    const files = t.files || {};
    const predictions = t.predictions_emitted || [];
    const gt = t.ground_truth_next_edit;

    summary.n_emitted_predictions += predictions.length;

    // Validator pass — Phase 1's hard validator from lib/nextEdit.
    let validatedCount = 0;
    for (const p of predictions) {
      const v = validateBlock(
        { path: p.path, kind: p.kind || NEP_BLOCK_KIND.SEARCH, search: p.search, replace: p.replace },
        (path) => files[path] ?? null,
      );
      if (v.ok || v.reason === 'phase2_required') validatedCount += 1;
    }
    summary.n_validated_predictions += validatedCount;

    // Ground-truth filter (Plan Q2 region-exclusion).
    if (!gt) {
      summary.per_tuple.push({ session: t.session_id, ts: t.ts, status: 'no_ground_truth' });
      continue;
    }
    summary.n_with_ground_truth += 1;
    if (overlapsAppliedRegion({
      groundTruth: gt,
      applied: t.applied_edit,
      files,
      windowLines: CFG.window,
    })) {
      summary.n_ground_truth_filtered += 1;
      summary.per_tuple.push({ session: t.session_id, ts: t.ts, status: 'gt_overlaps_applied' });
      continue;
    }

    // Score each prediction against the ground truth; keep the BEST score
    // (the model often emits multiple plausible blocks and we want to
    // reward the closest one rather than penalise the runners-up).
    let bestScore = 0;
    let bestBreakdown = { region_iou: 0, text_sim: 0 };
    for (const p of predictions) {
      const r = scorePrediction({
        prediction: p, groundTruth: gt, files,
        alpha: CFG.alpha, beta: CFG.beta, windowLines: CFG.window,
      });
      if (r.score > bestScore) {
        bestScore = r.score;
        bestBreakdown = r;
      }
    }
    summary.score_sum += bestScore;
    summary.score_count += 1;
    summary.per_tuple.push({
      session: t.session_id,
      ts: t.ts,
      status: 'scored',
      best_score: Number(bestScore.toFixed(3)),
      region_iou: Number((bestBreakdown.region_iou ?? 0).toFixed(3)),
      text_sim: Number((bestBreakdown.text_sim ?? 0).toFixed(3)),
      n_predictions: predictions.length,
    });
    if (CFG.verbose) {
      console.log(`  [${t.session_id}] best_score=${bestScore.toFixed(3)} (iou=${bestBreakdown.region_iou.toFixed(3)} sim=${bestBreakdown.text_sim.toFixed(3)})`);
    }
  }

  const meanScore = summary.score_count > 0 ? summary.score_sum / summary.score_count : 0;
  const validationRate = summary.n_emitted_predictions > 0
    ? summary.n_validated_predictions / summary.n_emitted_predictions : 0;

  console.log('\n━━━ summary ━━━');
  console.log(`  tuples:                 ${summary.n_tuples}`);
  console.log(`  with ground truth:      ${summary.n_with_ground_truth}`);
  console.log(`  filtered (gt-overlap):  ${summary.n_ground_truth_filtered}`);
  console.log(`  predictions emitted:    ${summary.n_emitted_predictions}`);
  console.log(`  predictions validated:  ${summary.n_validated_predictions}  (${(validationRate * 100).toFixed(1)}%)`);
  console.log(`  scored tuples:          ${summary.score_count}`);
  console.log(`  mean best score:        ${meanScore.toFixed(3)}  (α=${CFG.alpha} β=${CFG.beta})`);

  if (CFG.out) {
    const report = {
      ...summary,
      mean_best_score: Number(meanScore.toFixed(3)),
      validation_rate: Number(validationRate.toFixed(3)),
      config: { alpha: CFG.alpha, beta: CFG.beta, window_lines: CFG.window, log: CFG.log },
    };
    fs.writeFileSync(CFG.out, JSON.stringify(report, null, 2));
    console.log(`\nreport written to ${CFG.out}`);
  }
};

main().catch((e) => {
  console.error('replay failed:', e?.stack ?? e);
  process.exit(1);
});
