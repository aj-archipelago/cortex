// Each provider returns: { name, text, srt?, words?, source }
//   text   : full transcript string
//   srt    : raw SRT/VTT text (for cue + timing scoring) — optional
//   words  : optional word-level [{text,start,end}]
//   source : 'cached' | 'cached(latest)' | 'cached(legacy)' | 'live'
//
// Cached transcripts live in TRANSCRIBE_BENCH_CACHE_DIR, or in the
// repo-adjacent transcribe-bench-cache directory.
// Live providers (xai, gemini, whisper, xai+gemini) hit a local Cortex GraphQL
// endpoint at CORTEX_URL.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CACHE_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "..",
  "transcribe-bench-cache",
);
export const CACHE_DIR = process.env.TRANSCRIBE_BENCH_CACHE_DIR || DEFAULT_CACHE_DIR;
const GRAPHQL_URL = process.env.CORTEX_URL || "http://localhost:4000/graphql";

const LIVE_CACHE_DIR = path.join(__dirname, "results");

function readJson(rel) {
  const p = path.join(CACHE_DIR, rel);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`bad JSON in ${rel}: ${e.message}`);
  }
}
function readText(rel) {
  const p = path.join(CACHE_DIR, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
}

function srtToText(srt) {
  if (!srt) return "";
  const lines = [];
  for (const block of srt.split(/\r?\n\r?\n+/)) {
    const ls = block.split(/\r?\n/);
    // SRT block: index, timing, then 1+ text lines.
    const tIdx = ls.findIndex((l) => l.includes("-->"));
    if (tIdx < 0) continue;
    const text = ls
      .slice(tIdx + 1)
      .join(" ")
      .trim();
    if (text) lines.push(text);
  }
  return lines.join(" ").trim();
}

// ---- Cached external providers ----
// Each loader returns null if the cached file is missing — loadProvider
// surfaces that as a clear "no cached result" error rather than crashing.

function fromGeminiRaw() {
  // Prefer the CHUNKED text + SRT so the row is internally consistent.
  // The single-shot result_gemini_3_flash.json had catastrophic loops over
  // 46 min in one call — judging that text against a chunked SRT was a bug.
  const chunkedText = readText("result_gemini_3_flash_chunked.txt");
  const chunkedSrt = readText("result_gemini_3_flash_chunked.srt");
  if (chunkedText) {
    return {
      name: "gemini",
      text: chunkedText.trim(),
      srt: chunkedSrt,
      source: "cached",
    };
  }
  const j = readJson("result_gemini_3_flash.json");
  if (!j) return null;
  const parts = j?.candidates?.[0]?.content?.parts || [];
  const text = parts
    .map((p) => p.text || "")
    .join("")
    .trim();
  return {
    name: "gemini",
    text,
    srt: chunkedSrt,
    source: "cached(single-shot text)",
  };
}
function fromXaiRaw() {
  const j = readJson("result_xai_chunked.json");
  if (!j) return null;
  return {
    name: "xai",
    text: (j.text || "").trim(),
    words: (j.words || []).map((w) => ({
      text: w.text,
      start: w.start,
      end: w.end,
    })),
    srt: readText("result_xai.srt"),
    source: "cached",
  };
}
function fromElevenlabs() {
  const j = readJson("result_elevenlabs_full.json");
  if (!j) return null;
  return {
    name: "elevenlabs",
    text: (j.text || "").trim(),
    words: (j.words || [])
      .filter((w) => w.type === "word" || w.type === undefined)
      .map((w) => ({
        text: w.text || w.word || "",
        start: w.start,
        end: w.end,
      })),
    srt: readText("result_elevenlabs_full.srt"),
    source: "cached",
  };
}
function fromAssemblyAi() {
  const j = readJson("result_assemblyai.json");
  if (!j) return null;
  return {
    name: "assemblyai",
    text: (j.text || "").trim(),
    srt: readText("result_assemblyai.srt"),
    source: "cached",
  };
}
function fromDeepgram() {
  const j = readJson("result_deepgram.json");
  if (!j) return null;
  const alt = j?.results?.channels?.[0]?.alternatives?.[0] || {};
  return {
    name: "deepgram",
    text: (alt.transcript || "").trim(),
    srt: readText("result_deepgram.srt"),
    source: "cached",
  };
}
function fromCohere() {
  const j = readJson("result_cohere_v2.json");
  if (!j) return null;
  return { name: "cohere", text: (j.text || "").trim(), source: "cached" };
}
function fromSpeechmatics() {
  const text = readText("result_speechmatics.txt");
  if (!text) return null;
  return {
    name: "speechmatics",
    text: text.trim(),
    srt: readText("result_speechmatics.srt"),
    source: "cached",
  };
}
function fromTrint() {
  const text = readText("result_trint.txt");
  if (!text) return null;
  return { name: "trint", text: text.trim(), source: "cached" };
}
function fromMai() {
  const text = readText("result_mai.txt");
  if (!text) return null;
  return {
    name: "mai",
    text: text.trim(),
    srt: readText("result_mai.srt"),
    source: "cached",
  };
}
function fromWhisper3() {
  // OpenAI Whisper-3 cached output stands in for the UI's default Whisper
  // when a fresh --live run isn't available.
  const text = readText("result_whisper3.txt");
  if (!text) return null;
  return { name: "whisper", text: text.trim(), source: "cached" };
}
function fromVibeVoice() {
  const j = readJson("result_vibevoice.json");
  const text = (j?.text || readText("result_vibevoice.txt") || "").trim();
  if (!text) return null;
  return {
    name: "vibevoice",
    text,
    srt: readText("result_vibevoice.srt"),
    source: "cached",
  };
}
function fromHiggs() {
  const j = readJson("result_higgs.json");
  const text = (j?.text || readText("result_higgs.txt") || "").trim();
  if (!text) return null;
  return {
    name: "higgs",
    text,
    srt: readText("result_higgs.srt"),
    source: "cached",
  };
}

// ---- Live cortex callers ----

async function callCortex(query, variables, timeoutMs = 1800000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(GRAPHQL_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: ctrl.signal,
    });
    const j = await r.json();
    if (j.errors) throw new Error(JSON.stringify(j.errors));
    return j.data;
  } finally {
    clearTimeout(t);
  }
}

async function liveTranscribe(pathway, file, language) {
  const q = `query Q($file: String!, $language: String, $responseFormat: String) {
        ${pathway}(file: $file, language: $language, responseFormat: $responseFormat) { result }
    }`;
  const data = await callCortex(q, {
    file,
    language: language || null,
    responseFormat: "srt",
  });
  return data?.[pathway]?.result || "";
}

function cacheLiveSrt(slug, srt) {
  if (!srt) return;
  fs.mkdirSync(LIVE_CACHE_DIR, { recursive: true });
  const safe = slug.replace(/[^a-z0-9]+/gi, "_");
  fs.writeFileSync(path.join(LIVE_CACHE_DIR, `${safe}_latest.srt`), srt);
}

// Single parameterized live caller — was 4 nearly-identical functions.
function makeLive(displayName, pathwayName, slug) {
  return async (audioUrl, language) => {
    const srt = await liveTranscribe(pathwayName, audioUrl, language);
    cacheLiveSrt(slug, srt);
    return { name: displayName, text: srtToText(srt), srt, source: "live" };
  };
}

// Hybrid built by build_el_gemini.mjs: Gemini text + EL real timestamps,
// aligned with the same n-gram cascade as xai+gemini. Experimental.
function fromElGeminiHybrid() {
  const p = path.join(LIVE_CACHE_DIR, "elevenlabs_gemini_latest.srt");
  if (!fs.existsSync(p)) return null;
  const srt = fs.readFileSync(p, "utf8");
  return {
    name: "el+gemini",
    text: srtToText(srt),
    srt,
    source: "hybrid(EL ts + Gemini text)",
  };
}

// Loader for xai+gemini that prefers the most recent live SRT cached
// in results/, falling back to the older python-prototype output with a
// transparent source label so the user can tell what they're scoring.
function fromOurXaiGeminiCached() {
  const fresh = path.join(LIVE_CACHE_DIR, "xai_gemini_latest.srt");
  if (fs.existsSync(fresh)) {
    const srt = fs.readFileSync(fresh, "utf8");
    return {
      name: "xai+gemini",
      text: srtToText(srt),
      srt,
      source: "cached(latest)",
    };
  }
  const legacy =
    readText("best_srts/BEST_xai_gemini.srt") ||
    readText("result_combined_gemini_xai.srt");
  if (legacy) {
    return {
      name: "xai+gemini",
      text: srtToText(legacy),
      srt: legacy,
      source: "cached(legacy — pass --live for SOTA)",
    };
  }
  return null;
}

// Same idea for other live-produced pathways: prefer fresh cached SRT
// from a previous --live run, fall back to whatever is in the cache directory.
function liveCachedSrtFor(slug) {
  const fresh = path.join(LIVE_CACHE_DIR, `${slug}_latest.srt`);
  if (fs.existsSync(fresh)) return fs.readFileSync(fresh, "utf8");
  return null;
}

// ---- Registry ----

export const cachedLoaders = {
  "xai+gemini": fromOurXaiGeminiCached,
  "el+gemini": fromElGeminiHybrid,
  xai: () => {
    const live = liveCachedSrtFor("xai");
    if (live) {
      return {
        name: "xai",
        text: srtToText(live),
        srt: live,
        source: "cached(latest)",
      };
    }
    return fromXaiRaw();
  },
  gemini: () => {
    const live = liveCachedSrtFor("gemini");
    if (live) {
      return {
        name: "gemini",
        text: srtToText(live),
        srt: live,
        source: "cached(latest)",
      };
    }
    return fromGeminiRaw();
  },
  whisper: () => {
    const live = liveCachedSrtFor("whisper");
    if (live) {
      return {
        name: "whisper",
        text: srtToText(live),
        srt: live,
        source: "cached(latest)",
      };
    }
    return fromWhisper3();
  },
  elevenlabs: fromElevenlabs,
  assemblyai: fromAssemblyAi,
  deepgram: fromDeepgram,
  cohere: fromCohere,
  speechmatics: fromSpeechmatics,
  mai: fromMai,
  trint: fromTrint,
  vibevoice: fromVibeVoice,
  higgs: fromHiggs,
};

export const liveLoaders = {
  "xai+gemini": makeLive("xai+gemini", "transcribe_xai_gemini", "xai_gemini"),
  xai: makeLive("xai", "transcribe_xai", "xai"),
  gemini: makeLive("gemini", "transcribe_gemini", "gemini"),
  whisper: makeLive("whisper", "transcribe", "whisper"),
};

export const PROVIDERS_ALL = Object.keys(cachedLoaders);

export async function loadProvider(
  name,
  { live = false, audioUrl, language } = {},
) {
  if (live && liveLoaders[name]) {
    try {
      const r = await liveLoaders[name](audioUrl, language);
      // 50 chars is a low bar — anything below means cortex returned
      // empty/error content rather than a real transcript.
      if (r && r.text && r.text.length > 50) return r;
      console.error(
        `[providers] live ${name} returned empty/short result; falling back to cache`,
      );
    } catch (e) {
      console.error(
        `[providers] live ${name} failed: ${e.message}; falling back to cache`,
      );
    }
  }
  const loader = cachedLoaders[name];
  if (!loader) throw new Error(`unknown provider: ${name}`);
  const r = loader();
  if (!r || !r.text)
    throw new Error(`no cached result for ${name} (looked under ${CACHE_DIR})`);
  return r;
}
