// Objective cue/timing quality, reusing the same metrics we validated for the
// xAI+Gemini segmenter work (terminal %, mid-clause %, dur stats). Only applies
// to providers that emit SRT.

function parseSrt(srt) {
  if (!srt) return [];
  const cues = [];
  const blocks = srt.split(/\r?\n\r?\n+/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    if (lines.length < 2) continue;
    const timing = lines.find((l) => l.includes("-->"));
    if (!timing) continue;
    const idx = lines.indexOf(timing);
    const text = lines
      .slice(idx + 1)
      .join(" ")
      .trim();
    const m = timing.match(
      /(\d{2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[,.]\d{3})/,
    );
    if (!m) continue;
    const toS = (ts) => {
      const [h, mn, sx] = ts.split(":");
      const [s, ms] = sx.replace(",", ".").split(".");
      return +h * 3600 + +mn * 60 + +s + (+ms || 0) / 1000;
    };
    cues.push({ start: toS(m[1]), end: toS(m[2]), text });
  }
  return cues;
}

export function scoreCues(srt) {
  const cues = parseSrt(srt);
  if (!cues.length) return null;
  const total = cues.length;
  const term = cues.filter((c) => /[.!?؟]$/.test(c.text)).length;
  const comma = cues.filter((c) => /،$/.test(c.text)).length;
  const mid = total - term - comma;
  const goodDur = cues.filter(
    (c) => c.end - c.start >= 1.5 && c.end - c.start <= 7,
  ).length;
  const tooLong = cues.filter((c) => c.end - c.start > 8).length;
  const tooShort = cues.filter((c) => c.end - c.start < 1).length;
  const avgDur = cues.reduce((a, c) => a + (c.end - c.start), 0) / total;
  const wordsPerCue = cues.map(
    (c) => c.text.split(/\s+/).filter(Boolean).length,
  );
  const avgWords = wordsPerCue.reduce((a, b) => a + b, 0) / total;
  const lastEnd = cues[cues.length - 1].end;

  // Composite cue-quality score on /100 scale:
  //   sentence-respect (terminal + comma fraction):  0..50 pts
  //   duration discipline (good-dur fraction):       0..50 pts
  //   penalty for too-long / too-short cues:         up to -20 pts
  const respectFrac = (term + comma) / total;
  const durFrac = goodDur / total;
  const overflowPenalty = Math.min(20, ((tooLong + tooShort) / total) * 80);
  const composite = Math.max(
    0,
    Math.min(100, respectFrac * 50 + durFrac * 50 - overflowPenalty),
  );

  return {
    total,
    term,
    comma,
    mid,
    termPct: Math.round((term / total) * 100),
    commaPct: Math.round((comma / total) * 100),
    midPct: Math.round((mid / total) * 100),
    goodDurPct: Math.round((goodDur / total) * 100),
    tooLong,
    tooShort,
    avgDur: +avgDur.toFixed(2),
    avgWords: +avgWords.toFixed(1),
    lastEndS: +lastEnd.toFixed(1),
    composite: Math.round(composite),
  };
}
