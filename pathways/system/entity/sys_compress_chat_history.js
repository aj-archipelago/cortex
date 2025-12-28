// sys_compress_chat_history.js
// Intelligently compresses chat history containing tool calls and results
// Preserves important information, citations, and context needed to continue the task

import { Prompt } from '../../../server/prompt.js';
import logger from '../../../lib/logger.js';

export default {
    prompt: [
        new Prompt({ messages: [
            {
                "role": "system",
                "content": `You are an AI assistant that compresses conversation history while preserving critical information needed to continue the task.

Your job is to analyze the provided chat history (which may contain tool calls, tool results, user messages, and assistant responses) and create a concise summary that:

1. **Preserves the original user request/question** - Always include the initial user query or task verbatim or in close paraphrase

2. **Summarizes tool calls and results** - For each tool call, include:
   - The tool name (e.g., SearchInternet, AnalyzeFile)
   - Why it was called (the purpose/goal from userMessage or context)
   - Key results or findings (especially data, facts, file names, URLs, citations)
   - Any important context or decisions made based on the results

3. **CRITICAL: Preserve all exact data** - You MUST preserve:
   - Exact numbers, percentages, dollar amounts, dates, and statistics
   - All URLs and file paths exactly as written (do not summarize or truncate URLs)
   - Source citations with full attribution (publication names, report numbers, author names)
   - Tool names exactly as they appear
   - Any data that would be needed to verify claims or continue research

4. **Maintains citation integrity** - Preserve file names, URLs, source references, and any attribution information. URLs are especially critical - include them in full.

5. **Preserves task context** - Keep information about what the user is trying to accomplish and the current state of the task

6. **Maintains conversation flow** - Show the progression of the task, not just isolated facts

Format your summary as a clear, structured narrative that another AI agent could read to understand:
- What the user originally asked for
- What tools were used and why
- What was discovered or accomplished (with specific numbers, URLs, and citations)
- What still needs to be done (if applicable)

Be concise but comprehensive. Focus on actionable information and facts that are needed to continue the work. When in doubt, preserve more detail rather than less - especially for numbers, URLs, and citations.`
            },
            {
                "role": "user",
                "content": `Please compress the following chat history into a concise summary that preserves all critical information, citations, and context needed to continue the task:

{{{chatHistory}}}

Provide a clear, structured summary that maintains citation integrity and preserves the information needed to continue the work.`
            }
        ]})
    ],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        language: "English",
    },
    model: 'gemini-flash-3-vision',
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 300,
    reasoningEffort: 'high',
    executePathway: async ({args, runAllPrompts, resolver}) => {
        try {
            // Extract citations and URLs before compression for validation
            const citations = new Set();
            const urls = new Set();
            
            if (Array.isArray(args.chatHistory)) {
                for (const msg of args.chatHistory) {
                    // Extract URLs from tool results
                    if (msg.role === 'tool' && msg.content) {
                        try {
                            const result = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
                            if (result._type === 'SearchResponse' && result.value) {
                                for (const item of result.value) {
                                    if (item.url) urls.add(item.url);
                                    if (item.searchResultId) citations.add(item.searchResultId);
                                }
                            }
                        } catch (e) {
                            // Not JSON or not search response, check for URLs in string
                            if (typeof msg.content === 'string') {
                                const urlMatches = msg.content.match(/https?:\/\/[^\s\)]+/g);
                                if (urlMatches) urlMatches.forEach(url => urls.add(url));
                            }
                        }
                    }
                    // Extract URLs from any message content
                    if (typeof msg.content === 'string') {
                        const urlMatches = msg.content.match(/https?:\/\/[^\s\)]+/g);
                        if (urlMatches) urlMatches.forEach(url => urls.add(url));
                    }
                }
            }
            
            // Format chat history for the prompt
            // Convert messages array to a readable format
            let chatHistoryText = '';
            
            if (Array.isArray(args.chatHistory)) {
                for (const msg of args.chatHistory) {
                    const role = msg.role || msg.author || 'unknown';
                    let content = '';
                    
                    if (typeof msg.content === 'string') {
                        content = msg.content;
                    } else if (Array.isArray(msg.content)) {
                        // Handle multimodal content
                        content = msg.content.map(item => {
                            if (typeof item === 'string') return item;
                            if (item.type === 'text') return item.text;
                            if (item.type === 'image_url') return `[Image: ${item.image_url?.url || item.url || 'image'}]`;
                            return JSON.stringify(item);
                        }).join('\n');
                    } else if (msg.content) {
                        content = JSON.stringify(msg.content);
                    }
                    
                    // Handle tool calls
                    if (msg.tool_calls && msg.tool_calls.length > 0) {
                        const toolCallsText = msg.tool_calls.map(tc => {
                            const funcName = tc.function?.name || 'unknown';
                            const funcArgs = tc.function?.arguments || '{}';
                            let argsText = funcArgs;
                            try {
                                const parsed = JSON.parse(funcArgs);
                                argsText = JSON.stringify(parsed, null, 2);
                            } catch (e) {
                                // Keep as string if not valid JSON
                            }
                            return `Tool: ${funcName}\nArguments: ${argsText}`;
                        }).join('\n\n');
                        chatHistoryText += `[${role}]: ${content || '(no content)'}\nTool Calls:\n${toolCallsText}\n\n`;
                    } else if (msg.role === 'tool' && msg.tool_call_id) {
                        // Handle tool results
                        let toolResult = '';
                        if (typeof msg.content === 'string') {
                            toolResult = msg.content;
                        } else {
                            toolResult = JSON.stringify(msg.content);
                        }
                        chatHistoryText += `[tool/${msg.name || 'unknown'}]: ${toolResult}\n\n`;
                    } else {
                        chatHistoryText += `[${role}]: ${content}\n\n`;
                    }
                }
            } else {
                chatHistoryText = JSON.stringify(args.chatHistory);
            }
            
            // Add citation preservation instruction if we found citations
            let chatHistoryWithCitations = chatHistoryText;
            if (urls.size > 0 || citations.size > 0) {
                const citationList = Array.from(urls).slice(0, 20).join('\n'); // Limit to first 20 URLs
                chatHistoryWithCitations = `IMPORTANT: The following URLs and citations MUST be preserved exactly in your summary:\n${citationList}\n\n---\n\n${chatHistoryText}`;
            }
            
            // Pass the formatted chat history as a parameter for the template
            const result = await runAllPrompts({
                ...args,
                chatHistory: chatHistoryWithCitations
            });
            
            // Validate that key URLs are preserved (basic check)
            if (urls.size > 0 && typeof result === 'string') {
                const preservedUrls = Array.from(urls).filter(url => result.includes(url));
                const preservationRate = preservedUrls.length / urls.size;
                
                if (preservationRate < 0.8) {
                    logger.warn(`Compression preserved only ${(preservationRate * 100).toFixed(1)}% of URLs (${preservedUrls.length}/${urls.size})`);
                } else {
                    logger.info(`Compression preserved ${(preservationRate * 100).toFixed(1)}% of URLs (${preservedUrls.length}/${urls.size})`);
                }
            }
            
            return result;
        } catch (error) {
            logger.error(`Error in sys_compress_chat_history: ${error.message}`);
            // Return a fallback summary if compression fails
            return `[Compression failed: ${error.message}] Previous conversation history contained tool calls and results that have been compressed to save context space.`;
        }
    }
};

