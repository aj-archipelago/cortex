// sys_compress_context.js
// Compresses chat history containing tool calls and results while preserving critical information
// Used when context window is approaching limits to prevent 400 errors

import { Prompt } from '../../../server/prompt.js';
import logger from '../../../lib/logger.js';

export default {
    prompt: [
        new Prompt({ messages: [
            {
                "role": "system",
                "content": `You are an AI assistant that compresses conversation history while preserving critical information needed to continue the task.

Your job is to create a concise summary from tool calls and their results that:

1. **Preserves the research intent** - What was the user trying to find or accomplish?

2. **Summarizes tool calls and results** - For each tool call, include:
   - The tool name and purpose
   - Key results and findings (especially data, facts, file names, URLs)
   - Important decisions made based on results

3. **CRITICAL: Preserve exact data** - You MUST preserve:
   - Exact numbers, percentages, dollar amounts, dates, statistics
   - ALL URLs exactly as written (never truncate URLs)
   - Source citations (publication names, report numbers, author names)
   - File names and paths exactly as they appear

4. **Maintain citation integrity** - Preserve file names, URLs, source references

5. **Keep it actionable** - What has been accomplished? What still needs to be done?

Format as a clear narrative that another AI agent could read to understand the research progress.

Be concise but comprehensive. When in doubt, preserve more detail for numbers, URLs, and citations.`
            },
            {
                "role": "user",
                "content": `Please compress the following tool calls and results into a concise research summary:

{{{researchContent}}}

Provide a clear summary preserving all URLs, citations, and numerical data.`
            }
        ]})
    ],
    inputParameters: {
        researchContent: '',
        language: "English",
    },
    model: 'gemini-flash-3-vision',
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 120,
    
    executePathway: async ({args, runAllPrompts}) => {
        try {
            // Extract URLs for validation
            const urls = new Set();
            const content = args.researchContent || '';
            const urlMatches = content.match(/https?:\/\/[^\s\)\]"']+/g);
            if (urlMatches) urlMatches.forEach(url => urls.add(url));
            
            const result = await runAllPrompts(args);
            
            // Validate URL preservation
            if (urls.size > 0 && typeof result === 'string') {
                const preserved = Array.from(urls).filter(url => result.includes(url));
                const rate = preserved.length / urls.size;
                if (rate < 0.7) {
                    logger.warn(`Context compression preserved only ${(rate * 100).toFixed(0)}% of URLs (${preserved.length}/${urls.size})`);
                }
            }
            
            return result;
        } catch (error) {
            logger.error(`Error in sys_compress_context: ${error.message}`);
            return `[Compression failed] Previous tool calls have been summarized to save context space.`;
        }
    }
};
