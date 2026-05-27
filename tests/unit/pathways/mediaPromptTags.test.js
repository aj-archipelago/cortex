import test from "ava";
import mediaPromptTags from "../../../pathways/media_prompt_tags.js";

test("media prompt tags uses an upstream configured default model", (t) => {
  t.is(mediaPromptTags.inputParameters.model, "oai-gpt4o");
});

test("media prompt tags requests concise JSON tag arrays", (t) => {
  t.true(mediaPromptTags.json);
  t.is(mediaPromptTags.temperature, 0);

  const [systemMessage, userMessage] = mediaPromptTags.prompt[0].messages;
  t.regex(systemMessage.content, /valid JSON array/);
  t.regex(systemMessage.content, /3 to 8 strings/);
  t.regex(systemMessage.content, /Tags must be lowercase/);
  t.regex(userMessage.content, /Prompt:/);
});
