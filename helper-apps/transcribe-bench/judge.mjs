// LLM-as-judge: scores a candidate transcript against the reference using
// cortex's sys_generator_quick (chatHistory mode). Returns a structured rubric
// on a /100 scale plus strengths/weaknesses for the per-provider report.
//
// PROMPT_VERSION is embedded in the bench output so future tunings of the
// rubric don't silently make old reports incomparable with new ones.

export const PROMPT_VERSION = "2026-04-23.v3";

const GRAPHQL_URL = process.env.CORTEX_URL || "http://localhost:4000/graphql";

// Window sampling: cap input size so the prompt fits inside even
// modest-context judge models. 3 windows (head/middle/tail) so the judge
// observes the whole audio's trajectory, not just the opening.
//
// Uses Arabic-first markers when the candidate or reference is Arabic so we
// don't inject obvious English signals into otherwise Arabic content.
function sampleWindows(text, perWindowChars = 4000) {
  const t = (text || "").trim();
  if (t.length <= perWindowChars * 3) return t;
  const head = t.slice(0, perWindowChars);
  const midStart = Math.floor((t.length - perWindowChars) / 2);
  const mid = t.slice(midStart, midStart + perWindowChars);
  const tail = t.slice(t.length - perWindowChars);
  // Neutral marker (square brackets, no language commitment)
  return `${head}\n[...mid...]\n${mid}\n[...end...]\n${tail}`;
}

const RUBRIC_PROMPT = `You are evaluating an Automatic Speech Recognition (ASR) transcript against a reference.

REFERENCE (presumed best available):
"""
{{REF}}
"""

CANDIDATE (provider: {{NAME}}):
"""
{{CAND}}
"""

Score the candidate strictly on these dimensions, integer 0-100 each.
USE THE FULL RANGE. Distinguish meaningful differences (e.g. 67 vs 72 vs 78
vs 84). Do NOT snap to multiples of 10 — the goal is to differentiate
candidates of similar but not identical quality.

Calibration anchors:
  100 = perfect, indistinguishable from a careful human transcription
   90 = excellent, only trivial flaws (one or two minor word errors)
   80 = strong, several small errors but content is correct
   70 = good, occasional notable errors but the gist is preserved
   60 = mediocre, multiple significant errors, but usable
   50 = weak, major errors that obscure parts of the content
   40 = poor, substantial wrong content / hallucinations
   25 = very poor, mostly unusable
    0 = useless / unrelated

Dimensions:

1. coverage  — how much of the reference's content/topics appear in the candidate
2. accuracy  — correctness of named entities, places, numbers, key terms
3. readability — punctuation, sentence structure, fluency (independent of correctness)
4. faithfulness — penalize hallucinations, language drift (e.g. romanized noise in
                  Arabic audio), looping, or invented content

Then give an "overall" (0-100) that weighs accuracy + faithfulness highest.

Also produce:
  - "note":       <= 25 words, the single most distinctive trait of this candidate
  - "strengths":  1-2 concrete sentences on what this provider does well, with a
                  quoted example phrase from the transcript when possible
  - "weaknesses": 1-2 concrete sentences on what specifically caused score drops
                  (looping, wrong entity, missing punctuation, dropped section,
                  language drift, etc.) with a quoted example when possible

Respond with ONLY a JSON object, no markdown, no commentary, no leading text:
{"coverage": int, "accuracy": int, "readability": int, "faithfulness": int,
 "overall": int, "note": "...", "strengths": "...", "weaknesses": "..."}`;

function buildPrompt(name, refText, candText) {
  return RUBRIC_PROMPT.replace("{{REF}}", sampleWindows(refText))
    .replace("{{NAME}}", name)
    .replace("{{CAND}}", sampleWindows(candText));
}

class JudgeError extends Error {
  constructor(message, kind = "unknown", raw = "") {
    super(message);
    this.kind = kind; // 'network' | 'timeout' | 'graphql' | 'parse' | 'unknown'
    this.raw = raw;
  }
}

async function callJudge(model, promptText, timeoutMs = 120000) {
  const q = `query Q($chatHistory: [MultiMessage], $model: String) {
        sys_generator_quick(chatHistory: $chatHistory, model: $model) { result }
    }`;
  const body = JSON.stringify({
    query: q,
    variables: {
      chatHistory: [{ role: "user", content: [promptText] }],
      model,
    },
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    let r;
    try {
      r = await fetch(GRAPHQL_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal: ctrl.signal,
      });
    } catch (e) {
      const kind = e.name === "AbortError" ? "timeout" : "network";
      throw new JudgeError(e.message, kind);
    }
    let j;
    try {
      j = await r.json();
    } catch (e) {
      throw new JudgeError("non-JSON response from cortex", "graphql");
    }
    if (j.errors) {
      throw new JudgeError(
        "graphql error: " + JSON.stringify(j.errors).slice(0, 200),
        "graphql",
      );
    }
    return j?.data?.sys_generator_quick?.result || "";
  } finally {
    clearTimeout(timer);
  }
}

// Parse the LLM's JSON output. Distinguishes between "no output" and "output
// but invalid"; preserves the raw text on failure for diagnostic logging.
function parseScore(raw) {
  if (!raw) return { ok: false, reason: "empty" };
  const cleaned = raw.replace(/```json\s*|\s*```/g, "").trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, reason: "no-json-object", raw };
  let o;
  try {
    o = JSON.parse(m[0]);
  } catch (e) {
    return { ok: false, reason: "json-syntax: " + e.message, raw };
  }
  const numFields = [
    "coverage",
    "accuracy",
    "readability",
    "faithfulness",
    "overall",
  ];
  for (const f of numFields) {
    const v = Number(o[f]);
    // Distinguish a legitimate 0 from a missing/invalid field. Invalid
    // values are flagged so the retry loop can decide whether to re-ask.
    if (!Number.isFinite(v))
      return { ok: false, reason: `invalid number: ${f}=${o[f]}`, raw };
    if (v < 0 || v > 100)
      return { ok: false, reason: `out-of-range: ${f}=${v}`, raw };
    o[f] = Math.round(v);
  }
  for (const s of ["note", "strengths", "weaknesses"]) {
    if (typeof o[s] !== "string") o[s] = "";
  }
  return { ok: true, value: o };
}

function jitterMs(baseMs) {
  // ±20% jitter prevents parallel workers from retrying in lockstep.
  return baseMs + Math.floor((Math.random() - 0.5) * baseMs * 0.4);
}

export async function judgeAgainst(
  reference,
  candidate,
  { model = "gemini-pro-31-vision", maxAttempts = 3 } = {},
) {
  const prompt = buildPrompt(candidate.name, reference.text, candidate.text);
  let lastErr = null,
    lastRaw = "";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const raw = await callJudge(model, prompt);
      lastRaw = raw;
      const parsed = parseScore(raw);
      if (parsed.ok) return parsed.value;
      lastErr = new JudgeError("parse failed: " + parsed.reason, "parse", raw);
    } catch (e) {
      lastErr = e;
    }
    // Backoff longer for rate-limit-shaped failures, shorter for parse retries
    const baseMs = lastErr?.kind === "parse" ? 200 : 1000 * (attempt + 1);
    await new Promise((res) => setTimeout(res, jitterMs(baseMs)));
  }
  return {
    coverage: 0,
    accuracy: 0,
    readability: 0,
    faithfulness: 0,
    overall: 0,
    note: `judge failed: ${lastErr?.kind || "unknown"} — ${String(lastErr?.message || "").slice(0, 100)}`,
    strengths: "",
    weaknesses: lastRaw
      ? `(judge produced unparseable output: ${lastRaw.slice(0, 80)}…)`
      : "",
  };
}

export function refRowScore() {
  // Reference is not judged against itself. Sentinel = top of /100 scale.
  return {
    coverage: 100,
    accuracy: 100,
    readability: null,
    faithfulness: 100,
    overall: null,
    note: "(reference)",
    strengths: "Used as the ground-truth anchor for this run.",
    weaknesses: "",
  };
}
