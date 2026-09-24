// A small service-swap comparison. Supply already-prepared HTTP(S) audio URLs;
// common upload/chunk preparation is deliberately outside the service timer.
import fs from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { load } from "cheerio";
import { predictTranscription, REPLICATE_TRANSCRIPTION_MODELS } from "../../pathways/shared/transcribe_replicate/client.js";
import { normalizeReplicateOutput, formatReplicateTranscript } from "../../pathways/shared/transcribe_replicate/format.js";

const SRT_TIMING = /^\s*\d{2,}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2,}:\d{2}:\d{2}[,.]\d{3}\s*$/;

export function summarizeSrt(srt) {
  const cues = srt.split(/\r?\n\s*\r?\n/).flatMap(block => {
    const lines = block.split(/\r?\n/);
    const timing = lines.findIndex(line => SRT_TIMING.test(line));
    return timing < 0 ? [] : [lines.slice(timing + 1).join(" ")];
  });
  return { text: load(cues.join(" "), null, false).root().text().trim(), cues: cues.length };
}

function tokens(text) {
  return text.toLowerCase().normalize("NFKC").replace(/[\u064b-\u065f\u0670\u0640]/g, "")
    .replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}

export function wordErrorRate(reference, candidate) {
  const a = tokens(reference), b = tokens(candidate);
  if (!a.length) return null;
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length] / a.length;
}

export async function runServiceComparison(fixtures, {
  outputDir, rounds = 2, azureUrl = process.env.WHISPER_TS_API_URL,
} = {}) {
  if (!azureUrl) throw new Error("WHISPER_TS_API_URL is required");
  if (!outputDir) throw new Error("outputDir is required");
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 3) throw new Error("Use 1–3 rounds for this directional benchmark");
  for (const fixture of fixtures) {
    if (!/^[a-zA-Z0-9_-]+$/.test(fixture.name) || !Number.isFinite(fixture.durationSeconds) || fixture.durationSeconds <= 0) {
      throw new Error("Fixtures need a simple basename and positive durationSeconds");
    }
  }
  await fs.mkdir(outputDir, { recursive: true });
  const rows = [];
  for (const fixture of fixtures) {
    for (let round = 1; round <= rounds; round++) {
      const providers = round % 2 ? ["azure", "whisper", "whisperx"] : ["whisperx", "whisper", "azure"];
      for (const provider of providers) {
        const row = { fixture: fixture.name, durationSeconds: fixture.durationSeconds, language: fixture.language, round, provider };
        const start = performance.now();
        let srt, text;
        try {
          if (provider === "azure") {
            const response = await fetch(azureUrl, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ fileurl: fixture.url, language: fixture.language, word_timestamps: "True", deadline: Date.now() / 1000 + 240 }),
              signal: AbortSignal.timeout(250000),
            });
            row.httpStatus = response.status;
            if (!response.ok) throw new Error(`Azure HTTP ${response.status}`);
            srt = await response.json();
            if (typeof srt !== "string") throw new Error("Azure returned no subtitle cues");
            const summary = summarizeSrt(srt);
            if (!summary.cues) throw new Error("Azure returned no subtitle cues");
            text = summary.text;
          } else {
            const output = await predictTranscription(provider, fixture.url, { language: fixture.language }, {
              onPrediction: prediction => {
                row.predictionId = prediction.id;
                row.version = prediction.version;
                row.predictSeconds = prediction.metrics?.predict_time;
                row.providerTotalSeconds = prediction.metrics?.total_time;
              },
            });
            const normalized = normalizeReplicateOutput(output);
            srt = formatReplicateTranscript([normalized], { responseFormat: "srt" });
            text = normalized.text;
            row.wordCount = normalized.segments.flatMap(s => s.words).length;
            row.untimedWords = normalized.segments.flatMap(s => s.words).filter(w => w.start == null).length;
            row.segmentCount = normalized.segments.length;
            // Inspect all response formats using the SAME prediction (no extra billable calls).
            row.vtt = formatReplicateTranscript([normalized], { responseFormat: "vtt" }).startsWith("WEBVTT");
            if (provider === "whisperx") {
              try {
                const wordVtt = formatReplicateTranscript([normalized], { responseFormat: "vtt", wordTimestamped: true });
                row.wordVtt = wordVtt.includes("-->");
                await fs.writeFile(`${outputDir}/${fixture.name}-${round}-${provider}-words.vtt`, wordVtt);
              } catch (error) { row.wordVtt = false; row.wordVttError = error.message; }
            }
            await fs.writeFile(`${outputDir}/${fixture.name}-${round}-${provider}-output.json`, JSON.stringify(normalized, null, 2));
          }
          row.wallSeconds = (performance.now() - start) / 1000;
          row.audioSecondsPerWallSecond = fixture.durationSeconds / row.wallSeconds;
          row.status = "succeeded";
          row.text = text;
          row.cues = summarizeSrt(srt).cues;
          row.wer = fixture.reference ? wordErrorRate(fixture.reference, text) : null;
          await fs.writeFile(`${outputDir}/${fixture.name}-${round}-${provider}.srt`, srt);
        } catch (error) {
          row.wallSeconds = (performance.now() - start) / 1000;
          row.status = "failed";
          row.error = error.message;
        }
        rows.push(row);
        // No audio URLs, credentials, or raw prediction objects in artifacts.
        await fs.writeFile(`${outputDir}/results.json`, JSON.stringify({ at: new Date().toISOString(), models: REPLICATE_TRANSCRIPTION_MODELS, rows }, null, 2));
        console.log(JSON.stringify({ ...row, text: undefined }));
      }
    }
  }
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [manifest, outputDir] = process.argv.slice(2);
  if (!manifest || !outputDir) throw new Error("Usage: node replicate-swap.mjs PUBLIC_URL_FIXTURES.json OUTPUT_DIR");
  await runServiceComparison(JSON.parse(await fs.readFile(manifest, "utf8")), { outputDir });
}
