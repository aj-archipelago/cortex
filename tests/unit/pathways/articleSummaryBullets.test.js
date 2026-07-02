import test from "ava";
import articleSummaryBullets from "../../../pathways/article_summary_bullets.js";

function createResolver() {
  return {
    errors: [],
    logError(message) {
      this.errors.push(message);
    },
  };
}

test("article_summary_bullets rejects prompts that duplicate the article text", async (t) => {
  const resolver = createResolver();

  const result = await articleSummaryBullets.executePathway({
    args: {
      text: "Article body",
      userPrompt: "Summarize this: {{text}}",
      count: 3,
    },
    runAllPrompts: async () => {
      throw new Error("runAllPrompts should not be called");
    },
    resolver,
  });

  t.is(result, null);
  t.regex(resolver.errors.join(" "), /\{\{text\}\}/);
});

test("article_summary_bullets accepts the expected JSON bullet shape", async (t) => {
  const resolver = createResolver();

  const result = await articleSummaryBullets.executePathway({
    args: {
      text: "Article body",
      count: 2,
    },
    runAllPrompts: async () => JSON.stringify({ bullets: ["One", "Two"] }),
    resolver,
  });

  t.is(result, JSON.stringify({ bullets: ["One", "Two"] }));
  t.deepEqual(resolver.errors, []);
  t.truthy(resolver.pathwayPrompt);
});

test("article_summary_bullets reports wrong-shape model output", async (t) => {
  const resolver = createResolver();

  const result = await articleSummaryBullets.executePathway({
    args: {
      text: "Article body",
      count: 3,
    },
    runAllPrompts: async () => JSON.stringify({ status: "ok" }),
    resolver,
  });

  t.is(result, null);
  t.regex(resolver.errors.join(" "), /bullets/);
});
