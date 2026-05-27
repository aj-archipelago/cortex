// Multi-run stability report.
//
// Given N independent bench runs (each producing per-provider rows with
// dimension scores), this module:
//   - aggregates Mean/Stdev/Range per dimension and Total
//   - tracks per-run rank for each provider
//   - writes a justification table that mirrors the human-style analysis:
//       * "wins #1 in X/N runs"
//       * strongest/weakest dimension
//       * "fabricated timing" callout when mean drift > 10s
//       * loop/hallucination callouts when judge faithfulness is low
//
// Output is a single markdown report ranked by mean Total.

const STAR = "✨";
const NUMERIC_DIMS = [
  "cov",
  "acc",
  "read",
  "faith",
  "cue",
  "timing",
  "judge",
  "total",
];

function statsOf(values) {
  const v = values.filter((x) => x != null && Number.isFinite(x));
  if (!v.length) return null;
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  const variance = v.reduce((a, b) => a + (b - mean) ** 2, 0) / v.length;
  const stdev = Math.sqrt(variance);
  return {
    mean: +mean.toFixed(1),
    stdev: +stdev.toFixed(1),
    min: Math.min(...v),
    max: Math.max(...v),
    range: Math.max(...v) - Math.min(...v),
    n: v.length,
  };
}

// Pull the per-provider row across runs into a single record per provider.
// rowsPerRun: array of arrays — each sub-array is the ranked rows of one run,
// where each row has { row.name, judge?, cues?, timing?, total }.
function collectByProvider(rowsPerRun, refName) {
  const byName = new Map();
  rowsPerRun.forEach((rows, runIdx) => {
    rows.forEach(({ row, judge, cues, timing, total }, _idx) => {
      const name = row.name;
      if (!byName.has(name)) {
        byName.set(name, {
          name,
          isRef: name === refName,
          type: row.srt
            ? timing && timing.meanDriftS > 10
              ? "audio+ts⚠"
              : "audio+ts"
            : "text-only",
          source: row.source,
          runs: [],
        });
      }
      byName.get(name).runs.push({
        runIdx,
        cov: judge?.coverage,
        acc: judge?.accuracy,
        read: judge?.readability,
        faith: judge?.faithfulness,
        judge: judge?.overall,
        cue: cues?.composite,
        timing: timing?.composite,
        total,
        meanDriftS: timing?.meanDriftS,
        strengths: judge?.strengths || "",
        weaknesses: judge?.weaknesses || "",
      });
    });
  });
  // Compute aggregate stats per provider per dimension.
  for (const p of byName.values()) {
    p.stats = {};
    for (const d of NUMERIC_DIMS) {
      p.stats[d] = statsOf(p.runs.map((r) => r[d]));
    }
    // mean drift across runs (for the audio+ts⚠ classification)
    const drifts = p.runs.map((r) => r.meanDriftS).filter((x) => x != null);
    if (drifts.length) {
      const meanDrift = drifts.reduce((a, b) => a + b, 0) / drifts.length;
      if (meanDrift > 10) p.type = "audio+ts⚠";
    }
  }
  return byName;
}

// Rank per run (excluding ref) by total, attach rank history per provider.
function attachRanks(byName, rowsPerRun, refName) {
  rowsPerRun.forEach((rows, runIdx) => {
    const ranked = rows
      .filter((r) => r.row.name !== refName)
      .sort((a, b) => (b.total ?? -1) - (a.total ?? -1));
    ranked.forEach(({ row }, idx) => {
      const p = byName.get(row.name);
      if (!p.ranks) p.ranks = [];
      p.ranks[runIdx] = idx + 1;
    });
  });
  // Reference: no rank
  const ref = byName.get(refName);
  if (ref) ref.ranks = [];
}

function justify(p, totalRuns) {
  if (p.isRef) return "Used as the ground-truth reference.";

  const parts = [];
  const ranks = p.ranks || [];
  const rank1Count = ranks.filter((r) => r === 1).length;
  const lastRank = Math.max(...ranks.filter(Number.isFinite));
  const lastCount = ranks.filter((r) => r === lastRank).length;

  if (rank1Count > 0 && rank1Count >= totalRuns / 2) {
    parts.push(`**Wins #1 in ${rank1Count}/${totalRuns} runs.**`);
  } else if (lastCount === totalRuns) {
    parts.push(`Stuck at last place (#${lastRank}) in all ${totalRuns} runs.`);
  } else {
    const ranksTxt = ranks.filter(Number.isFinite).join("/");
    parts.push(`Ranks ${ranksTxt} across ${totalRuns} runs.`);
  }

  // Strongest / weakest dimension
  const dimMeans = {};
  for (const d of ["cov", "acc", "read", "faith", "cue", "timing"]) {
    if (p.stats[d]?.n) dimMeans[d] = p.stats[d].mean;
  }
  if (Object.keys(dimMeans).length) {
    const sorted = Object.entries(dimMeans).sort((a, b) => b[1] - a[1]);
    const strongest = sorted[0];
    const weakest = sorted[sorted.length - 1];
    const labels = {
      cov: "Coverage",
      acc: "Accuracy",
      read: "Readability",
      faith: "Faithfulness",
      cue: "Cue",
      timing: "Timing",
    };
    parts.push(
      `Strongest: ${labels[strongest[0]]} (${strongest[1]}). Weakest: ${labels[weakest[0]]} (${weakest[1]}).`,
    );
  }

  // Timing callout
  if (p.type === "audio+ts⚠") {
    parts.push(
      "⚠ Timing is **fabricated** by the LLM (mean drift >10s) — unfit for SRT use.",
    );
  }

  // Looping / hallucination callout (faithfulness <30 is the marker)
  if (p.stats.faith?.mean != null && p.stats.faith.mean < 30) {
    parts.push("Judge consistently flags severe looping / hallucinations.");
  }

  // Pull the most distinctive weakness from the latest run that has one
  const recentWeakness = [...p.runs]
    .reverse()
    .find((r) => r.weaknesses)?.weaknesses;
  if (recentWeakness) {
    // Trim to one sentence
    const oneLine = recentWeakness.split(/(?<=[.!])\s/)[0].trim();
    parts.push(`*"${oneLine}"*`);
  }

  return parts.join(" ");
}

export function buildStabilityReport(rowsPerRun, refName, opts = {}) {
  const totalRuns = rowsPerRun.length;
  const audioFile = opts.audioFile || "?";
  const judgeModel = opts.judgeModel || "?";
  const promptVersion = opts.promptVersion || "?";
  const starProvider = opts.starProvider || "xai+gemini";

  const byName = collectByProvider(rowsPerRun, refName);
  attachRanks(byName, rowsPerRun, refName);

  const all = [...byName.values()];
  const candidates = all.filter((p) => !p.isRef);
  candidates.sort(
    (a, b) => (b.stats.total?.mean ?? -1) - (a.stats.total?.mean ?? -1),
  );
  const ref = all.find((p) => p.isRef);

  const lines = [];
  lines.push("# Transcribe Bench — multi-run stability report");
  lines.push("");
  lines.push(
    `Audio: \`${audioFile}\`  ·  Reference: **${refName}**  ·  Runs: ${totalRuns}  ·  Judge: \`${judgeModel}\`  ·  Prompt: \`${promptVersion}\`  ·  Generated: ${new Date().toISOString()}`,
  );
  lines.push("");

  // Per-run Total matrix
  lines.push("## Per-run Total scores");
  lines.push("");
  lines.push(
    "| # | Provider | Type | " +
      Array.from({ length: totalRuns }, (_, i) => `R${i + 1}`).join(" | ") +
      " | Mean | Stdev | Range |",
  );
  lines.push(
    "|---:|:---|:---|" + "---:|".repeat(totalRuns) + "---:|---:|---:|",
  );

  if (ref) {
    lines.push(
      `| **ref** | **${ref.name}** | ${ref.type} | ${"ref | ".repeat(totalRuns)}**ref** | — | — |`,
    );
  }
  candidates.forEach((p, i) => {
    const totals = Array.from(
      { length: totalRuns },
      (_, j) => p.runs.find((r) => r.runIdx === j)?.total ?? "—",
    );
    const star = p.name === starProvider ? ` ${STAR}` : "";
    lines.push(
      `| ${i + 1} | **${p.name}**${star} | ${p.type} | ${totals.join(" | ")} | **${p.stats.total?.mean ?? "—"}** | ${p.stats.total?.stdev ?? "—"} | ${p.stats.total?.range ?? "—"} |`,
    );
  });
  lines.push("");

  // Detailed per-dimension averages (mean over all runs)
  lines.push("## Mean dimension scores across runs (sorted by Total)");
  lines.push("");
  lines.push(
    "| # | Provider | Type | Cov | Acc | Read | Faith | Cue | Timing | Judge | **Total** |",
  );
  lines.push("|---:|:---|:---|---:|---:|---:|---:|---:|---:|---:|---:|");
  if (ref) {
    const r = ref.runs[0] || {};
    lines.push(
      `| **ref** | **${ref.name}** | ${ref.type} | ${r.cov ?? "—"} | ${r.acc ?? "—"} | ${r.read ?? "—"} | ${r.faith ?? "—"} | — | — | ref | **ref** |`,
    );
  }
  candidates.forEach((p, i) => {
    const star = p.name === starProvider ? ` ${STAR}` : "";
    const m = (d) => p.stats[d]?.mean ?? "—";
    lines.push(
      `| ${i + 1} | **${p.name}**${star} | ${p.type} | ${m("cov")} | ${m("acc")} | ${m("read")} | ${m("faith")} | ${m("cue")} | ${m("timing")} | ${m("judge")} | **${m("total")}** |`,
    );
  });
  lines.push("");

  // Justification per provider
  lines.push("## Per-provider justification");
  lines.push("");
  if (ref) lines.push(`### REF · ${ref.name}\n${justify(ref, totalRuns)}\n`);
  candidates.forEach((p, i) => {
    const star = p.name === starProvider ? ` ${STAR}` : "";
    lines.push(
      `### ${i + 1}. ${p.name}${star}  —  Total ${p.stats.total?.mean ?? "—"} ± ${p.stats.total?.stdev ?? "—"}`,
    );
    lines.push(justify(p, totalRuns));
    lines.push("");
  });

  // Footer
  lines.push("## Reading guide");
  lines.push("");
  lines.push("- All scores are 0–100. Higher is better. Sorted by mean Total.");
  lines.push(
    "- **Stdev** is the standard deviation of Total across the runs. Smaller = more reproducible.",
  );
  lines.push(
    "- **Range** = max Total − min Total across runs. Adjacent providers within ~5 points are statistically tied (LLM judge jitter floor).",
  );
  lines.push(
    "- **Type** `audio+ts⚠` = the provider returned timestamps but mean drift is > 10s, meaning they're LLM-fabricated — DO NOT use for subtitle production.",
  );
  lines.push(
    `- **${STAR}** marks the configured star provider (default: \`${starProvider}\`).`,
  );

  return lines.join("\n");
}
