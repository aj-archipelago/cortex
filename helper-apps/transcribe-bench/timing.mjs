// Timestamp-quality comparison.
//
// Approach:
//   1. From the reference SRT, extract N "anchor phrases" — 4-grams that
//      are unique within the reference, contain at least one ≥5-char
//      token, and are spaced apart so anchors cover the whole audio.
//   2. For each candidate that has SRT, find the first occurrence of each
//      anchor phrase in the candidate's flattened cue text and read its
//      start time.
//   3. drift_i = |candidate_start_i - reference_start_i|
//   4. Composite (0–100) = match-rate × 50 + drift-quality × 50, where
//      drift-quality = max(0, 1 − meanDrift / DRIFT_TOLERANCE_S).
//
// Tunables exposed via the function signatures so future bench runs can
// experiment without forking the module.

const NORM_RE_DIACRITICS = /[ً-ٰٟ]/g; // Arabic harakat
const NORM_RE_ALEF = /[إأآا]/g;
const NORM_RE_PUNCT = /[،؟؛:.!,?;\-"'()…«»]/g;

// Defaults: tighter than v1 — sharper differentiation between providers
// without rewarding sloppy timestamps.
const DEFAULT_ANCHOR_COUNT = 30;
const DEFAULT_ANCHOR_N = 4;
const DEFAULT_MIN_TOKEN_LEN = 5;
const DEFAULT_MIN_SPACING_TOKENS = 60; // ~25–30 s between anchors
const DEFAULT_DRIFT_TOLERANCE_S = 5; // 5 s drift = quality 0
const DEFAULT_LAST_END_TOLERANCE_S = 30; // last-cue end vs duration

function normalizeText(s) {
  if (!s) return "";
  return s
    .replace(NORM_RE_PUNCT, " ")
    .replace(NORM_RE_DIACRITICS, "")
    .replace(NORM_RE_ALEF, "ا")
    .replace(/ة/g, "ه")
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();
}

function parseSrt(srt) {
  if (!srt) return [];
  const out = [];
  for (const block of srt.split(/\r?\n\r?\n+/)) {
    const lines = block.split(/\r?\n/);
    const tIdx = lines.findIndex((l) => l.includes("-->"));
    if (tIdx < 0) continue;
    const m = lines[tIdx].match(
      /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/,
    );
    if (!m) continue;
    const text = lines
      .slice(tIdx + 1)
      .join(" ")
      .trim();
    const toS = (ts) => {
      const [h, mn, sx] = ts.split(":");
      const [s, ms] = sx.replace(",", ".").split(".");
      return +h * 3600 + +mn * 60 + +s + (+ms || 0) / 1000;
    };
    out.push({ start: toS(m[1]), end: toS(m[2]), text });
  }
  return out;
}

// Flatten cues into (token-stream, position→time) so phrases can be matched
// across cue boundaries and we can read back the timestamp of any token.
function flattenSrtToTokens(cues) {
  const tokens = [];
  const startOf = [];
  for (const c of cues) {
    const ws = normalizeText(c.text).split(" ").filter(Boolean);
    for (const w of ws) {
      tokens.push(w);
      startOf.push(c.start);
    }
  }
  return { tokens, startOf };
}

function pickAnchors(refTokens, refStartOf, opts = {}) {
  const n = opts.n ?? DEFAULT_ANCHOR_N;
  const target = opts.target ?? DEFAULT_ANCHOR_COUNT;
  const minTokenLen = opts.minTokenLen ?? DEFAULT_MIN_TOKEN_LEN;
  const minSpacing = opts.minSpacing ?? DEFAULT_MIN_SPACING_TOKENS;

  // Count n-gram occurrences so we can keep only the unique-in-ref ones.
  const counts = new Map();
  for (let i = 0; i + n <= refTokens.length; i++) {
    const key = refTokens.slice(i, i + n).join(" ");
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const anchors = [];
  let lastTakenIdx = -Infinity;
  for (let i = 0; i + n <= refTokens.length; i++) {
    if (i - lastTakenIdx < minSpacing) continue;
    const grams = refTokens.slice(i, i + n);
    const key = grams.join(" ");
    if (counts.get(key) !== 1) continue;
    if (!grams.some((t) => t.length >= minTokenLen)) continue;
    anchors.push({ phrase: key, refStart: refStartOf[i] });
    lastTakenIdx = i;
    if (anchors.length >= target) break;
  }
  return anchors;
}

// First occurrence of `phrase` in candidate token stream → start time at that
// position (or null if not found).
function findPhraseStart(candTokens, candStartOf, phrase) {
  const want = phrase.split(" ");
  const n = want.length;
  outer: for (let i = 0; i + n <= candTokens.length; i++) {
    for (let k = 0; k < n; k++)
      if (candTokens[i + k] !== want[k]) continue outer;
    return candStartOf[i];
  }
  return null;
}

export function buildAnchorsFromReferenceSrt(refSrt, opts) {
  const cues = parseSrt(refSrt);
  if (!cues.length) return [];
  const { tokens, startOf } = flattenSrtToTokens(cues);
  return pickAnchors(tokens, startOf, opts);
}

export function scoreTiming(candidateSrt, anchors, audioDurationS, opts = {}) {
  const driftTol = opts.driftToleranceS ?? DEFAULT_DRIFT_TOLERANCE_S;
  const lastEndTol = opts.lastEndToleranceS ?? DEFAULT_LAST_END_TOLERANCE_S;

  if (!candidateSrt || !anchors || !anchors.length) return null;
  const cues = parseSrt(candidateSrt);
  if (!cues.length) return null;
  const { tokens, startOf } = flattenSrtToTokens(cues);

  const drifts = [];
  let matched = 0;
  for (const a of anchors) {
    const cs = findPhraseStart(tokens, startOf, a.phrase);
    if (cs === null) continue;
    matched++;
    drifts.push(Math.abs(cs - a.refStart));
  }
  const totalAnchors = anchors.length;
  const matchRate = matched / totalAnchors;
  const meanDrift = drifts.length
    ? drifts.reduce((a, b) => a + b, 0) / drifts.length
    : 0;
  const maxDrift = drifts.length ? Math.max(...drifts) : 0;

  const lastEnd = cues[cues.length - 1].end;
  let lastEndAlign = null;
  if (audioDurationS) {
    const err = Math.abs(lastEnd - audioDurationS);
    lastEndAlign = Math.round(Math.max(0, 1 - err / lastEndTol) * 100);
  }

  const driftQuality = Math.max(0, 1 - meanDrift / driftTol);
  const composite = Math.round(
    Math.max(0, Math.min(100, matchRate * 50 + driftQuality * 50)),
  );

  return {
    anchors: totalAnchors,
    matched,
    matchRatePct: Math.round(matchRate * 100),
    meanDriftS: +meanDrift.toFixed(2),
    maxDriftS: +maxDrift.toFixed(2),
    lastEndS: +lastEnd.toFixed(1),
    lastEndAlign,
    composite,
  };
}
