// sys_summarize_research.js
// Synthesizes tool calls and results into a coherent research summary with citations
// Focuses on extracting key findings, data, and sources from research tools

import { Prompt } from '../../../server/prompt.js';
import logger from '../../../lib/logger.js';

export default {
    prompt: [
        new Prompt({ messages: [
            {
                "role": "system",
                "content": `You are an AI assistant that synthesizes research findings from tool calls and results into a coherent, well-structured research summary.

Your job is to analyze tool calls (searches, file reads, web fetches, etc.) and their results, then create a comprehensive research summary that:

1. **Synthesizes findings** - Combine related information from multiple tool calls into coherent insights
2. **Preserves all citations** - Include exact URLs, source names, report numbers, publication dates, and author names
3. **Extracts key data** - Preserve exact numbers, percentages, dollar amounts, dates, statistics, and quantitative findings
4. **Maintains source attribution** - Clearly attribute each finding to its source with full citation details
5. **Organizes by topic** - Group related findings together logically
6. **Highlights important facts** - Emphasize the most significant or relevant findings for the research question

**CRITICAL REQUIREMENTS:**
- Preserve ALL URLs exactly as written (do not truncate or summarize URLs)
- Include full source citations (publication names, report numbers, dates, authors)
- Preserve exact numerical data (percentages, dollar amounts, dates, statistics)
- Maintain clear attribution linking facts to their sources
- Group related findings logically by topic or theme
- Use clear, professional research summary language

Format your summary as a structured research document with:
- Clear section headings for different topics
- Bullet points or numbered lists for key findings
- Inline citations in the format: [Source Name, Date] or [URL]
- Full citation details at the end or inline as appropriate

Be comprehensive but concise. Focus on actionable information and verifiable facts.`
            },
            {
                "role": "user",
                "content": `Please synthesize the following research tool calls and results into a coherent research summary with full citations:

{{{chatHistory}}}

Provide a well-structured research summary that:
- Synthesizes related findings from multiple sources
- Preserves all URLs, citations, and exact numerical data
- Clearly attributes each finding to its source
- Organizes information logically by topic
- Highlights the most important findings for the research question`
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
            // Extract and track citations and URLs for validation
            const citations = new Set();
            const urls = new Set();
            const toolCalls = [];
            
            if (Array.isArray(args.chatHistory)) {
                for (const msg of args.chatHistory) {
                    // Track tool calls
                    if (msg.tool_calls && msg.tool_calls.length > 0) {
                        msg.tool_calls.forEach(tc => {
                            toolCalls.push({
                                tool: tc.function?.name || 'unknown',
                                args: tc.function?.arguments || '{}',
                                id: tc.id
                            });
                        });
                    }
                    
                    // Extract URLs and citations from tool results
                    if (msg.role === 'tool' && msg.content) {
                        try {
                            const result = typeof msg.content === 'string' ? JSON.parse(msg.content) : msg.content;
                            if (result._type === 'SearchResponse' && result.value) {
                                for (const item of result.value) {
                                    if (item.url) urls.add(item.url);
                                    if (item.searchResultId) citations.add(item.searchResultId);
                                    if (item.title) citations.add(item.title);
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
            
            // Format tool calls and results for the prompt
            let researchText = '';
            
            if (Array.isArray(args.chatHistory)) {
                for (const msg of args.chatHistory) {
                    // Focus on tool calls and tool results - skip general conversation
                    if (msg.tool_calls && msg.tool_calls.length > 0) {
                        const role = msg.role || 'assistant';
                        let content = '';
                        
                        if (typeof msg.content === 'string') {
                            content = msg.content;
                        } else if (Array.isArray(msg.content)) {
                            content = msg.content.map(item => {
                                if (typeof item === 'string') return item;
                                if (item.type === 'text') return item.text;
                                if (item.type === 'image_url') return `[Image: ${item.image_url?.url || item.url || 'image'}]`;
                                return JSON.stringify(item);
                            }).join('\n');
                        }
                        
                        const toolCallsText = msg.tool_calls.map(tc => {
                            const funcName = tc.function?.name || 'unknown';
                            const funcArgs = tc.function?.arguments || '{}';
                            let argsText = funcArgs;
                            try {
                                const parsed = JSON.parse(funcArgs);
                                // Extract userMessage if present to show research intent
                                const userMsg = parsed.userMessage || parsed.q || parsed.text || '';
                                argsText = userMsg ? `Research goal: ${userMsg}\nArguments: ${JSON.stringify(parsed, null, 2)}` : JSON.stringify(parsed, null, 2);
                            } catch (e) {
                                // Keep as string if not valid JSON
                            }
                            return `Tool: ${funcName}\n${argsText}`;
                        }).join('\n\n');
                        
                        researchText += `[${role} - Tool Call]:\n${toolCallsText}\n\n`;
                    } else if (msg.role === 'tool' && msg.tool_call_id) {
                        // Format tool results
                        let toolResult = '';
                        if (typeof msg.content === 'string') {
                            toolResult = msg.content;
                        } else {
                            toolResult = JSON.stringify(msg.content, null, 2);
                        }
                        researchText += `[Tool Result - ${msg.name || 'unknown'}]:\n${toolResult}\n\n`;
                    }
                }
            } else {
                researchText = JSON.stringify(args.chatHistory);
            }
            
            // Add citation preservation instruction if we found citations
            let researchWithCitations = researchText;
            if (urls.size > 0 || citations.size > 0) {
                const urlList = Array.from(urls).slice(0, 30).join('\n'); // Limit to first 30 URLs
                const citationList = Array.from(citations).slice(0, 30).join('\n');
                researchWithCitations = `IMPORTANT: The following sources MUST be preserved with full citations in your summary:\n\nURLs:\n${urlList}\n\nCitations:\n${citationList}\n\n---\n\n${researchText}`;
            }
            
            // Pass the formatted research data as a parameter for the template
            const result = await runAllPrompts({
                ...args,
                chatHistory: researchWithCitations
            });
            
            // Validate that key URLs are preserved (basic check)
            if (urls.size > 0 && typeof result === 'string') {
                const preservedUrls = Array.from(urls).filter(url => result.includes(url));
                const preservationRate = preservedUrls.length / urls.size;
                
                if (preservationRate < 0.8) {
                    logger.warn(`Research summary preserved only ${(preservationRate * 100).toFixed(1)}% of URLs (${preservedUrls.length}/${urls.size})`);
                } else {
                    logger.info(`Research summary preserved ${(preservationRate * 100).toFixed(1)}% of URLs (${preservedUrls.length}/${urls.size})`);
                }
            }
            
            return result;
        } catch (error) {
            logger.error(`Error in sys_summarize_research: ${error.message}`);
            // Return a fallback summary if summarization fails
            return `[Research summarization failed: ${error.message}] Previous research tool calls and results could not be synthesized.`;
        }
    }
};

