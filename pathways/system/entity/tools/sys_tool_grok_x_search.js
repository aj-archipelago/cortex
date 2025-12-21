// sys_tool_grok_x_search.js
// Tool pathway that handles Grok X Platform search using the new Responses API with search tools
import { callPathway } from '../../../../lib/pathwayTools.js';
import logger from '../../../../lib/logger.js';
import { getSearchResultId, extractCitationTitle } from '../../../../lib/util.js';

export default {
    prompt: [],
    timeout: 300,
    inputParameters: {
        text: '',
        userMessage: '',
        includedHandles: { type: 'array', items: { type: 'string' }, default: [] },
        excludedHandles: { type: 'array', items: { type: 'string' }, default: [] },
        fromDate: '',
        toDate: '',
        enableImageUnderstanding: false,
        enableVideoUnderstanding: false,
        maxResults: 10
    },
    toolDefinition: { 
        type: "function",
        icon: "🔍",
        function: {
            name: "SearchXPlatform",
            description: "This tool allows you to search the X platform (formerly Twitter) for current posts, discussions, and real-time information. Use this for finding recent social media content, trending topics, public opinions, and real-time updates. This tool can be slow - 10-60s per search, so only use it when you really want X platform information. Always call this tool in parallel rather than serially if you have several searches to do as it will be faster.",
            parameters: {
                type: "object",
                properties: {
                    text: {
                        type: "string",
                        description: "The complete natural language prompt describing what you want to search for on X platform. This can include topics, hashtags, usernames, or general queries about current events and discussions."
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    },
                    includedHandles: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional array of X handles to include in search (e.g., ['OpenAI', 'AnthropicAI', 'xai']). Maximum 10 handles.",
                        maxItems: 10
                    },
                    excludedHandles: {
                        type: "array",
                        items: { type: "string" },
                        description: "Optional array of X handles to exclude from search. Maximum 10 handles. Cannot be used in conjunction with includedHandles.",
                        maxItems: 10
                    },
                    fromDate: {
                        type: "string",
                        description: "Optional date from which to start searching (YYYY-MM-DD format)",
                        format: "date"
                    },
                    toDate: {
                        type: "string",
                        description: "Optional date to which to end searching (YYYY-MM-DD format)",
                        format: "date"
                    },
                    enableImageUnderstanding: {
                        type: "boolean",
                        description: "Enable the agent to analyze images found in X posts",
                        default: false
                    },
                    enableVideoUnderstanding: {
                        type: "boolean",
                        description: "Enable the agent to analyze videos found in X posts",
                        default: false
                    },
                    maxResults: {
                        type: "number",
                        description: "Maximum number of search results to return (default: 10)",
                        minimum: 1,
                        maximum: 50,
                        default: 10
                    }
                },
                required: ["text", "userMessage"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        
        try {
            // Build tools configuration for the new Responses API
            // X Search tool with all supported parameters
            // Handle date range for xAI API
            // When searching for a single day that's recent (within 1 day of today),
            // omit to_date to let xAI default to "now" and avoid timezone boundary issues
            // Per docs: "with only from_date specified, the data used will be from the from_date to today"
            let effectiveFromDate = args.fromDate;
            let effectiveToDate = args.toDate;
            
            if (args.fromDate && args.toDate && args.fromDate === args.toDate) {
                // Check if this is a recent search (within 1 day of today)
                const searchDate = new Date(args.fromDate);
                const today = new Date();
                const daysDiff = Math.floor((today - searchDate) / (1000 * 60 * 60 * 24));
                
                if (daysDiff <= 1) {
                    // Recent single-day search - omit to_date to get most current results
                    effectiveToDate = null;
                    logger.debug(`[sys_tool_grok_x_search] Recent single-day search for ${args.fromDate} (${daysDiff} days ago), omitting to_date`);
                } else {
                    // Historical single-day search - keep both dates for precision
                    logger.debug(`[sys_tool_grok_x_search] Historical single-day search for ${args.fromDate} (${daysDiff} days ago), keeping to_date`);
                }
            }

            const xSearchConfig = {
                ...(args.includedHandles && args.includedHandles.length > 0 && {
                    allowed_x_handles: args.includedHandles.slice(0, 10)
                }),
                ...(args.excludedHandles && args.excludedHandles.length > 0 && {
                    excluded_x_handles: args.excludedHandles.slice(0, 10)
                }),
                ...(effectiveFromDate && {
                    from_date: effectiveFromDate
                }),
                ...(effectiveToDate && {
                    to_date: effectiveToDate
                }),
                ...(args.enableImageUnderstanding && {
                    enable_image_understanding: true
                }),
                ...(args.enableVideoUnderstanding && {
                    enable_video_understanding: true
                })
            };

            // Build the tools object for the new Responses API
            const tools = {
                x_search: Object.keys(xSearchConfig).length > 0 ? xSearchConfig : true
            };

            // Call the Grok Live Search pathway with new tools format
            // Use the new Responses API model for X search
            const { model, text, ...restArgs } = args;
            
            // Construct a prompt that asks for structured output with rich metadata
            // IMPORTANT: Tell Grok NOT to add inline citations to every field - only put the citation at the end with the Link
            const structuredPrompt = `Search X for: ${text}

For each X post you find, provide this structured information. IMPORTANT: Do NOT add inline citations [[N]](url) to each field - only include ONE citation per post at the very end after the Link field.

Format each post as:
1. **Author**: @handle (display name)
   **Posted**: Date and time with timezone
   **Content**: The full text of the post
   **Type**: Original/Reply/Repost/Quote
   **Engagement**: Likes, Reposts, Replies, Views
   **Media**: Images/videos or None
   **Link**: https://x.com/handle/status/id [[1]](url)

Return posts as a numbered list. Keep metadata fields clean without inline citations - the citation goes ONLY at the end of each post entry.`;

            const result = await callPathway('grok_live_search', { 
                ...restArgs,
                text: structuredPrompt,
                model: 'xai-grok-4-1-fast-responses',
                tools: JSON.stringify(tools),
                inline_citations: true
            }, resolver);
            
            if (resolver.errors && resolver.errors.length > 0) {
                const errorMessages = Array.isArray(resolver.errors) 
                    ? resolver.errors.map(err => err.message || err)
                    : [resolver.errors.message || resolver.errors];
                const errorMessageStr = errorMessages.join('; ');
                return JSON.stringify({ error: errorMessageStr, recoveryMessage: "This tool failed. You should try the backup tool for this function." });
            }

            // Transform response to match expected SearchResponse format
            function transformToSearchResponse(resultData, result) {
                // Extract text and citations from CortexResponse
                const valueText = result || '';
                const citations = resultData.citations || [];
                
                // Create a mapping from citation URLs to search result IDs
                const citationToIdMap = new Map();
                const finalSearchResults = [];
                
                // Helper to extract structured post metadata from text near a citation
                function extractPostMetadata(url, text) {
                    const metadata = {
                        author: null,
                        authorHandle: null,
                        timestamp: null,
                        content: null,
                        postType: null,
                        engagement: null,
                        media: null
                    };
                    
                    if (!text || !url) return metadata;
                    
                    try {
                        // Find the section of text that contains this URL
                        const urlEscaped = url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        
                        // Look for a numbered list item that contains this URL
                        // Pattern: matches from start of numbered item to next numbered item or end
                        const listItemPattern = new RegExp(`(\\d+\\.\\s*[^]*?)(?=\\n\\d+\\.|$)`, 'g');
                        let match;
                        let relevantSection = null;
                        
                        while ((match = listItemPattern.exec(text)) !== null) {
                            if (match[1].includes(url)) {
                                relevantSection = match[1];
                                break;
                            }
                        }
                        
                        if (!relevantSection) {
                            // Try a simpler approach - find text around the URL
                            const urlIndex = text.indexOf(url);
                            if (urlIndex > 0) {
                                const start = Math.max(0, text.lastIndexOf('\n', urlIndex - 300));
                                const end = Math.min(text.length, text.indexOf('\n\n', urlIndex + url.length) || text.length);
                                relevantSection = text.substring(start, end);
                            }
                        }
                        
                        if (relevantSection) {
                            // Extract author - look for patterns like "Elon Musk (@elonmusk)" or "@elonmusk"
                            // First try to find handle in parentheses: "Name (@handle)"
                            const handleInParensMatch = relevantSection.match(/\*\*Author\*\*:\s*([^(@\n]+)\s*\(@(\w{1,15})\)/i);
                            // Fallback to simple @handle pattern
                            const simpleHandleMatch = relevantSection.match(/@(\w{1,15})\b/);
                            
                            if (handleInParensMatch) {
                                metadata.authorHandle = handleInParensMatch[2]; // the handle in parentheses
                                metadata.author = handleInParensMatch[1].trim(); // the display name
                            } else if (simpleHandleMatch) {
                                metadata.authorHandle = simpleHandleMatch[1];
                                metadata.author = `@${simpleHandleMatch[1]}`;
                            }
                            
                            // Extract timestamp - look for Posted or date/time patterns
                            const timestampMatch = relevantSection.match(/\*\*Posted\*\*:\s*([^\n*]+)/i) ||
                                                   relevantSection.match(/(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}[^\n]*)/);
                            if (timestampMatch) {
                                metadata.timestamp = timestampMatch[1].trim();
                            }
                            
                            // Extract content
                            const contentMatch = relevantSection.match(/\*\*Content\*\*:\s*"?([^"*\n]+)"?/i) ||
                                                 relevantSection.match(/\*\*Content\*\*:\s*([^\n]+(?:\n(?!\*\*)[^\n]+)*)/i);
                            if (contentMatch) {
                                metadata.content = contentMatch[1].trim().replace(/^["']|["']$/g, '');
                            }
                            
                            // Extract post type
                            const typeMatch = relevantSection.match(/\*\*Type\*\*:\s*([^\n*]+)/i);
                            if (typeMatch) {
                                metadata.postType = typeMatch[1].trim().toLowerCase();
                            }
                            
                            // Extract engagement
                            const engagementMatch = relevantSection.match(/\*\*Engagement\*\*:\s*([^\n*]+)/i);
                            if (engagementMatch) {
                                metadata.engagement = engagementMatch[1].trim();
                            }
                            
                            // Extract media info
                            const mediaMatch = relevantSection.match(/\*\*Media\*\*:\s*([^\n*]+)/i);
                            if (mediaMatch) {
                                metadata.media = mediaMatch[1].trim();
                            }
                        }
                    } catch (e) {
                        logger.debug(`Error extracting post metadata: ${e.message}`);
                    }
                    
                    return metadata;
                }
                
                // Process citations array
                if (Array.isArray(citations)) {
                    citations.forEach(citation => {
                        const searchResultId = citation.searchResultId || getSearchResultId();
                        
                        // Check if we already have this URL in searchResults
                        const existingResult = finalSearchResults.find(r => r.url === citation.url);
                        if (!existingResult) {
                            // Extract structured metadata from the response text
                            const postMetadata = extractPostMetadata(citation.url, valueText);
                            
                            // Build a rich title with proper @handle format
                            let richTitle = citation.title || extractCitationTitle(citation.url);
                            if (postMetadata.authorHandle) {
                                // Use format: "X Post by @handle" or "X Post by DisplayName (@handle)"
                                if (postMetadata.author && postMetadata.author !== `@${postMetadata.authorHandle}`) {
                                    richTitle = `X Post by ${postMetadata.author} (@${postMetadata.authorHandle})`;
                                } else {
                                    richTitle = `X Post by @${postMetadata.authorHandle}`;
                                }
                            }
                            if (postMetadata.timestamp) {
                                richTitle += ` (${postMetadata.timestamp})`;
                            }
                            
                            // Build rich content
                            let richContent = postMetadata.content || citation.content || citation.title || '';
                            if (postMetadata.postType) {
                                richContent = `[${postMetadata.postType}] ${richContent}`;
                            }
                            if (postMetadata.engagement) {
                                richContent += ` | Engagement: ${postMetadata.engagement}`;
                            }
                            
                            finalSearchResults.push({
                                searchResultId: searchResultId,
                                title: richTitle,
                                url: citation.url,
                                content: richContent,
                                path: '',
                                wireid: '',
                                source: 'X Platform',
                                slugline: postMetadata.author ? `@${postMetadata.authorHandle}` : '',
                                date: postMetadata.timestamp || '',
                                // Include raw metadata for downstream use
                                metadata: postMetadata
                            });
                        }
                        
                        // Create mapping for URL replacement
                        if (citation.url) {
                            citationToIdMap.set(citation.url, searchResultId);
                        }
                    });
                }
                
                // Extract inline citations from the text
                // Handle multiple formats: [1](url), [[1]](url), [1(url)]
                const inlineCitationPattern = /\[\[?(\d+)\]?\]\(([^)]+)\)|\[(\d+)\(([^)]+)\)\]/g;
                let match;
                const inlineCitations = new Set();
                
                while ((match = inlineCitationPattern.exec(valueText)) !== null) {
                    const citationNumber = match[1] || match[3];
                    const citationUrl = match[2] || match[4];
                    inlineCitations.add(citationUrl);
                    
                    // If we haven't already processed this URL, add it to search results
                    if (!citationToIdMap.has(citationUrl)) {
                        const searchResultId = getSearchResultId();
                        citationToIdMap.set(citationUrl, searchResultId);
                        
                        // Extract structured metadata from the response text
                        const postMetadata = extractPostMetadata(citationUrl, valueText);
                        
                        // Build a rich title with proper @handle format
                        let richTitle = extractCitationTitle(citationUrl);
                        if (postMetadata.authorHandle) {
                            if (postMetadata.author && postMetadata.author !== `@${postMetadata.authorHandle}`) {
                                richTitle = `X Post by ${postMetadata.author} (@${postMetadata.authorHandle})`;
                            } else {
                                richTitle = `X Post by @${postMetadata.authorHandle}`;
                            }
                        }
                        if (postMetadata.timestamp) {
                            richTitle += ` (${postMetadata.timestamp})`;
                        }
                        
                        // Build rich content
                        let richContent = postMetadata.content || richTitle;
                        if (postMetadata.postType) {
                            richContent = `[${postMetadata.postType}] ${richContent}`;
                        }
                        if (postMetadata.engagement) {
                            richContent += ` | Engagement: ${postMetadata.engagement}`;
                        }
                        
                        finalSearchResults.push({
                            searchResultId: searchResultId,
                            title: richTitle,
                            url: citationUrl,
                            content: richContent,
                            path: '',
                            wireid: '',
                            source: 'X Platform',
                            slugline: postMetadata.author ? `@${postMetadata.authorHandle}` : '',
                            date: postMetadata.timestamp || '',
                            metadata: postMetadata
                        });
                    }
                }
                
                // Replace inline citations with our standard format
                let transformedText = valueText.replace(inlineCitationPattern, (match, num1, url1, num2, url2) => {
                    const url = url1 || url2;
                    const searchResultId = citationToIdMap.get(url);
                    return searchResultId ? `:cd_source[${searchResultId}]` : match;
                });
                
                // Also handle simple numbered citations [1] or [[1]] format
                transformedText = transformedText.replace(/\[\[?(\d+)\]?\](?!\()/g, (match, num) => {
                    const citationIndex = parseInt(num) - 1;
                    if (citations[citationIndex]) {
                        const citation = citations[citationIndex];
                        if (citation.searchResultId) {
                            return `:cd_source[${citation.searchResultId}]`;
                        }
                        const url = typeof citation === 'string' ? citation : citation.url;
                        const searchResultId = citationToIdMap.get(url);
                        return searchResultId ? `:cd_source[${searchResultId}]` : match;
                    }
                    return match;
                });
                
                // If no citations found anywhere, create a single search result with the content
                if (finalSearchResults.length === 0) {
                    finalSearchResults.push({
                        searchResultId: getSearchResultId(),
                        title: 'X Platform Search Results',
                        url: 'https://x.com/search',
                        content: transformedText,
                        path: '',
                        wireid: '',
                        source: 'X Platform',
                        slugline: '',
                        date: ''
                    });
                }
                
                return {
                    transformedText: transformedText,
                    searchResults: finalSearchResults
                };
            }

            resolver.pathwayResultData.toolUsed = 'SearchXPlatform';
           
            // Transform the CortexResponse and return the search response
            const transformedData = transformToSearchResponse(resolver.pathwayResultData, result);
            return JSON.stringify({ 
                _type: "SearchResponse", 
                value: transformedData.searchResults,
                text: transformedData.transformedText
            });
        } catch (e) {
            const errorMessage = e?.message || e?.toString() || String(e);
            logger.error(`Error in Grok X Platform search: ${errorMessage}`);
            
            // Return error response instead of throwing so agent can see and adjust
            return JSON.stringify({ 
                error: errorMessage, 
                recoveryMessage: "This tool failed. You should try the backup tool for this function." 
            });
        }
    }
};
