#!/usr/bin/env node
// Transcribe Bench - LLM-as-judge benchmark for ASR providers.
//
// See `node bench.mjs --help` for full options.

import fs from "node:fs";
import path from "node:path";
import { loadProvider, PROVIDERS_ALL, CACHE_DIR } from "./providers.mjs";
import { judgeAgainst, refRowScore, PROMPT_VERSION } from "./judge.mjs";
import { scoreCues } from "./score.mjs";
import { buildAnchorsFromReferenceSrt, scoreTiming } from "./timing.mjs";
import { buildTable } from "./format.mjs";
import { buildStabilityReport } from "./stability.mjs";

const HELP = `transcribe-bench - LLM-as-judge ASR comparison

Usage:
  node bench.mjs [options]

Options:
  --providers LIST     Comma-separated subset (default: all known)
  --reference NAME     Pin the reference. Default: auto (trint > elevenlabs > longest).
                       Errors loudly if NAME is not in --providers.
  --judge MODEL        Cortex model name for the judge (default: gemini-pro-31-vision)
  --live               Re-run Cortex transcription pathways (xai+gemini, xai, gemini, whisper)
                       and cache their SRT for next time. Requires --audioUrl.
  --audioUrl URL       Fetchable URL of the audio (cortex must be able to GET it).
  --audio LABEL        Display label for the audio in the report.
  --language CODE      Language hint passed to live transcribe pathways (default: ar).
  --output PATH        Write the markdown report here (default: results/bench_<ts>.md).
  --star PROVIDER      Mark this provider in the table (default: xai+gemini).
  --pool N             Concurrency for the LLM judge (default: 4).
  --runs N             Run the bench N times and emit a multi-run stability
                       report alongside the single-run table. Default: 1.
  -h, --help           Show this help.

Environment:
  CORTEX_URL           GraphQL endpoint (default: http://localhost:4000/graphql).
  TRANSCRIBE_BENCH_CACHE_DIR
                       Cached transcripts directory (default: ${CACHE_DIR}).

Known providers:
  ${PROVIDERS_ALL.join(", ")}
`;

function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      out.help = true;
      continue;
    }
    if (!a.startsWith("--")) continue;
    const k = a.slice(2);
    const next = argv[i + 1];
    const v = next != null && !next.startsWith("--") ? argv[++i] : true;
    out[k] = v;
  }
  return out;
}

const DEFAULT_PROVIDERS = [
  "xai+gemini",
  "el+gemini",
  "xai",
  "gemini",
  "whisper",
  "elevenlabs",
  "assemblyai",
  "deepgram",
  "speechmatics",
  "cohere",
  "mai",
  "vibevoice",
  "higgs",
  "trint",
];

// Default reference: trint first (the user's suggested ground truth, which the
// judge has confirmed is high-quality), then elevenlabs (timing-rich SRT
// reference), else longest text. NOTE: not "entity density" - we don't
// actually measure entities, this is purely heuristic ordering.
function autoPickReference(rows) {
  const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
  if (byName.trint) return "trint";
  if (byName.elevenlabs) return "elevenlabs";
  return [...rows].sort((a, b) => b.text.length - a.text.length)[0]?.name;
}

// Audio duration estimate from whichever SRT runs to the largest end time.
// Used by timing.mjs to score last-cue alignment vs reality.
function estimateAudioDurationS(rows) {
  let max = 0;
  for (const r of rows) {
    if (!r.srt) continue;
    // Cheap: scan timing lines for the last "--> HH:MM:SS,mmm".
    const matches = [
      ...r.srt.matchAll(/-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/g),
    ];
    if (!matches.length) continue;
    const last = matches[matches.length - 1];
    const s = +last[1] * 3600 + +last[2] * 60 + +last[3] + +last[4] / 1000;
    if (s > max) max = s;
  }
  return max || null;
}

// Run a single bench pass and return { rows, refName, ranked } for aggregation.
// Provider loading and reference picking only happen on runIdx===0 (the
// transcripts don't change between runs); subsequent runs deep-clone the
// loaded rows and re-run the LLM judge to capture per-run variance.
async function runOnce({
  rows,
  refName,
  judgeModel,
  starProvider,
  pool,
  audio,
  runIdx,
  totalRuns,
}) {
  const reference = rows.find((r) => r.name === refName);

  // Objective cue scoring (deterministic, identical across runs)
  for (const r of rows) {
    if (r.srt && !r.cues) r.cues = scoreCues(r.srt);
  }

  // Timing scoring (deterministic, identical across runs)
  let timingRefName = null;
  if (!rows.some((r) => r.timing)) {
    let anchors = [];
    if (reference.srt) {
      anchors = buildAnchorsFromReferenceSrt(reference.srt);
      timingRefName = reference.name;
    } else {
      const fallback =
        rows.find((r) => r.name === "elevenlabs" && r.srt) ||
        rows.find((r) => r.name === starProvider && r.srt) ||
        rows.find((r) => r.srt);
      if (fallback) {
        anchors = buildAnchorsFromReferenceSrt(fallback.srt);
        timingRefName = fallback.name;
      }
    }
    const audioDur = estimateAudioDurationS(rows);
    for (const r of rows) {
      if (r.srt) r.timing = scoreTiming(r.srt, anchors, audioDur);
    }
  } else {
    timingRefName = rows.find((r) => r.timing)?.timingRefName || null;
  }
  if (timingRefName) {
    for (const r of rows) {
      if (r.timing) r.timingRefName = timingRefName;
    }
  }

  // LLM judge - re-runs every pass so we capture variance.
  const queue = rows.filter((r) => r.name !== refName);
  // Reset previous-run judge data so workers don't read stale state
  queue.forEach((r) => {
    r.judge = undefined;
  });
  let cursor = 0;
  console.error(
    `\n[run ${runIdx + 1}/${totalRuns}] Judge pool (${pool} workers)...`,
  );
  async function worker(id) {
    while (cursor < queue.length) {
      const r = queue[cursor++];
      try {
        r.judge = await judgeAgainst(reference, r, { model: judgeModel });
        console.error(
          `  [r${runIdx + 1} w${id}] ${r.name}: judge.overall=${r.judge.overall}`,
        );
      } catch (e) {
        r.judge = {
          coverage: 0,
          accuracy: 0,
          readability: 0,
          faithfulness: 0,
          overall: 0,
          note: "judge error: " + e.message,
          strengths: "",
          weaknesses: "",
        };
        console.error(
          `  [r${runIdx + 1} w${id}] ${r.name}: ERROR ${e.message}`,
        );
      }
    }
  }
  await Promise.all(Array.from({ length: pool }, (_, i) => worker(i + 1)));
  reference.judge = refRowScore();

  const { md, ranked } = buildTable(rows, refName, audio, {
    promptVersion: PROMPT_VERSION,
    judgeModel,
    starProvider,
    timingRefName,
  });
  return { md, ranked, rows };
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(HELP);
    process.exit(0);
  }

  const audio =
    args.audio || process.env.TRANSCRIBE_BENCH_AUDIO_LABEL || "cached fixture";
  const live = !!args.live;
  const audioUrl = args.audioUrl || null;
  const language = args.language || "ar";
  const judgeModel = args.judge || "gemini-pro-31-vision";
  const starProvider = args.star || "xai+gemini";
  const pool = Math.max(1, Math.min(8, parseInt(args.pool, 10) || 4));
  const totalRuns = Math.max(1, Math.min(20, parseInt(args.runs, 10) || 1));
  const requested = (
    typeof args.providers === "string"
      ? args.providers.split(",")
      : DEFAULT_PROVIDERS
  )
    .map((s) => String(s).trim())
    .filter(Boolean);
  const outFile = args.output || path.join("results", `bench_${Date.now()}.md`);

  // Validate --providers names early so a typo fails fast.
  const unknown = requested.filter((p) => !PROVIDERS_ALL.includes(p));
  if (unknown.length) {
    console.error(`ERROR unknown provider(s): ${unknown.join(", ")}`);
    console.error(`  known: ${PROVIDERS_ALL.join(", ")}`);
    process.exit(2);
  }

  if (live && !audioUrl) {
    console.error(
      "ERROR --live requires --audioUrl <fetchable URL of the audio>",
    );
    process.exit(2);
  }

  if (args.reference && !requested.includes(args.reference)) {
    console.error(
      `ERROR --reference "${args.reference}" is not in --providers list`,
    );
    console.error(`  pick one of: ${requested.join(", ")}`);
    process.exit(2);
  }

  console.error(
    `Loading ${requested.length} provider transcripts (cache: ${CACHE_DIR})...`,
  );
  const rows = [];
  for (const name of requested) {
    try {
      const r = await loadProvider(name, { live, audioUrl, language });
      rows.push(r);
      console.error(
        `  OK ${name.padEnd(14)} ${r.text.length} chars (${r.source})`,
      );
    } catch (e) {
      console.error(`  ERROR ${name.padEnd(14)} ${e.message}`);
    }
  }
  if (rows.length < 2) {
    console.error("ERROR need at least 2 providers to bench.");
    process.exit(2);
  }

  const refName = args.reference || autoPickReference(rows);
  const reference = rows.find((r) => r.name === refName);
  if (!reference) {
    console.error(`ERROR reference "${refName}" did not load successfully.`);
    process.exit(2);
  }
  console.error(`\nReference: ${refName}  (${reference.text.length} chars)`);
  console.error(
    `Judge model: ${judgeModel}  |  Prompt version: ${PROMPT_VERSION}`,
  );
  console.error(`Runs: ${totalRuns}\n`);

  fs.mkdirSync(path.dirname(outFile), { recursive: true });

  // For multi-run mode we need a snapshot of {row, judge, cues, timing, total}
  // per provider per run. Collect them as we go.
  const rowsPerRun = [];
  let lastSingleRunMd = null;

  for (let i = 0; i < totalRuns; i++) {
    const result = await runOnce({
      rows,
      refName,
      judgeModel,
      starProvider,
      pool,
      audio,
      runIdx: i,
      totalRuns,
    });
    // Capture the per-run ranked snapshot (deep snapshot of the dimensions
    // that vary between runs - judge changes; cues/timing are deterministic).
    rowsPerRun.push(
      result.ranked.map((r) => ({
        row: { name: r.row.name, srt: r.row.srt, source: r.row.source },
        judge: r.judge ? { ...r.judge } : null,
        cues: r.cues,
        timing: r.timing,
        total: r.total,
      })),
    );
    lastSingleRunMd = result.md;

    if (totalRuns > 1) {
      // Per-run snapshot file for transparency.
      const runFile = outFile.replace(/\.md$/, `.run${i + 1}.md`);
      fs.writeFileSync(runFile, result.md);
      console.error(`  wrote ${runFile}`);
    }
  }

  if (totalRuns === 1) {
    fs.writeFileSync(outFile, lastSingleRunMd);
    console.error(`\nWrote ${outFile}\n`);
    console.log(lastSingleRunMd);
    const top3 = rowsPerRun[0]
      .filter((r) => r.row.name !== refName)
      .slice(0, 3)
      .map((r) => `${r.row.name}=${r.total ?? "?"}`)
      .join(", ");
    console.error(`\nReference: ${refName}.  Top 3 by Total: ${top3}`);
  } else {
    const stabilityMd = buildStabilityReport(rowsPerRun, refName, {
      audioFile: audio,
      judgeModel,
      promptVersion: PROMPT_VERSION,
      starProvider,
    });
    fs.writeFileSync(outFile, stabilityMd);
    console.error(
      `\nWrote ${outFile} (stability report across ${totalRuns} runs)\n`,
    );
    console.log(stabilityMd);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
