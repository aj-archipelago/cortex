// sys_tool_bing_search.js
// Tool pathway that handles Bing web search functionality
import { callPathway } from '../../../../lib/pathwayTools.js';
import logger from '../../../../lib/logger.js';
import { config } from '../../../../config.js';
import { getSearchResultId } from '../../../../lib/util.js';
import { parseJson } from '@aj-archipelago/cortex/server/parser.js';

export default {
    prompt: [],
    timeout: 300,
    toolDefinition: { 
        type: "function",
        icon: "🌐",
        function: {
            name: "SearchInternetAgent",
            description: "This tool allows you to search the internet and more. Use this for current events, news, fact-checking, and information requiring citation.",
            parameters: {
                type: "object",
                properties: {
                    text: {
                        type: "string",
                        description: "The complete query text to search."
                    },
                    systemPrompt: {
                        type: "string",
                        description: "A comprehensive prompt specifying the desired characteristics and constraints for search results, with a preference for intensive searches that yield extensive data, including aspects like quantity, data types, temporal relevance, source limitations, or required informational depth."
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    }
                },
                required: ["text", "systemPrompt", "userMessage"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {

        // Check if Bing API key is available
        const servicePricipalAvailable = !!config.getEnv()["AZURE_SERVICE_PRINCIPAL_CREDENTIALS"];
        if (!servicePricipalAvailable) {
            throw new Error("Service Principal for Bing Search Agent is not available!");
        }

        try {
            // Call the Bing search pathway
            //remove model from args as bing_agent has model in its own
            const { model, ...restArgs } = args;
            const rawResponse = await callPathway('bing_agent', { 
                ...restArgs,
            }, resolver);
            const response = JSON.parse(rawResponse);

            if (resolver.errors && resolver.errors.length > 0) {
                const errorMessages = Array.isArray(resolver.errors) 
                    ? resolver.errors.map(err => err.message || err)
                    : [resolver.errors.message || resolver.errors];
                return JSON.stringify({ _type: "SearchError", value: errorMessages });
            }

            function transformResponse(response) {
                const transformedResults = [];
              
                if (response.annotations && Array.isArray(response.annotations)) {
                  // Extract content segments from the value string
                  const valueText = response.value || '';
                  
                  // First, split the text into segments and map citations to them
                  const segments = [];
                  
                  // Split by bullet points and paragraphs to get distinct content segments
                  const parts = valueText.split(/(?=^- )/m).filter(part => part.trim());
                  
                  for (const part of parts) {
                    const trimmedPart = part.trim();
                    if (trimmedPart) {
                      // Find all citations in this segment
                      const citationPattern = /【\d+:\d+†source】/g;
                      const citations = [];
                      let match;
                      
                      while ((match = citationPattern.exec(trimmedPart)) !== null) {
                        citations.push(match[0]);
                      }
                      
                      // Remove all citation markers to get clean content
                      const cleanContent = trimmedPart.replace(/【\d+:\d+†source】/g, '').trim();
                      
                      // Remove bullet point marker if present
                      const finalContent = cleanContent.startsWith('- ') 
                        ? cleanContent.substring(2).trim() 
                        : cleanContent;
                      
                      if (finalContent && citations.length > 0) {
                        segments.push({
                          content: finalContent,
                          citations: citations
                        });
                      }
                    }
                  }
                  
                  // Now map annotations to their corresponding segments
                  for (const annotation of response.annotations) {
                    if (annotation.type === "url_citation" && annotation.url_citation) {
                      const { url, title } = annotation.url_citation;
                      const citationText = annotation.text;
                      
                      // Find the segment that contains this citation
                      const matchingSegment = segments.find(segment => 
                        segment.citations.includes(citationText)
                      );
                      
                      const content = matchingSegment ? matchingSegment.content : title;
                      
                      transformedResults.push({
                        searchResultId: getSearchResultId(),
                        title: title,
                        content: content,
                        url: url
                      });
                    }
                  }
                }
                return transformedResults;
            }

              


            
            const resultData = JSON.parse(await parseJson(response.value));
            const results = resultData?.results || [];


            //add a searchResultId to each result for annotation
            results.forEach(result => {
                result.searchResultId = getSearchResultId();
            });

            resolver.tool = JSON.stringify({ toolUsed: "SearchInternetAgent" });
            return JSON.stringify({ _type: "SearchResponse", value: results });
        } catch (e) {
            logger.error(`Error in Bing search: ${e}`);
            throw e;
        }
    }
}; 