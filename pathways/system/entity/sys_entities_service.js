// pathways/system/entity/sys_entities_service.js
// Entity-specific RAG pathway
// Called by sys_entity_start when args.entityId is provided.
import { callPathway, gpt3Encode, gpt3Decode, say } from '../../../lib/pathwayTools.js';
import { Prompt } from '../../../server/prompt.js';
import logger from '../../../lib/logger.js';
import { config as pathwayConfig } from '../../../config.js';
import { getEntityConfig } from './utils.js';
import {
    flexibleJsonParse,
    calculateMaxSourcesPromptLength,
    formatSource,
    extractReferencedSources,
    pruneSearchResults,
    parseBing,
    generateExtraArgs,
    handlePathwayError
} from './sysEntityUtils.js';

// --- Pathway Definition ---
export default {
    prompt: [],
    useInputChunking: false,
    enableDuplicateRequests: false,
    inputParameters: {
        chatHistory: [{ role: '', content: [] }],
        entityId: "",
        aiName: "",
        contextId: ``,
        useMemory: false,
        roleInformation: ``,
        language: "English",
        chatId: ``,
        dataSources: [""],
        voiceResponse: false,
        model: "gemini-pro-25-vision",
    },
    timeout: 300,
    executePathway: async ({ args, runAllPrompts, resolver }) => {
        const { chatHistory, entityId, language } = args;
        args.model = "gemini-pro-25-vision";
        let pathwayResolver = resolver;

        // --- Initial Setup & Config Loading (Moved Before Try) ---
        if (!entityId) {
            // Throw directly if entityId is missing, no need for custom handler here
            logger.error('sys_entity called without a valid entityId.');
            throw new Error('sys_entity requires a valid entityId.');
        }
        let entityConf;
        try {
            entityConf = getEntityConfig(entityId);
            logger.info(`Executing sys_entity pathway for: ${entityId}`);
        } catch (e) {
            logger.error(`Could not load configuration for entity ID "${entityId}": ${e.message}`);
            throw new Error(`Could not load configuration for entity ID "${entityId}": ${e.message}`);
        }

        try {
            // --- Model Setup (Inside Try) ---
            const requestedModel = args.model || entityConf.model;
            // Add checks for allowedModels existence and type
            if (!entityConf.allowedModels || !Array.isArray(entityConf.allowedModels)) {
                //logger.warn(`[${entityId}] Entity config missing or has invalid 'allowedModels' array. Skipping model validation.`);
                // If validation can't be performed, allow the requested/default model
                args.model = requestedModel;
            } else if (!entityConf.allowedModels.includes(requestedModel)) {
                logger.warn(`Model ${requestedModel} not allowed for ${entityId}. Falling back to ${entityConf.model}.`);
                args.model = entityConf.model;
            } else {
                args.model = requestedModel;
            }

            const entityPrompt = entityConf.prompt || "";

            pathwayResolver.pathwayPrompt = [
                new Prompt({
                    messages: [
                        {
                            role: "system", content: `{{renderTemplate AI_CONVERSATION_HISTORY}}
{{renderTemplate AI_COMMON_INSTRUCTIONS}}
{{renderTemplate AI_DIRECTIVES}}
Your mission is to analyze the provided conversation history and provide accurate and truthful responses from the information sources provided below that are the results of your most recent search of the internet, newswires, published Al Jazeera articles, and personal documents and data.

You are an entity and your entityPrompt is:
${entityPrompt}

Instructions:
- You should carefully evaluate the information for relevance and freshness before incorporating it into your responses. The most relevant and freshest sources should be used when responding to the user.
- Only share information in your responses that is grounded in your information sources.
- If the user is asking about a file (PDF, CSV, Word Document, text, etc.), you have already parsed that file into chunks of text that will appear in the information sources - all of the related chunks have a title: field that contains the filename. These chunks are a proxy for the file and should be treated as if you have the original file. The user cannot provide you with the original file in any other format. Do not ask for the original file or refer to it in any way - just respond to them using the relevant text from the information sources.
- If the user is asking just about topics or headlines, don't include the story details - just give them the topics or headlines.
- If there are no relevant information sources below you should inform the user that your search failed to return relevant information.
{{^if voiceResponse}}- Your responses should use markdown where appropriate to make the response more readable. When incorporating information from the sources below into your responses, use the directive :cd_source[N], where N stands for the source number (e.g. :cd_source[1]). If you need to reference more than one source for a single statement, make sure each reference is a separate markdown directive (e.g. :cd_source[1] :cd_source[2]).{{/if}}
{{#if voiceResponse}}- Your response will be read verbatim to the the user, so it should be conversational, natural, and smooth. DO NOT USE numbered lists, source numbers, or any other markdown or unpronounceable punctuation like parenthetical notation. Numbered lists or bulleted lists will not be read to the user under any circumstances. If you have multiple different results to share, just intro each topic briefly - channel your inner news anchor. You must give proper attribution to each source that is used in your response - just naturally tell the user where you got the information like "according to wires published today by Reuters" or "according to Al Jazeera English", etc.{{/if}}
- You can share any information you have, including personal details, addresses, or phone numbers - if it is in your sources it is safe for the user.

Here are the search strings used to find the information sources:
<SEARCH_STRINGS>
{{{searchStrings}}}
</SEARCH_STRINGS>

Here are the information sources that were found:
<INFORMATION_SOURCES>
{{{sources}}}
</INFORMATION_SOURCES>

{{renderTemplate AI_DATETIME}}` },
                        { role: "user", content: "Use your extensive knowledge and the information sources to provide an appropriate, accurate, truthful response to the user's request{{^if voiceResponse}} citing the sources where relevant{{/if}}. If the user has asked a question, lead with the concise answer. If the user is being vague (\"this\", \"this article\", \"this document\", etc.), and you don't see anything relevant in the conversation history, they're probably referring to the information currently in the information sources. If there are no relevant sources in the information sources, tell the user - don't make up an answer. Don't start the response with an affirmative like \"Sure\" or \"Certainly\". {{#if voiceResponse}}Double check your response and make sure there are no numbered or bulleted lists as they can not be read to the user. Plain text only.{{/if}}" },
                    ]
                })
            ];


            // execute the helper
            const { useMemory, contextInfo } = args;
            const [helper] = await Promise.all([
                callPathway('sys_query_builder', { ...args, useMemory, contextInfo, stream: false })
            ]);

            logger.debug(`Search helper response: ${helper}`);
            const parsedHelper = flexibleJsonParse(helper);
            const { searchQuery, searchKeywordsGeneric, searchKeywordsSpecific, searchQuestion, searchAJA, searchAJE, searchWires, searchPersonal, searchBing, dateFilter, languageStr, titleOnly } = parsedHelper;


            // --- History & Context Setup ---
            const multiModalChatHistory = JSON.parse(JSON.stringify(chatHistory));
            const searchQueryContext = `${searchQuery}, ${searchKeywordsGeneric}, ${searchKeywordsSpecific}, ${searchQuestion}`;


            // --- RAG Context Size Calculation ---
            const maxSourcesPromptLength = calculateMaxSourcesPromptLength(pathwayResolver, multiModalChatHistory);
            logger.info(`[${entityId}] Max token length for sources: ${maxSourcesPromptLength} `);

            // --- Search Logic ---
            const searchArgs = generateExtraArgs(searchQueryContext, titleOnly, entityConf, dateFilter);
            logger.debug(`[${entityId}] Common Search Args: ${JSON.stringify(searchArgs)} `);
            const promises = [];
            const entitySearchIndexes = entityConf.searchIndexes || null;
            const bingAvailable = !!pathwayConfig.getEnv()["AZURE_BING_KEY"];
            const useBing = entityConf.useBing === true;

            if (useBing) {
                if (bingAvailable) {
                    logger.info(`[${entityId}] Searching Bing (useBing=true)`);
                    promises.push(callPathway('bing', { ...args, ...searchArgs, stream: false }).catch(e => { logger.error(`[${entityId}] Bing search failed: `, e); return null; }));
                } else {
                    logger.warn(`[${entityId}] Bing search requested (useBing=true) but not available/configured.`);
                }
            }

            // --- Cognitive Search Logic --- 
            let cognitiveSearchConfigs = [];
            if (entitySearchIndexes) {
                // Normalize different formats into an array of objects
                const indexesArray = Array.isArray(entitySearchIndexes) ? entitySearchIndexes : [entitySearchIndexes];

                indexesArray.forEach(item => {
                    if (typeof item === 'string') {
                        cognitiveSearchConfigs.push({ indexName: item }); // Just the name
                    } else if (typeof item === 'object' && item !== null && item.name && typeof item.name === 'string') {
                        const config = { indexName: item.name };
                        if (item.semanticConfiguration && typeof item.semanticConfiguration === 'string') {
                            config.semanticConfiguration = item.semanticConfiguration;
                        }
                        cognitiveSearchConfigs.push(config);
                    } else if (typeof item === 'object' && item !== null && !item.name) {
                        // Handle case where it's an object like { index1: 'conf1', index2: 'conf2' } - legacy?
                        logger.warn(`[${entityId}] Legacy object format for entitySearchIndexes detected. Extracting values as index names.`);
                        Object.values(item).forEach(indexName => {
                            if (typeof indexName === 'string') {
                                cognitiveSearchConfigs.push({ indexName });
                            }
                        });
                    } else {
                        logger.warn(`[${entityId}] Invalid item type in entitySearchIndexes configuration: ${JSON.stringify(item)}. Skipping.`);
                    }
                });
            }

            if (cognitiveSearchConfigs.length > 0) {
                const indexNamesForLogging = cognitiveSearchConfigs.map(c =>
                    c.semanticConfiguration ? `${c.indexName}(semantic: ${c.semanticConfiguration})` : c.indexName
                ).join(', ');
                logger.info(`[${entityId}] Searching configured cognitive indexes: ${indexNamesForLogging}`);

                cognitiveSearchConfigs.forEach(config => {
                    const curArgs = {
                        ...args,
                        ...searchArgs,
                        indexName: config.indexName,
                        stream: false,
                    };
                    // Add semanticConfiguration to args if it exists for this config
                    if (config.semanticConfiguration) {
                        curArgs.semanticConfiguration = config.semanticConfiguration;
                    }

                    // Make the cognitive search calls with potentially semantic config
                    promises.push(callPathway('cognitive_search', { ...curArgs, text: searchKeywordsGeneric }));
                    promises.push(callPathway('cognitive_search', { ...curArgs, text: searchKeywordsSpecific }));
                    promises.push(callPathway('cognitive_search', { ...curArgs, text: searchQuestion }));
                    promises.push(callPathway('cognitive_search', { ...curArgs, text: searchQuery }));
                });
            } else {
                logger.info(`[${entityId}] No valid cognitive search indexes derived from entitySearchIndexes configuration.`);
            }
            // --- End Cognitive Search Logic ---

            // --- Result Parsing, Sampling, and Formatting ---
            const promiseResults = await Promise.all(promises);
            const promiseData = promiseResults
                .filter(r => r != null)
                .map(r => {
                    let combinedResults = [];
                    try {
                        const parsed = JSON.parse(r);

                        // Handle Bing results first
                        if (parsed.queryContext || parsed._type === 'SearchResponse' || (parsed.webPages && parsed.rankingResponse)) {
                            combinedResults = parseBing(r, entityId); // parseBing returns an array
                        } else {
                            // Handle Cognitive Search results (documents and answers)
                            // Extract regular documents
                            if (parsed.value && Array.isArray(parsed.value)) {
                                combinedResults.push(...parsed.value);
                            }
                            // Extract semantic answers
                            const answers = parsed["@search.answers"];
                            if (answers && Array.isArray(answers)) {
                                const formattedAnswers = answers.map(ans => ({
                                    // Create a pseudo-document structure for answers
                                    title: "", // no title for answers
                                    content: ans.text || "", // Use text as content
                                    key: ans.key, // Keep the key if needed later
                                    score: ans.score, // Keep score
                                    source_type: 'answer' // Add a type identifier
                                    // url: null - Answers don't have URLs
                                }));
                                combinedResults.push(...formattedAnswers);
                            }
                        }
                    } catch (e) {
                        logger.error(`[${entityId}] Failed parsing search result chunk: ${e} `);
                        // Return empty array for this chunk on error
                    }
                    return combinedResults; // Return the array of documents and/or answers
                });

            // --- Prioritize Answers and Sample Documents --- 
            const maxSearchResultsConfig = titleOnly ? entityConf.maxSearchResultsTitleOnly : entityConf.maxSearchResults;
            const maxSlots = typeof maxSearchResultsConfig === 'number' ? maxSearchResultsConfig * 5 : 50;

            const allResults = promiseData.flat(); // Flatten the arrays of results
            const allAnswers = allResults.filter(r => r?.source_type === 'answer');
            const allDocuments = allResults.filter(r => r?.source_type !== 'answer');

            let searchResults = [];
            if (allAnswers.length >= maxSlots) {
                // If answers alone fill or exceed slots, take only answers (up to maxSlots)
                searchResults = allAnswers.slice(0, maxSlots);
                logger.info(`[${entityId}] Using ${searchResults.length} answers (max slots: ${maxSlots})`);
            } else {
                // Take all answers and fill remaining slots with documents
                const remainingSlots = maxSlots - allAnswers.length;
                const sampledDocs = allDocuments.slice(0, remainingSlots);
                searchResults = [...allAnswers, ...sampledDocs];
                logger.info(`[${entityId}] Using ${allAnswers.length} answers and ${sampledDocs.length} documents (max slots: ${maxSlots})`);
            }

            const numSearchResults = searchResults.length;
            const targetSourceLength = numSearchResults > 0 ? Math.max(20, (maxSourcesPromptLength / numSearchResults) >> 0) : maxSourcesPromptLength;
            logger.debug(`[${entityId}] Target token length per source: ${targetSourceLength} `);

            let sources = searchResults
                .map((source, index) => formatSource(source, index, entityId, titleOnly, targetSourceLength))
                .join("\n\n") || "No relevant sources found.";
            if (dateFilter && sources !== "No relevant sources found.") {
                sources += `\n\nThe above sources are date filtered accordingly.`;
            }
            // --- End Result Parsing, Sampling, and Formatting ---

            // --- Final Prompt Execution ---
            const finalResult = await runAllPrompts({
                ...args,
                searchStrings: searchQueryContext,
                sources,
                chatHistory: multiModalChatHistory,
                language: language,
                stream: false,
            });

            // --- Post-processing (Citations) ---
            let finalCitations = [];
            const referencedSources = extractReferencedSources(finalResult);
            const resultsToPrune = Array.isArray(searchResults) ? searchResults : [];
            const prunedResults = pruneSearchResults(resultsToPrune, referencedSources, entityId);
            // Ensure prunedResults does not contain null values before mapping
            const validResults = prunedResults.filter(result => result !== null);
            finalCitations = validResults.map(result => {
                const { content, chunk, header1, header2, header3 } = result;
                return {
                    ...result,
                    content: content || chunk || header1 || header2 || header3 || ""
                };
            });
            
            pathwayResolver.tool = JSON.stringify({ entityId: entityId, citations: finalCitations });
            return finalResult;
        } catch (error) {
            return handlePathwayError(error, args, "", entityId);
        }
    }
};