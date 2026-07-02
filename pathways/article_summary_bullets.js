// pathways/article_summary_bullets.js
//
// Language-agnostic article summariser. The WordPress caller supplies the prompt
// (userPrompt) and model; this pathway is a thin A2-style wrapper. One LLM call,
// JSON bullets out. Uses the executePathway hook (like extract_weighted_keywords.js)
// so errors land on the request-scoped resolver and reach the GraphQL errors field.

import { Prompt } from '../server/prompt.js';

// Fallback only. WordPress normally sends the admin-edited prompt as `userPrompt`,
// which overrides this. Kept so the pathway is usable/testable with no caller prompt.
// {{count}} is Handlebars-rendered from the request args.
const DEFAULT_SYSTEM_PROMPT =
`You are an editorial assistant for Al Jazeera. Summarise the article the user provides into exactly {{count}} bullet points, written in the same language as the article. Respond ONLY with a JSON object of the form {"bullets":["…","…","…"]}. Each bullet must be a single self-contained fact of at most 140 characters, must not introduce facts that are not in the article, and must preserve names accurately.`;

export default {
    // Deterministic output for a structured summary.
    temperature: 0,

    // Parse + repair the model's JSON. NOTE: with json:true the `result` field is
    // returned as a JSON *string* — the caller must JSON.parse() it.
    json: true,

    // IMPORTANT: do NOT add a top-level `model:` field. Declaring `model` ONLY in
    // inputParameters lets a caller-supplied `model` arg take precedence at request
    // time (a top-level pathway.model would win and block the override).
    inputParameters: {
        text: '',            // article: headline + body (the user message)
        userPrompt: '',      // admin-edited system prompt from WordPress (overrides default)
        model: 'oai-gpt4o',  // GraphQL alias, NOT the /v1/models clean id. Overridable.
        count: 3,            // bullet count (PRD: hard 3)
    },

    // Build a two-message prompt (system = caller prompt or default, user = text),
    // run it, then validate the output shape. Failures return result: null with the
    // reason in the GraphQL errors field — never an error string in result, which
    // the caller JSON-parses.
    executePathway: async ({ args, runAllPrompts, resolver }) => {
        // The caller's prompt is Handlebars-compiled, so {{count}} is supported and
        // expected. A {{text}} placeholder is rejected: the article is always appended
        // as its own user message, and {{text}} in the prompt would inject it a second
        // time (doubled tokens, no error). Fail loud instead.
        if (/\{\{\{?\s*text\s*\}?\}\}/.test(args.userPrompt || '')) {
            resolver.logError('userPrompt must not contain a {{text}} placeholder — the article is appended automatically as the user message.');
            return null;
        }

        const systemContent = (args.userPrompt && args.userPrompt.trim() !== '')
            ? args.userPrompt
            : DEFAULT_SYSTEM_PROMPT;

        resolver.pathwayPrompt = [
            new Prompt({ messages: [
                { role: 'system', content: systemContent },
                { role: 'user',   content: '{{{text}}}' },
            ]}),
        ];

        const result = await runAllPrompts({ ...args });

        if (result == null) {
            resolver.logError('Model returned no parseable JSON after retries.');
            return null;
        }

        let parsed = null;
        try {
            parsed = JSON.parse(result);
        } catch ( err ) {
            // json:true should guarantee parseable output; if it ever doesn't, record the
            // parse reason so the failure is distinguishable from a wrong-shape result
            // rather than being re-reported as the generic shape error below.
            resolver.logError( `Model output was not parseable JSON: ${ err.message }` );
            return null;
        }

        const bullets = parsed?.bullets;
        const expectedCount = args.count ?? 3;
        if (!Array.isArray(bullets)
            || bullets.length !== expectedCount
            || !bullets.every((b) => typeof b === 'string' && b.trim() !== '')) {
            resolver.logError(`Model output did not match the expected {"bullets":[${expectedCount} non-empty strings]} shape.`);
            return null;
        }

        return result;
    },
};
