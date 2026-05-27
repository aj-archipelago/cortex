import test from "ava";
import fs from "node:fs";
import transcribeXai from "../../../pathways/transcribe_xai.js";
import transcribeXaiGemini from "../../../pathways/transcribe_xai_gemini.js";

test("transcribe_xai exposes the generic transcribe pathway shape", (t) => {
  t.is(transcribeXai.inputParameters.aiName, "Jarvis");
  t.is(transcribeXai.inputParameters.responseFormat, "text");
  t.is(transcribeXai.timeout, 3600);
  t.is(typeof transcribeXai.executePathway, "function");
});

test("transcribe_xai_gemini exposes the generic hybrid pathway shape", (t) => {
  t.is(transcribeXaiGemini.inputParameters.aiName, "Jarvis");
  t.is(transcribeXaiGemini.inputParameters.responseFormat, "text");
  t.is(transcribeXaiGemini.timeout, 3600);
  t.is(typeof transcribeXaiGemini.executePathway, "function");
});

test("xAI transcription pathways use package-relative imports", (t) => {
  const sources = [
    fs.readFileSync(new URL("../../../pathways/transcribe_xai.js", import.meta.url), "utf8"),
    fs.readFileSync(new URL("../../../pathways/transcribe_xai_gemini.js", import.meta.url), "utf8"),
  ];

  for (const source of sources) {
    t.false(source.includes("@aj-archipelago/cortex/"));
  }
});
