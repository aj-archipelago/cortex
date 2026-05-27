#!/usr/bin/env node
// Build an "elevenlabs+gemini" hybrid SRT with the same alignment and
// segmentation helpers used by the Cortex xAI+Gemini pathway.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import subvibe from "@aj-archipelago/subvibe";
import { alignWords } from "../../pathways/shared/transcribe_xai/alignment.js";
import {
  buildSegments,
  segmentsToCues,
} from "../../pathways/shared/transcribe_xai/segments.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "transcribe-bench-cache",
);
const CACHE = process.env.TRANSCRIBE_BENCH_CACHE_DIR || DEFAULT_CACHE_DIR;

function extractTextFromSrt(srt) {
  const out = [];
  for (const block of srt.split(/\r?\n\r?\n+/)) {
    const lines = block.split(/\r?\n/);
    const tIdx = lines.findIndex((l) => l.includes("-->"));
    if (tIdx < 0) continue;
    const text = lines
      .slice(tIdx + 1)
      .join(" ")
      .trim();
    if (text) out.push(text);
  }
  return out.join(" ");
}

const freshSrtPath = path.join(__dirname, "results/gemini_latest.srt");
let geminiText;
let textSource;
if (fs.existsSync(freshSrtPath)) {
  geminiText = extractTextFromSrt(fs.readFileSync(freshSrtPath, "utf8"));
  textSource = "fresh cortex gemini SRT";
} else {
  geminiText = fs.readFileSync(
    `${CACHE}/result_gemini_3_flash_chunked.txt`,
    "utf8",
  );
  textSource = "cached chunked gemini text";
}
const geminiWords = geminiText.split(/\s+/).filter(Boolean);
console.error(`Text source: ${textSource}`);

const elJson = JSON.parse(
  fs.readFileSync(`${CACHE}/result_elevenlabs_full.json`, "utf8"),
);
const elWords = elJson.words
  .filter((w) => (w.type || "word") === "word")
  .map((w) => ({ text: w.text || w.word, start: w.start, end: w.end }));

console.error(`Gemini words: ${geminiWords.length}`);
console.error(`EL words:     ${elWords.length}`);
console.error(`Audio dur:    ${elJson.audio_duration_secs}s`);
console.error("");
console.error("Aligning...");
const aligned = alignWords(geminiWords, elWords, elJson.audio_duration_secs);
const anchors = aligned.filter((w) => w.type === "anchor").length;
console.error(
  `Aligned: ${anchors}/${aligned.length} anchors (${((anchors / aligned.length) * 100).toFixed(1)}%)`,
);

const segs = buildSegments(aligned, {}, { trustGaps: false });
console.error(`Segments: ${segs.length} cues`);

const outPath = path.join(__dirname, "results/elevenlabs_gemini_latest.srt");
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, subvibe.build(segmentsToCues(segs), "srt"));
console.error(`Wrote ${outPath}`);
