const STRONG_END_SCORE = 12;

function scoreBreak(w, trustGaps) {
  let s = 0;
  const sentenceEnd = /[.!؟?]$/.test(w.text);
  const hasTrustedGap = trustGaps || w.type === "anchor";
  const realGap = hasTrustedGap ? w.gapAfter || 0 : 0;

  if (sentenceEnd && realGap > 0.3) s += 12;
  else if (sentenceEnd && !hasTrustedGap) s += 9;
  else if (sentenceEnd) s += 7;
  if (realGap > 0.6) s += 6;
  else if (realGap > 0.3) s += 3;
  if (/،$/.test(w.text)) s += 1;
  return s;
}

function normalizeSegmentWords(words, trustGaps) {
  return words.map((w, i) => {
    const gapAfter = Number.isFinite(w.gapAfter)
      ? w.gapAfter
      : trustGaps && i + 1 < words.length
        ? Math.max(0, words[i + 1].start - w.end)
        : 0;
    return { ...w, gapAfter };
  });
}

function stabilizeSegments(segs) {
  for (let i = 1; i < segs.length; i++) {
    if (segs[i].start < segs[i - 1].end) segs[i].start = segs[i - 1].end;
    if (segs[i].end <= segs[i].start) segs[i].end = segs[i].start + 0.1;
  }
  return segs;
}

export function buildSegments(words, opts = {}, { trustGaps = true } = {}) {
  const {
    wordTimestamped = false,
    maxLineWidth = 0,
    maxWordsPerLine = 0,
    defaultMaxWords = 14,
    defaultMaxDuration = 7.0,
    minWords = 3,
    minCueDur = 1.0,
    lookAheadWords = 5,
    hardOverrunFactor = 1.25,
    deferThreshold = 6,
  } = opts;

  if (!words.length) return [];

  const timedWords = normalizeSegmentWords(words, trustGaps);

  if (wordTimestamped && !maxLineWidth && !maxWordsPerLine) {
    return stabilizeSegments(
      timedWords.map((w) => ({
        start: w.start,
        end: w.end,
        text: w.text,
      })),
    );
  }

  if (maxWordsPerLine > 0) {
    const segs = [];
    const limit = Math.max(1, Number.parseInt(maxWordsPerLine, 10) || 1);
    for (let i = 0; i < timedWords.length; i += limit) {
      const part = timedWords.slice(i, i + limit);
      segs.push({
        start: part[0].start,
        end: part[part.length - 1].end,
        text: part.map((w) => w.text).join(" "),
      });
    }
    return stabilizeSegments(segs);
  }

  const hardMaxWords = Math.ceil(defaultMaxWords * hardOverrunFactor);
  const hardMaxDur = defaultMaxDuration * hardOverrunFactor;

  const segs = [];
  let cur = [];
  const textOf = (arr, upto = arr.length) =>
    arr
      .slice(0, upto)
      .map((w) => w.text)
      .join(" ");

  function flushUpTo(idx) {
    const part = cur.slice(0, idx + 1);
    segs.push({
      start: part[0].start,
      end: part[part.length - 1].end,
      text: part.map((w) => w.text).join(" "),
    });
    cur = cur.slice(idx + 1);
  }

  function maxFitIdx() {
    if (maxWordsPerLine > 0)
      return Math.min(cur.length - 1, maxWordsPerLine - 1);
    if (maxLineWidth > 0) {
      for (let i = cur.length - 1; i >= 0; i--) {
        if (textOf(cur, i + 1).length <= maxLineWidth) return i;
      }
      return 0;
    }
    return cur.length - 1;
  }

  function bestBreakIdx(lo, hi) {
    if (!cur.length) return { idx: 0, score: -1 };
    const lastIdx = cur.length - 1;
    const upper = Math.min(Math.max(hi, 0), lastIdx);
    const lower = Math.min(Math.max(lo, 0), upper);
    let bestIdx = upper,
      bestScore = -1;
    for (let i = lower; i <= upper; i++) {
      const s = scoreBreak(cur[i], trustGaps);
      if (s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    }
    return { idx: bestIdx, score: bestScore };
  }

  for (let i = 0; i < timedWords.length; i++) {
    cur.push(timedWords[i]);
    const w = timedWords[i];
    const tentativeLen = textOf(cur).length;
    const startTime = cur[0].start;
    const widthExceeded = maxLineWidth > 0 && tentativeLen > maxLineWidth;
    const wordsExceeded = maxWordsPerLine > 0 && cur.length > maxWordsPerLine;
    const softExceeded =
      !maxLineWidth &&
      !maxWordsPerLine &&
      (cur.length >= defaultMaxWords ||
        w.end - startTime >= defaultMaxDuration);
    const hardExceeded =
      !maxLineWidth &&
      !maxWordsPerLine &&
      (cur.length >= hardMaxWords || w.end - startTime >= hardMaxDur);

    if (widthExceeded || wordsExceeded || hardExceeded) {
      const upper =
        widthExceeded || wordsExceeded ? maxFitIdx() : cur.length - 1;
      const lower = Math.max(minWords - 1, 0);
      flushUpTo(bestBreakIdx(lower, upper).idx);
      continue;
    }

    if (softExceeded && cur.length >= minWords) {
      const curBest = bestBreakIdx(minWords - 1, cur.length - 1);
      let aheadBest = -1;
      for (
        let j = i + 1;
        j < Math.min(timedWords.length, i + 1 + lookAheadWords);
        j++
      ) {
        const s = scoreBreak(timedWords[j], trustGaps);
        if (s > aheadBest) aheadBest = s;
      }
      if (aheadBest > curBest.score && aheadBest >= deferThreshold) continue;
      flushUpTo(curBest.idx);
    }

    if (!widthExceeded && !wordsExceeded && cur.length >= 2) {
      const last = cur[cur.length - 1];
      if (
        scoreBreak(last, trustGaps) >= STRONG_END_SCORE &&
        cur.length < defaultMaxWords
      ) {
        if (last.end - cur[0].start >= 0.6) {
          flushUpTo(cur.length - 1);
        }
      }
    }
  }
  if (cur.length) flushUpTo(cur.length - 1);

  const wordCount = (text) => text.trim().split(/\s+/).filter(Boolean).length;
  const canMergeWithoutBreakingLimits = (left, right) => {
    const mergedText = `${left.text} ${right.text}`.trim();
    if (maxWordsPerLine > 0 && wordCount(mergedText) > maxWordsPerLine) {
      return false;
    }
    if (maxLineWidth > 0 && mergedText.length > maxLineWidth) {
      return false;
    }
    return true;
  };

  for (let i = segs.length - 1; i > 0; i--) {
    const s = segs[i];
    if (
      s.end - s.start < minCueDur &&
      !/[.!؟?]$/.test(s.text.trim()) &&
      canMergeWithoutBreakingLimits(segs[i - 1], s)
    ) {
      segs[i - 1].end = s.end;
      segs[i - 1].text = segs[i - 1].text + " " + s.text;
      segs.splice(i, 1);
    }
  }

  return stabilizeSegments(segs);
}

export function segmentsToCues(segs) {
  return segs.map((s, i) => ({
    index: i + 1,
    startTime: Math.round(s.start * 1000),
    endTime: Math.round(s.end * 1000),
    text: s.text,
  }));
}
