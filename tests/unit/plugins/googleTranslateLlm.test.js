import test from "ava";
import GoogleTranslatePlugin from "../../../server/plugins/googleTranslatePlugin.js";
import { ModelExecutor } from "../../../server/modelExecutor.js";

process.env.GCP_SERVICE_ACCOUNT_KEY ||= JSON.stringify({
  project_id: "service-account-project",
});

const pathway = {
  name: "translate_google_llm",
  prompt: "{{{text}}}",
  inputParameters: {
    from: "auto",
    to: "en",
  },
};

const prompt = { prompt: pathway.prompt };

const model = {
  name: "google-translate-llm",
  type: "GOOGLE-TRANSLATE",
  params: {
    translationModel: "general/translation-llm",
    mimeType: "text/plain",
  },
};

function createPlugin(overrides = {}) {
  return new GoogleTranslatePlugin(pathway, { ...model, ...overrides });
}

test("translate_google_llm pathway selects the Google translation plugin", async (t) => {
  const { default: translateGoogleLlm } = await import(
    "../../../pathways/translate_google_llm.js"
  );
  const executor = new ModelExecutor(translateGoogleLlm, model);

  t.is(translateGoogleLlm.model, "google-translate-llm");
  t.is(executor.plugin.constructor.name, "GoogleTranslatePlugin");
});

test("Google TranslateLLM request parameters use the Vertex translation model", (t) => {
  const plugin = createPlugin();
  const request = plugin.getRequestParameters(
    "Hello",
    { to: "zh", from: "auto" },
    prompt,
  );

  t.deepEqual(request.data.q, ["Hello"]);
  t.is(request.data.target, "zh-CN");
  t.is(request.data.source, undefined);
  t.is(request.data.model, plugin.getTranslationModelPath());
  t.is(request.data.mimeType, "text/plain");
  t.is(request.params.key, undefined);

  const error = t.throws(
    () => plugin.getRequestParameters("", { to: "fr" }, prompt),
    { instanceOf: Error },
  );
  t.regex(error.message, /non-empty text/);
});
