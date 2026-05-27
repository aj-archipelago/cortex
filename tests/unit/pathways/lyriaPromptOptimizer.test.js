import test from "ava";
import lyriaPromptOptimizer from "../../../pathways/lyria_prompt_optimizer.js";

test("lyria prompt optimizer ignores empty input", async (t) => {
  const resolver = {
    pathway: {
      inputParameters: lyriaPromptOptimizer.inputParameters,
    },
  };

  const result = await lyriaPromptOptimizer.executePathway({
    args: { userPrompt: "", hasInputImages: false },
    resolver,
    runAllPrompts: async () => {
      t.fail("empty prompts should not be sent to the optimizer model");
    },
  });

  t.is(result, "");
  t.is(resolver.pathwayPrompt, undefined);
});

test("lyria prompt optimizer uses GPT 5.5 Instant deployment", (t) => {
  t.is(lyriaPromptOptimizer.model, "oai-gpt-chat-latest");
});

test("lyria prompt optimizer preserves supplied user intent", async (t) => {
  const resolver = {
    pathway: {
      inputParameters: lyriaPromptOptimizer.inputParameters,
    },
  };

  await lyriaPromptOptimizer.executePathway({
    args: {
      userPrompt: "tense synth intro with pulsing percussion",
      hasInputImages: true,
    },
    resolver,
    runAllPrompts: async (receivedArgs) => receivedArgs,
  });

  const prompt = resolver.pathwayPrompt[0];
  t.regex(prompt.messages[0].content, /provided image as visual inspiration/);
  t.is(prompt.messages[1].content, "tense synth intro with pulsing percussion");
});
