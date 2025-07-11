import { PathwayResolver } from '../server/pathwayResolver.js';
import { Prompt } from '../server/prompt.js';
import logger from '../lib/logger.js';
import {config} from '../config.js';

// load it from a url from config
let systemPrompts = {};
try {
    systemPrompts  = await fetch(config.get('styleguideSystemPromptsUrl')).then(res => res.json());
    logger.info('Styleguide system prompts loaded successfully');
} catch (error) {
    logger.error('Error loading styleguide system prompts: ' + error);
}


export default {
    inputParameters: {
        text: '',
        language: 'en',
    },
    model: 'groq-chat',
    json: true,
    format: 'originalText, fixedText, reason',


    resolver: async (parent, args, contextValue, _info) => {
        try {
            const { config, pathway,  } = contextValue;
            const { text, language } = args;

            logger.verbose('Styleguide pathway called with text: ' + text);
            logger.verbose('Styleguide pathway called with language: ' + language);

            const systemPrompt = systemPrompts[language?.toLowerCase()] || systemPrompts.en;
            const prompt = new Prompt({
                messages: [
                    systemPrompt,
                    {
                        role: 'user',
                        content: text,
                    },
                ],
            });

            logger.verbose('Styleguide pathway prompt: ' + JSON.stringify(prompt));

            const pathwayResolver = new PathwayResolver({ config, pathway, args });
            pathwayResolver.pathwayPrompt = [prompt];

            const result = await pathwayResolver.resolve(args);

            try {
                // The model might return the JSON wrapped in markdown or with other text.
                // We'll extract the JSON part of the string. The cortex parser failed to parse this as json. 
                const jsonMatch = result.match(/\{[\s\S]*\}/);
                if (jsonMatch && jsonMatch[0]) {
                    const parsedResult = JSON.parse(jsonMatch[0]);
                    logger.verbose('Styleguide pathway result: ' + JSON.stringify(parsedResult));
                    return parsedResult;
                } else {
                    throw new Error("No JSON object found in the model's response.");
                }
            } catch (error) {
                console.error('Error parsing JSON from model:', error);
                return {
                    originalText: text,
                    fixedText: result, // The raw result from the model
                    reason: `Could not parse the response from the model. Raw response: "${result}"`,
                };
            }
        } catch (error) {
            console.error('Error in styleguide pathway:', error);
            return {
                originalText: text,
                fixedText: text,
                reason: 'Error in styleguide pathway: ' + error.message,
            };
        }
    },
};
