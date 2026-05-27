// Hybrid alignment works in three steps:
// 1. normalize Gemini/xAI words, including common Arabic orthographic variants;
// 2. anchor matching n-grams from strict to loose, bounded by time tolerance;
// 3. drop severe non-monotonic anchors, then interpolate gaps between anchors.
const NGRAM_LEVELS = [5, 4, 3, 2, 1];
const NGRAM_TOLERANCE_SECONDS = { 5: 60, 4: 60, 3: 30, 2: 15, 1: 8 };
const BACKWARD_DRIFT_DROP_SECONDS = 10;
const FORWARD_DRIFT_DROP_SECONDS = 30;

function normalizeWord(word) {
  if (!word) return "";
  return word
    .replace(/[،؟؛:.!,?;\-"'()…«»]/g, "")
    .replace(/[ً-ٰٟ]/g, "")
    .replace(/[إأآا]/g, "ا")
    .replace(/ة/g, "ه")
    .toLowerCase()
    .trim();
}

function buildNgramIndex(words, n) {
  const idx = new Map();
  for (let i = 0; i + n <= words.length; i++) {
    let bad = false;
    for (let k = 0; k < n; k++) {
      if (!words[i + k]) {
        bad = true;
        break;
      }
    }
    if (bad) continue;
    const key = words.slice(i, i + n).join(" ");
    const arr = idx.get(key);
    if (arr) arr.push(i);
    else idx.set(key, [i]);
  }
  return idx;
}

function estimateTime(gi, sortedKeys, anchors, totalWords, audioDur) {
  if (!sortedKeys.length) return (gi / Math.max(1, totalWords)) * audioDur;
  let lo = 0;
  let hi = sortedKeys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedKeys[mid] <= gi) lo = mid + 1;
    else hi = mid;
  }
  const prevIdx = lo - 1;
  const nextIdx = lo < sortedKeys.length ? lo : -1;
  if (prevIdx < 0) {
    const fk = sortedKeys[0];
    const f = anchors.get(fk);
    return Math.max(0, f.start * (gi / Math.max(1, fk)));
  }
  if (nextIdx < 0) {
    const lk = sortedKeys[sortedKeys.length - 1];
    const l = anchors.get(lk);
    const remain = Math.max(audioDur - l.end, 0);
    const left = Math.max(1, totalWords - lk);
    return Math.min(audioDur, l.end + ((gi - lk) / left) * remain);
  }
  const pK = sortedKeys[prevIdx];
  const nK = sortedKeys[nextIdx];
  const p = anchors.get(pK);
  const nxt = anchors.get(nK);
  return p.end + ((gi - pK) / (nK - pK)) * (nxt.start - p.end);
}

export function alignWords(
  geminiWords,
  xaiWords,
  audioDuration,
  { logger, logPrefix = "[xai_gemini]" } = {},
) {
  const N = geminiWords.length;
  const audioDur = Math.max(
    audioDuration || 0,
    xaiWords.length ? xaiWords[xaiWords.length - 1].end : 0,
  );

  if (!N || !xaiWords.length) {
    const per = audioDur / Math.max(1, N);
    return geminiWords.map((w, i) => ({
      text: w,
      start: i * per,
      end: (i + 1) * per,
      type: "interp",
    }));
  }

  const gNorm = geminiWords.map(normalizeWord);
  const xNorm = xaiWords.map((w) => normalizeWord(w.text));

  const anchors = new Map();
  const usedG = new Set();
  const usedX = new Set();
  let sortedKeys = [];

  for (const n of NGRAM_LEVELS) {
    const xIdx = buildNgramIndex(xNorm, n);
    const tol = NGRAM_TOLERANCE_SECONDS[n];
    const gByKey = new Map();
    for (let gi = 0; gi + n <= N; gi++) {
      let skip = false;
      for (let k = 0; k < n; k++) {
        if (usedG.has(gi + k) || !gNorm[gi + k]) {
          skip = true;
          break;
        }
      }
      if (skip) continue;
      const key = gNorm.slice(gi, gi + n).join(" ");
      const arr = gByKey.get(key);
      if (arr) arr.push(gi);
      else gByKey.set(key, [gi]);
    }

    let added = 0;
    for (const [key, gPositions] of gByKey) {
      const xPositions = xIdx.get(key);
      if (!xPositions) continue;

      for (const gi of gPositions) {
        const tEst = estimateTime(gi, sortedKeys, anchors, N, audioDur);
        let bestXi = -1;
        let bestDist = Infinity;
        for (const xi of xPositions) {
          let collide = false;
          for (let k = 0; k < n; k++) {
            if (usedX.has(xi + k)) {
              collide = true;
              break;
            }
          }
          if (collide) continue;
          const dist = Math.abs(xaiWords[xi].start - tEst);
          if (dist <= tol && dist < bestDist) {
            bestDist = dist;
            bestXi = xi;
          }
        }
        if (bestXi < 0) continue;
        for (let k = 0; k < n; k++) {
          const w = xaiWords[bestXi + k];
          const next = xaiWords[bestXi + k + 1];
          const gapAfter = next ? Math.max(0, next.start - w.end) : 0;
          anchors.set(gi + k, { start: w.start, end: w.end, gapAfter });
          usedG.add(gi + k);
          usedX.add(bestXi + k);
        }
        added++;
      }
    }
    sortedKeys = [...anchors.keys()].sort((a, b) => a - b);
    logger?.info?.(
      `${logPrefix} anchor pass n=${n}: +${added} (total ${anchors.size})`,
    );
  }

  let removed = 0;
  for (;;) {
    sortedKeys = [...anchors.keys()].sort((a, b) => a - b);
    const drop = [];
    for (let i = 0; i < sortedKeys.length; i++) {
      const cur = anchors.get(sortedKeys[i]);
      const prev = i > 0 ? anchors.get(sortedKeys[i - 1]) : null;
      const nxt =
        i < sortedKeys.length - 1 ? anchors.get(sortedKeys[i + 1]) : null;
      if (
        (prev && cur.start < prev.start - BACKWARD_DRIFT_DROP_SECONDS) ||
        (nxt && cur.start > nxt.start + FORWARD_DRIFT_DROP_SECONDS)
      ) {
        drop.push(sortedKeys[i]);
      }
    }
    if (!drop.length) break;
    for (const k of drop) anchors.delete(k);
    removed += drop.length;
  }
  if (removed)
    logger?.info?.(`${logPrefix} monotonic filter dropped ${removed}`);

  sortedKeys = [...anchors.keys()].sort((a, b) => a - b);
  const aligned = new Array(N);

  if (!sortedKeys.length) {
    const per = audioDur / Math.max(1, N);
    for (let i = 0; i < N; i++) {
      aligned[i] = {
        text: geminiWords[i],
        start: i * per,
        end: (i + 1) * per,
        type: "interp",
      };
    }
    return aligned;
  }

  for (const gi of sortedKeys) {
    const a = anchors.get(gi);
    aligned[gi] = {
      text: geminiWords[gi],
      start: a.start,
      end: a.end,
      gapAfter: a.gapAfter || 0,
      type: "anchor",
    };
  }

  const fk = sortedKeys[0];
  const f = anchors.get(fk);
  if (fk > 0) {
    const per = f.start / fk;
    for (let i = 0; i < fk; i++) {
      aligned[i] = {
        text: geminiWords[i],
        start: i * per,
        end: (i + 1) * per,
        type: "interp",
      };
    }
  }

  for (let i = 0; i < sortedKeys.length - 1; i++) {
    const aK = sortedKeys[i];
    const bK = sortedKeys[i + 1];
    if (bK - aK <= 1) continue;
    const a = anchors.get(aK);
    const b = anchors.get(bK);
    const gap = bK - aK - 1;
    const dur = Math.max(b.start - a.end, 0.05);
    const per = dur / (gap + 1);
    for (let j = 0; j < gap; j++) {
      const gi = aK + 1 + j;
      const s = a.end + j * per;
      aligned[gi] = {
        text: geminiWords[gi],
        start: s,
        end: s + per,
        type: "interp",
      };
    }
  }

  const lk = sortedKeys[sortedKeys.length - 1];
  const l = anchors.get(lk);
  if (lk < N - 1) {
    const remain = Math.max(audioDur - l.end, 0.05);
    const gap = N - 1 - lk;
    const per = remain / gap;
    for (let i = lk + 1; i < N; i++) {
      const s = l.end + (i - lk - 1) * per;
      aligned[i] = {
        text: geminiWords[i],
        start: s,
        end: s + per,
        type: "interp",
      };
    }
  }

  return aligned;
}
