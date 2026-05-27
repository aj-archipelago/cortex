// Markdown report formatter.
//
// Total is a /100 weighted average of EVERY available dimension:
//   coverage, accuracy, readability, faithfulness, cue, timing
// Equal weight (1.0 each), renormalized when a dimension is absent (e.g.
// readability or timing for the reference, cue/timing for text-only providers).
// This way the table is sorted by a single comprehensive Total /100.

const DEFAULT_STAR_PROVIDER = "xai+gemini";
const STAR = "✨";

function n(x) {
  if (x === null || x === undefined || Number.isNaN(x)) return "—";
  return String(x);
}

// Total: average across all available scoring dimensions, all on /100.
// Each dimension contributes equally; absent dimensions are skipped (weights
// renormalized) so text-only and SRT providers stay on the same scale.
function computeTotal(judge, cues, timing, opts = {}) {
  const dims = [
    judge?.coverage,
    judge?.accuracy,
    judge?.readability,
    judge?.faithfulness,
    cues?.composite,
    opts.excludeTiming ? null : timing?.composite,
  ].filter((v) => v != null && Number.isFinite(v));
  if (!dims.length) return null;
  const total = Math.round(dims.reduce((a, b) => a + b, 0) / dims.length);
  // For subtitle output, timestamps that drift by >10s are not usable even if
  // the transcript text is strong. Keep the text Judge visible, but cap the
  // product Total so these rows cannot outrank usable subtitle providers.
  if (!opts.excludeTiming && timing?.meanDriftS > 10)
    return Math.min(total, 50);
  return total;
}

// Pure: produce ranking metadata WITHOUT mutating input rows.
function rankRows(rows, refName, opts = {}) {
  const timingRefName = opts.timingRefName || null;
  const enriched = rows.map((r) => ({
    row: r,
    judge: r.judge,
    cues: r.cues,
    timing: r.timing,
    total: computeTotal(r.judge, r.cues, r.timing, {
      excludeTiming: timingRefName && r.name === timingRefName,
    }),
    hasSrt: !!r.srt,
    isTimingRef: timingRefName && r.name === timingRefName,
  }));

  return [...enriched].sort((a, b) => {
    if (a.row.name === refName) return -1;
    if (b.row.name === refName) return 1;
    // Primary: Total (the comprehensive /100 score).
    const at = a.total ?? -1;
    const bt = b.total ?? -1;
    if (bt !== at) return bt - at;
    // Tiebreaker: judge.overall.
    const aj = a.judge?.overall ?? -1;
    const bj = b.judge?.overall ?? -1;
    if (bj !== aj) return bj - aj;
    // Final tiebreaker: cue composite.
    const ac = a.cues?.composite ?? -1;
    const bc = b.cues?.composite ?? -1;
    return bc - ac;
  });
}

export function buildTable(rows, refName, audioFile, opts = {}) {
  const promptVersion = opts.promptVersion || "?";
  const judgeModel = opts.judgeModel || "?";
  const starProvider = opts.starProvider || DEFAULT_STAR_PROVIDER;
  const timingRefName = opts.timingRefName || null;
  const ranked = rankRows(rows, refName, { timingRefName });

  const header = [
    "# Transcribe Bench — sorted results",
    "",
    `Audio: \`${audioFile}\`  ·  Reference: **${refName}**  ·  Providers: ${rows.length}`,
    timingRefName && timingRefName !== refName
      ? `Timing reference: **${timingRefName}**  ·  Text reference: **${refName}**`
      : timingRefName
        ? `Timing reference: **${timingRefName}**`
        : "Timing reference: **none**",
    `Judge: \`${judgeModel}\`  ·  Prompt version: \`${promptVersion}\`  ·  Generated: ${new Date().toISOString()}`,
    "",
    "| Rank | Provider | Type | Source | Cov | Acc | Read | Faith | Cue | Timing | Judge | **Total** |",
    "|---:|:---|:---|:---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];

  let rank = 0;
  const body = ranked.map(
    ({ row, judge, cues, timing, total, hasSrt, isTimingRef }) => {
      const isRef = row.name === refName;
      if (!isRef) rank += 1;
      const j = judge || {};
      const c = cues || {};
      const t = timing || {};
      const star = row.name === starProvider ? ` ${STAR}` : "";
      // Type: distinguish providers whose timestamps are fabricated by an
      // LLM from those with real audio-based timing. When mean drift > 10s
      // the timing is effectively non-functional for subtitle use.
      let type = hasSrt ? "audio+ts" : "text-only";
      if (hasSrt && t.composite != null && t.meanDriftS > 10)
        type = "audio+ts⚠";
      const cueCell = n(c.composite);
      const timingCell = isTimingRef
        ? "ref"
        : t.composite != null
          ? t.meanDriftS > 10
            ? `${t.composite} ⚠`
            : String(t.composite)
          : "—";
      const judgeCell = isRef ? "ref" : n(j.overall);
      const totalCell = isRef
        ? "**ref**"
        : total != null
          ? `**${total}**`
          : "—";
      const rankStr = isRef ? "**ref**" : String(rank);
      return `| ${rankStr} | **${row.name}**${star} | ${type} | ${row.source} | ${n(j.coverage)} | ${n(j.accuracy)} | ${n(j.readability)} | ${n(j.faithfulness)} | ${cueCell} | ${timingCell} | ${judgeCell} | ${totalCell} |`;
    },
  );

  // Per-provider report — strengths + weaknesses + objective stats, ranked.
  const report = ["", "## Per-provider report", ""];
  let reportRank = 0;
  for (const {
    row,
    judge,
    cues,
    timing,
    total,
    hasSrt,
    isTimingRef,
  } of ranked) {
    const isRef = row.name === refName;
    if (!isRef) reportRank += 1;
    const j = judge || {};
    const c = cues || {};
    const t = timing || {};
    const star = row.name === starProvider ? ` ${STAR}` : "";
    const head = isRef
      ? `### REF · ${row.name}`
      : `### ${reportRank}. ${row.name}${star} — Total **${total ?? "—"}** / 100  (judge ${j.overall ?? "—"})`;
    report.push(head);
    const breakdown = [];
    if (j.coverage != null) breakdown.push(`coverage ${j.coverage}`);
    if (j.accuracy != null) breakdown.push(`accuracy ${j.accuracy}`);
    if (j.readability != null) breakdown.push(`readability ${j.readability}`);
    if (j.faithfulness != null)
      breakdown.push(`faithfulness ${j.faithfulness}`);
    if (c.composite != null) breakdown.push(`cue ${c.composite}`);
    if (t.composite != null) breakdown.push(`timing ${t.composite}`);
    report.push(
      `*Type*: ${hasSrt ? "audio+timestamps" : "text-only"}  ·  *Source*: ${row.source}  ·  *Scores*: ${breakdown.join(" · ")}`,
    );
    if (j.strengths) report.push(`- **Good**: ${j.strengths}`);
    if (j.weaknesses) report.push(`- **Drops caused by**: ${j.weaknesses}`);
    if (c.composite != null) {
      report.push(
        `- **Cue stats**: ${c.total} cues · ${c.termPct}% end with terminal punctuation · ${c.midPct}% mid-clause · ${c.tooLong} too-long (>8s) · avg ${c.avgDur}s / ${c.avgWords}w`,
      );
    }
    if (t.composite != null) {
      const drift = `mean drift ${t.meanDriftS}s · max drift ${t.maxDriftS}s`;
      const align =
        t.lastEndAlign != null
          ? ` · last-cue alignment ${t.lastEndAlign}/100`
          : "";
      const refNote = isTimingRef ? " · excluded from own Total" : "";
      report.push(
        `- **Timing stats**: matched ${t.matched}/${t.anchors} anchor phrases (${t.matchRatePct}%) · ${drift}${align}${refNote}`,
      );
    }
    report.push("");
  }

  const footer = [
    "",
    "## Legend",
    "",
    "- All scores are on a **0–100 scale**. Higher is better. Sorted by **Total**.",
    "- **Type**: `audio+ts` = real audio-based timestamps. `audio+ts⚠` = timestamps present but mean drift > 10s, meaning they are LLM-fabricated and unfit for subtitle use. `text-only` = no SRT.",
    "- **Cov / Acc / Read / Faith**: LLM judge scores (coverage, accuracy, readability, faithfulness vs. reference). 0–100.",
    "- **Cue**: composite from terminal-end %, mid-clause %, duration discipline. 0–100. SRT-only.",
    "- **Timing**: composite from anchor-phrase match rate + mean timestamp drift vs the timing reference shown at the top of the report. 0–100. SRT-only. `⚠` = drift > 10s.",
    "- `Timing=ref` means that provider supplied the timing reference; its self-timing score is excluded from its own Total to avoid ranking bias.",
    "- Providers with mean timing drift >10s are capped at Total 50 because they are not usable as subtitle output; use their Judge score only for text-only comparison.",
    "- **Judge**: the LLM judge's own `overall` summary score. 0–100. Shown for cross-checking but NOT how the table is sorted.",
    "- **Total** *(rank column)*: equal-weighted average of every available dimension (Cov, Acc, Read, Faith, Cue, Timing). 0–100. Renormalized when a column is absent so SRT and text-only providers stay on the same scale.",
    `- **${STAR}** marks the configured star provider (default: \`${DEFAULT_STAR_PROVIDER}\`).`,
    '- "Source: cached" = loaded from prior runs in the cache dir. "cached(latest)" = Cortex-produced SRT from a previous `--live` run. "cached(legacy ...)" = older prototype output. "live" = generated by Cortex during this run.',
  ];

  return { md: [...header, ...body, ...report, ...footer].join("\n"), ranked };
}
