import test from "ava";
import grammar from "../../../pathways/grammar.js";
import taxonomy, {
  getFilteredTaxonomyItems,
} from "../../../pathways/taxonomy.js";

test("grammar exposes runtime override parameters while keeping default HTML editing behavior", (t) => {
  t.is(grammar.model, "oai-gpt4o");
  t.is(grammar.inputFormat, "html");
  t.true(grammar.useInputChunking);
  t.is(grammar.inputChunkSize, 1000);
  t.is(typeof grammar.resolver, "function");
  t.is(grammar.inputParameters.userPrompt, "");
  t.is(grammar.inputParameters.reasoningEffort, "none");
  t.false(grammar.inputParameters.json);
  t.true(grammar.inputParameters.useInputChunking);

  const systemPrompt = grammar.prompt[0].messages[0].content;
  t.regex(systemPrompt, /preserve HTML markup/);
  t.regex(systemPrompt, /WordPress shortcodes/);
  t.regex(systemPrompt, /Do not incorrectly change ى to ي or vice versa/);
});

test("taxonomy filters model output back to verbatim taxonomy items", (t) => {
  const result = getFilteredTaxonomyItems(
    ["climate", "Economy.", "not in list"],
    "Climate, Economy, Politics",
  );

  t.deepEqual(result, ["Climate", "Economy"]);
});

test("taxonomy exposes configurable prompt templates and model selection", (t) => {
  t.is(taxonomy.inputParameters.model, "oai-gpt4o");
  t.is(taxonomy.inputParameters.initialFilterPrompt, "");
  t.is(taxonomy.inputParameters.singleSelectPrompt, "");
  t.is(taxonomy.inputParameters.rankingPrompt, "");
  t.is(taxonomy.inputParameters.taxonomyType, "topic");
  t.is(taxonomy.timeout, 240);
  t.true(taxonomy.list);
  t.is(typeof taxonomy.resolver, "function");
});
