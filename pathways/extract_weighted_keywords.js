import { Prompt } from '../server/prompt.js';

const FORMAT_INSTRUCTIONS = `Return your response as a JSON array of exactly 9 objects with this exact structure:
[{"keyword": "example keyword", "weight": 0.85}, {"keyword": "another term", "weight": 0.72}, ...]

Rules:
- weight is a float between 0.0 and 1.0 representing combined relevance + specificity
- Generic words score lower even if relevant; specific names, places, and roles score higher
- Independent scores — weights do NOT sum to 1.0
- Sort the array by weight descending (highest weight first)
- Output ONLY the JSON array, no other text, no markdown fences, no preamble`;

const DEFAULT_CONTENT_GUIDANCE = `You are a visual media researcher.
Your task is to extract keywords for finding wire photographs in image databases.
Always return keywords in English, regardless of the article's language. Image database providers accept English terms only.
Each keyword must be 1-2 words maximum (e.g. 'Trump', 'Trump Iran'). Never use 3+ word phrases.
Focus on visually searchable terms: people (full names or roles), geographic places, specific events, objects, and organisations.
Prefer specific terms over generic ones — "Gaza hospital" is better than "conflict", "António Guterres" is better than "UN official".

Example 1 — Input article excerpt:
"President Joe Biden signed the $1.2 trillion infrastructure bill at the White House, flanked by senators from both parties."
Example 1 — Output:
[{"keyword": "Joe Biden", "weight": 0.95}, {"keyword": "White House", "weight": 0.88}, {"keyword": "infrastructure bill", "weight": 0.82}, {"keyword": "US Senate", "weight": 0.70}, {"keyword": "Washington DC", "weight": 0.65}, {"keyword": "bipartisan", "weight": 0.58}, {"keyword": "infrastructure", "weight": 0.52}, {"keyword": "Biden signing", "weight": 0.45}, {"keyword": "Capitol Hill", "weight": 0.40}]

Example 2 — Input article excerpt:
"Rescue teams from Turkey and Greece worked together after the 7.8 magnitude earthquake struck southern Turkey, killing hundreds in Kahramanmaraş."
Example 2 — Output:
[{"keyword": "Kahramanmaraş", "weight": 0.96}, {"keyword": "Turkey earthquake", "weight": 0.91}, {"keyword": "earthquake survivors", "weight": 0.85}, {"keyword": "rescue teams", "weight": 0.78}, {"keyword": "Turkey Greece", "weight": 0.72}, {"keyword": "earthquake rubble", "weight": 0.65}, {"keyword": "southern Turkey", "weight": 0.60}, {"keyword": "disaster relief", "weight": 0.52}, {"keyword": "search rescue", "weight": 0.45}]`;

const keywordsTypeDef = (pathway) => {
    const { name, objName } = pathway;

    const customType = `type KeywordResult {
  keyword: String
  weight: Float
}`;

    const responseType = `type ${objName} {
  debug: String
  result: [KeywordResult]
  resultData: String
  previousResult: String
  warnings: [String]
  errors: [String]
  contextId: String
  tool: String
}`;

    const paramsStr = `text: String = "", userPrompt: String = ""`;
    const gqlDefinition = `${customType}\n\n${responseType}\n\nextend type Query { ${name}(${paramsStr}): ${objName} }`;

    return {
        gqlDefinition,
        restDefinition: [
            { name: 'text', type: 'String' },
            { name: 'userPrompt', type: 'String' },
        ],
    };
};

export default {
    inputParameters: {
        text: '',
        userPrompt: '',
    },

    prompt: [],

    typeDef: keywordsTypeDef,

    parser: (responseText) => {
        try {
            const fenceMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
            const jsonStr = fenceMatch ? fenceMatch[1].trim() : responseText.trim();

            const parsed = JSON.parse(jsonStr);
            const arr = Array.isArray(parsed) ? parsed : (parsed.keywords || []);

            return arr
                .filter(item => item && typeof item.keyword === 'string' && item.keyword.length > 0)
                .map(item => {
                    const rawWeight = typeof item.weight === 'number' ? item.weight : parseFloat(item.weight) || 0;
                    return {
                        keyword: item.keyword,
                        weight: Math.max(0, Math.min(1, rawWeight)),
                    };
                })
                .sort((a, b) => b.weight - a.weight);
        } catch (error) {
            return [];
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const contentGuidance = args.userPrompt || DEFAULT_CONTENT_GUIDANCE;
        const systemContent = `${contentGuidance}\n\n${FORMAT_INSTRUCTIONS}`;

        resolver.pathwayPrompt = [
            new Prompt({
                messages: [
                    { role: 'system', content: systemContent },
                    { role: 'user', content: '{{{text}}}' },
                ],
            }),
        ];

        const result = await runAllPrompts({ ...args });

        if (!result || (Array.isArray(result) && result.length === 0)) {
            throw new Error('Keywords pathway: no valid keywords could be extracted from the AI response');
        }

        return result;
    },
};
