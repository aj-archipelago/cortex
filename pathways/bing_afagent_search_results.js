// bing_afagent_search_results.js
// Bing hosted-agent search pathway tuned for structured search-tool output.

export default {
    prompt: [`Search query: {{text}}
Freshness preference: {{freshness}}
Market preference: {{market}}
Language preference: {{set_lang}}

Return up to {{count}} distinct web results as JSON only.

Output schema:
{
  "results": [
    {
      "title": "Result title",
      "url": "https://example.com/page",
      "content": "Short result snippet or summary"
    }
  ]
}

Rules:
- Use Bing search before answering.
- Prefer authoritative, current, and directly relevant sources.
- Include direct source URLs.
- Do not include markdown, prose, code fences, or fields outside the JSON schema.`],
    inputParameters: {
        text: '',
        count: 10,
        freshness: 'week',
        market: 'en-us',
        set_lang: 'en',
    },
    timeout: 400,
    model: 'azure-bing-agent-responses',
    useInputChunking: false,
    instructions: `You are a Bing search agent that returns structured search results.

Return JSON only. The top-level object must contain a "results" array. Each result must include "title", "url", and "content". Do not add analysis, explanations, markdown, or prose outside the JSON object.`,
};
