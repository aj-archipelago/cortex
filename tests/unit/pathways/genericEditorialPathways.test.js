import test from "ava";
import azureVideoTranslate from "../../../pathways/azure_video_translate.js";
import internalLinkKeywords from "../../../pathways/internal_link_keywords.js";
import seoAnalyzer from "../../../pathways/seo_analyzer.js";
import styleguideHtml from "../../../pathways/styleguide/styleguide_html.js";

test("azure_video_translate exposes the Azure video translation parameter surface", (t) => {
  t.is(azureVideoTranslate.model, "azure-video-translate");
  t.false(azureVideoTranslate.enableDuplicateRequests);
  t.false(azureVideoTranslate.enableCache);
  t.is(azureVideoTranslate.timeout, 60 * 60);

  for (const key of [
    "mode",
    "region",
    "subscriptionkey",
    "sourcelocale",
    "targetlocale",
    "videooraudiofileid",
    "sourcevideooraudiofilepath",
    "targetlocalewebvttfilepath",
  ]) {
    t.true(key in azureVideoTranslate.inputParameters);
  }
});

test("internal_link_keywords is a chunked list pathway for exact-match keywords", (t) => {
  t.true(internalLinkKeywords.list);
  t.true(internalLinkKeywords.useInputChunking);
  t.true(internalLinkKeywords.useParallelChunkProcessing);
  t.is(internalLinkKeywords.inputChunkSize, 2000);
  t.regex(internalLinkKeywords.prompt, /maximum 3 words/);
  t.regex(internalLinkKeywords.prompt, /appear as exact matches/);
});

test("seo_analyzer returns structured semantic SEO JSON guidance", (t) => {
  t.true(seoAnalyzer.json);
  t.is(seoAnalyzer.model, "oai-gpt4o");
  t.regex(seoAnalyzer.prompt, /semantic SEO/);
  t.regex(seoAnalyzer.prompt, /keyword density optimization/);
  t.regex(seoAnalyzer.prompt, /"keyphrases"/);
  t.regex(seoAnalyzer.prompt, /"contentSuggestions"/);
});

test("styleguide_html applies supplied corrected text with the HTML prompt only", async (t) => {
  const originalPrompts = styleguideHtml.prompt;
  const resolver = { pathwayPrompt: [...originalPrompts] };
  const calls = [];

  const result = await styleguideHtml.executePathway({
    args: {
      text: "<p>They lost 20%.</p>",
      correctedText: "They lost 20 percent.",
    },
    resolver,
    runAllPrompts: async (args) => {
      calls.push({ args, promptCount: resolver.pathwayPrompt.length });
      return "<p>They lost 20 percent.</p>";
    },
  });

  t.is(result, "<p>They lost 20 percent.</p>");
  t.is(calls.length, 1);
  t.is(calls[0].promptCount, 1);
  t.deepEqual(calls[0].args, {
    originalHtml: "<p>They lost 20%.</p>",
    correctedText: "They lost 20 percent.",
  });
  t.deepEqual(resolver.pathwayPrompt, originalPrompts);
});

test("styleguide_html extracts plain text before running the full prompt chain", async (t) => {
  const calls = [];

  const result = await styleguideHtml.executePathway({
    args: {
      text: "<article><h1>March story</h1><p>They lost 20%.</p><script>ignore()</script></article>",
    },
    resolver: { pathwayPrompt: [...styleguideHtml.prompt] },
    runAllPrompts: async (args) => {
      calls.push(args);
      return "<article><h1>March story</h1><p>They lost 20 percent.</p></article>";
    },
  });

  t.is(result, "<article><h1>March story</h1><p>They lost 20 percent.</p></article>");
  t.is(calls.length, 1);
  t.is(calls[0].originalHtml, "<article><h1>March story</h1><p>They lost 20%.</p><script>ignore()</script></article>");
  t.regex(calls[0].plainText, /March story/);
  t.regex(calls[0].plainText, /They lost 20%\./);
  t.notRegex(calls[0].plainText, /ignore/);
});
