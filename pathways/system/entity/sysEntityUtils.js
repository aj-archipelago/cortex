// pathways/system/entity/sysEntityUtils.js
// Utility functions specific to the sys_entity pathway execution logic.

import { callPathway, gpt3Encode, gpt3Decode, say } from '../../../lib/pathwayTools.js';
import logger from '../../../lib/logger.js';

const TOKEN_RATIO = 1.0; // Consider if this should be configurable or passed in

/**
 * Parses a JSON string that might have a prefix (like 'verbose: ')
 * or be enclosed in a markdown code block (```json ... ```).
 *
 * @param {string} inputString The string potentially containing JSON.
 * @returns {object|array} The parsed JavaScript object or array.
 * @throws {Error} If the input is not a string or if parsing fails after attempting cleanup.
 */
export function flexibleJsonParse(inputString) {
    if (typeof inputString !== 'string') {
        throw new Error("Input must be a string.");
    }

    let jsonStringToParse = inputString.trim();

    // 1. Check for and extract content within ```json ... ``` block
    const codeBlockMatch = jsonStringToParse.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (codeBlockMatch && codeBlockMatch[1]) {
        jsonStringToParse = codeBlockMatch[1].trim();
        // If extraction was successful, try parsing this directly
        try {
            return JSON.parse(jsonStringToParse);
        } catch (e) {
            // If parsing the extracted block fails, log it but proceed
            // to the next step as the original string might still be parsable.
            console.warn("Parsing extracted JSON code block failed, attempting fallback.", e.message);
            jsonStringToParse = inputString.trim(); // Reset to original for fallback
        }
    }

    // 2. Fallback: Find the first '{' or '[' if no code block was successfully parsed
    const objectStartIndex = jsonStringToParse.indexOf('{');
    const arrayStartIndex = jsonStringToParse.indexOf('[');

    let startIndex = -1;

    // Determine the earliest start index of a valid JSON structure
    if (objectStartIndex !== -1 && arrayStartIndex !== -1) {
        startIndex = Math.min(objectStartIndex, arrayStartIndex);
    } else if (objectStartIndex !== -1) {
        startIndex = objectStartIndex;
    } else {
        startIndex = arrayStartIndex; // Will be -1 if neither '{' nor '[' was found
    }

    if (startIndex !== -1) {
        // Extract the substring starting from the first '{' or '['
        jsonStringToParse = jsonStringToParse.substring(startIndex);
    } else {
        // If we didn't find a '{' or '[' even in the original string,
        // it's unlikely to be JSON. Throw an error.
        throw new Error("Could not find starting '{' or '[' in the input string.");
    }

    // 3. Attempt to parse the cleaned-up string (substring from '{'/'[')
    try {
        return JSON.parse(jsonStringToParse);
    } catch (e) {
        console.error("Original Input String (trimmed):", inputString.trim());
        console.error("Attempted to Parse String:", jsonStringToParse);
        throw new Error(`Failed to parse JSON after cleanup attempts: ${e.message}`);
    }
}

/**
 * Calculates max tokens for search results based on model limits and prompt content.
 * @param {object} pathwayResolver The pathway resolver instance.
 * @param {Array} multiModalChatHistory The chat history.
 * @param {number} [tokenRatio=TOKEN_RATIO] Ratio of max tokens to allocate.
 * @returns {number} Maximum allowed tokens for sources.
 */
export function calculateMaxSourcesPromptLength(pathwayResolver, multiModalChatHistory, tokenRatio = TOKEN_RATIO) {
    const baseSystemPrompt = pathwayResolver?.prompts[0]?.messages[0]?.content;
    const baseSystemPromptLength = baseSystemPrompt ? gpt3Encode(baseSystemPrompt).length : 0;
    const modelInfo = pathwayResolver.model;
    const modelMaxTokens = modelInfo?.maxTokenLength || 8000;
    const maxSystemPromptLength = (modelMaxTokens * tokenRatio * 0.90) >> 0;

    const lastUserMessage = multiModalChatHistory && multiModalChatHistory.length > 0 ? multiModalChatHistory[multiModalChatHistory.length - 1] : null;
    let userMostRecentTextLength = 0;
    if (lastUserMessage && lastUserMessage.role === 'user') {
        if (typeof lastUserMessage.content === 'string') {
            userMostRecentTextLength = gpt3Encode(lastUserMessage.content).length;
        } else if (Array.isArray(lastUserMessage.content)) {
            userMostRecentTextLength = lastUserMessage.content.reduce((sum, part) => {
                if (part.type === 'text') {
                    return sum + gpt3Encode(part.text || '').length;
                }
                return sum + 500; // Estimate for non-text
            }, 0);
        }
    }

    const maxSourcesLength = maxSystemPromptLength - baseSystemPromptLength - userMostRecentTextLength;

    if (maxSourcesLength <= 0) {
        logger.error(`No room for sources in system prompt. System: ${baseSystemPromptLength}, User: ${userMostRecentTextLength}, Max System Allowed: ${maxSystemPromptLength}, Model Max: ${modelMaxTokens}`);
        throw new Error(`Insufficient token space for search results (Max Sources Length: ${maxSourcesLength}).`);
    }
    logger.debug(`Calculated maxSourcesPromptLength: ${maxSourcesLength}`);
    return maxSourcesLength;
}

/**
 * Formats a single search result source, handling content truncation.
 * @param {object} source The source object.
 * @param {number} index The index of the source.
 * @param {string} entityId The entity ID for logging.
 * @param {boolean} titleOnly Whether to include only the title.
 * @param {number} targetSourceLength Target token length for the formatted source.
 * @returns {string} Formatted source string.
 */
export function formatSource(source, index, entityId, titleOnly, targetSourceLength) {
    const { title, content: originalContent, url, chunk, header1, header2, header3 } = source;
    let result = [`[source ${index + 1}]`];
    title && result.push(`title: ${title}`);
    url && result.push(`url: ${url}`);

    const content = originalContent || chunk || header1 || header2 || header3 || "";

    if (content && !titleOnly && typeof content === 'string') {
        try {
            let encodedContent = gpt3Encode(content);
            const prefixLength = gpt3Encode(result.join(" ")).length;
            const remainingSpace = targetSourceLength - prefixLength;

            if (remainingSpace <= 5) {
                // Content truncated
            } else if (encodedContent.length > remainingSpace) {
                const targetEncodeLength = remainingSpace - 3;
                if (targetEncodeLength > 0) {
                    encodedContent = encodedContent.slice(0, targetEncodeLength);
                    try {
                        result.push(`content: ${gpt3Decode(encodedContent)}...`);
                    } catch (decodeError) {
                        logger.warn(`[${entityId}] Could not decode truncated content for source ${index + 1}: ${decodeError.message}. Trying further slice.`);
                        try {
                            const fallbackLength = Math.max(0, targetEncodeLength - 10);
                            const safeContent = gpt3Decode(encodedContent.slice(0, fallbackLength));
                            result.push(`content: ${safeContent}...`);
                        } catch {
                            result.push(`content: [Content truncated due to encoding issues]`);
                        }
                    }
                } else {
                    result.push(`content: [Content truncated]`);
                }
            } else {
                result.push(`content: ${content}`);
            }
        } catch (encodeError) {
            logger.error(`[${entityId}] Error encoding content for source ${index + 1}: ${encodeError.message}`);
            result.push(`content: [Error processing content]`);
        }
    } else if (content && !titleOnly) {
        logger.warn(`[${entityId}] Source ${index + 1} has non-string content: ${typeof content}`);
        result.push(`content: [Invalid content format]`);
    }
    return result.join(" ").trim();
}

/**
 * Extracts referenced source numbers (e.g., :cd_source[N]) from text.
 * @param {string} text The text to parse.
 * @returns {Set<number>} A set of referenced source numbers.
 */
export function extractReferencedSources(text) {
    if (!text) return new Set();
    const regex = /:cd_source\[(\d+)\]/g; // Adjusted regex for potential markdown escaping
    const matches = text.match(regex);
    if (!matches) return new Set();
    // Extract the digit from each match (e.g., ":cd_source[1]" -> "1")
    return new Set(matches.map(match => parseInt(match.match(/\d+/)[0])));
}


/**
 * Prunes search results, keeping only those referenced in the final text.
 * @param {Array} searchResults The original array of search result objects.
 * @param {Set<number>} referencedSources A set of 1-based source indices that were referenced.
 * @param {string} entityId The entity ID for logging.
 * @returns {Array<object|null>} An array with referenced results or null placeholders.
 */
export function pruneSearchResults(searchResults, referencedSources, entityId) {
    if (!Array.isArray(searchResults)) {
        logger.warn(`[${entityId}] pruneSearchResults expected an array but received:`, searchResults);
        return [];
    }
    return searchResults.map((result, index) =>
        referencedSources.has(index + 1) ? result : null
    );
}

/**
 * Parses a Bing search API response string into a simplified result format.
 * @param {string} response The JSON response string from Bing API.
 * @param {string} entityId The entity ID for logging.
 * @returns {Array<object>} An array of { title, url, content } objects.
 */
export function parseBing(response, entityId) {
    try {
        const parsedResponse = JSON.parse(response);
        const results = [];
        if (parsedResponse.webPages && parsedResponse.webPages.value) {
            results.push(...parsedResponse.webPages.value.map(({ name, url, snippet }) => ({ title: name, url, content: snippet })));
        }
        // Consider adding parsing for other types like news, images if needed
        return results;
    } catch (e) {
        logger.error(`[${entityId}] Failed to parse Bing response: ${e} `);
        return [];
    }
}

/**
 * Samples search results proportionally from different sources (promises).
 * Note: This implementation prioritizes filling slots over strict proportionality if rounding causes issues.
 * @param {Array<Array<object>>} promiseData An array where each element is an array of search results from a source.
 * @param {number} maxSearchResults The maximum total number of results desired.
 * @param {string} entityId The entity ID for logging.
 * @returns {Array<object>} The combined and sampled array of search results.
 */
export function sampleSearchResults(promiseData, maxSearchResults, entityId) {
    let sampledResults = [];
    const validPromiseData = promiseData.filter(Array.isArray);
    let totalLength = validPromiseData.reduce((sum, data) => sum + data.length, 0);
    const maxSlots = typeof maxSearchResults === 'number' ? maxSearchResults : 50; // Default max
    let remainingSlots = maxSlots;

    // Distribute slots based on proportion
    const slotsPerSource = validPromiseData.map(data => {
        if (data.length === 0 || totalLength === 0) return 0;
        const proportion = data.length / totalLength;
        return Math.round(proportion * maxSlots);
    });

    // Adjust slots if rounding caused over/under allocation
    let currentTotalSlots = slotsPerSource.reduce((sum, s) => sum + s, 0);
    let diff = maxSlots - currentTotalSlots;

    // Distribute difference (prioritize sources with results)
    let sourceIndices = validPromiseData.map((_, i) => i).filter(i => validPromiseData[i].length > 0);
    let idx = 0;
    while (diff !== 0 && sourceIndices.length > 0) {
        const currentSourceIdx = sourceIndices[idx % sourceIndices.length];
        if (diff > 0) { // Need more slots
            // Only add if source has more items than allocated slots
            if (validPromiseData[currentSourceIdx].length > slotsPerSource[currentSourceIdx]) {
                slotsPerSource[currentSourceIdx]++;
                diff--;
            } else {
                // Remove this source from consideration for adding slots
                sourceIndices = sourceIndices.filter(i => i !== currentSourceIdx);
                if (sourceIndices.length === 0) break; // No more sources to add to
                idx = idx % sourceIndices.length; // Adjust index
                continue; // Skip incrementing idx for this iteration
            }
        } else { // Have too many slots
            if (slotsPerSource[currentSourceIdx] > 0) {
                slotsPerSource[currentSourceIdx]--;
                diff++;
            }
            // No need to remove source here, can always reduce if slots > 0
        }
        idx++;
    }


    // Sample from each source based on calculated slots
    validPromiseData.forEach((data, i) => {
        const numToTake = Math.min(slotsPerSource[i], data.length, remainingSlots);
        if (numToTake > 0) {
            sampledResults.push(...data.slice(0, numToTake));
            remainingSlots -= numToTake;
        }
    });

    // Final trim if needed due to edge cases
    sampledResults = sampledResults.slice(0, maxSlots);
    logger.info(`[${entityId}] Sampled ${sampledResults.length} results (max: ${maxSlots})`);
    return sampledResults;
}


/**
 * Generates extra arguments common to search pathway calls.
 * @param {string} searchText The text query for the search.
 * @param {boolean} titleOnly Whether to request only titles.
 * @param {object} entityConf The entity configuration object.
 * @param {string|null} dateFilter Optional date filter string.
 * @returns {object} An object containing search arguments { text, top, titleOnly, filter? }.
 */
export function generateExtraArgs(searchText, titleOnly, entityConf, dateFilter) {
    const topResults = titleOnly ? entityConf.maxSearchResultsTitleOnly : entityConf.maxSearchResults;
    // Add a fallback default if entityConf values are undefined/null
    const top = typeof topResults === 'number' && topResults > 0 ? topResults : 50;
    const searchArgs = { text: searchText, top: top, titleOnly: titleOnly };
    if (dateFilter) {
        searchArgs.filter = dateFilter;
    }
    return searchArgs;
}

/**
 * Manages sending periodic filler messages for voice responses while waiting for the main result.
 * @param {object} resolver The pathway resolver instance.
 * @param {object} args The pathway arguments.
 * @param {boolean} effectiveVoiceResponse Whether voice response is enabled.
 * @param {string} lastUserMessageText Text of the last user message for context.
 * @param {string} entityId The entity ID for logging.
 * @returns {Promise<NodeJS.Timeout|null>} A promise resolving to the timeout ID, or null if not applicable.
 */
export async function manageFillerMessages(resolver, args, effectiveVoiceResponse, lastUserMessageText, entityId) {
    let timeoutId = null;
    if (!effectiveVoiceResponse) {
        return null; // Return null immediately if no voice response needed
    }

    let fillerResponses = [];
    try {
        // Ensure contextInfo is passed correctly if needed by sys_generator_voice_filler
        const fillerArgs = { ...args, contextInfo: lastUserMessageText, stream: false };
        const voiceFillerStrings = await callPathway('sys_generator_voice_filler', fillerArgs);
        fillerResponses = JSON.parse(voiceFillerStrings);
    } catch (e) {
        logger.error(`[${entityId}] Error parsing voice filler responses`, e);
    }
    // Provide more robust default fillers
    if (!Array.isArray(fillerResponses) || fillerResponses.length === 0) {
        fillerResponses = [
            "Okay, let me check that for you.",
            "Working on finding that information now.",
            "Just a moment while I gather the details.",
            "Searching for the latest updates...",
            "Processing your request..."
        ];
    }

    const calculateFillerTimeout = (fillerIndex) => {
        // Shorter initial delay, slightly longer subsequent delays
        const baseTimeout = fillerIndex === 0 ? 3000 : 5000; // Start sooner
        const randomFactor = Math.random() * 2000; // Add some variability
        return baseTimeout + randomFactor;
    };

    let fillerIndex = 0;
    const sendFillerMessage = async () => {
        // Check if still relevant - this relies on clearTimeout in the main pathway
        // If the main pathway finishes quickly, this might still fire once.
        if (fillerResponses.length > 0) {
            const message = fillerResponses[fillerIndex % fillerResponses.length];
            logger.debug(`[${entityId}] Sending filler message: "${message}"`);
            await say(resolver.rootRequestId, message, 100); // Consider priority
            fillerIndex++;
            // Schedule the next one
            timeoutId = setTimeout(sendFillerMessage, calculateFillerTimeout(fillerIndex));
            // Store the active timeout ID so it can be cleared
            resolver.currentFillerTimeoutId = timeoutId;
        }
    };

    // Start the first filler message
    timeoutId = setTimeout(sendFillerMessage, calculateFillerTimeout(fillerIndex));
    resolver.currentFillerTimeoutId = timeoutId; // Store initial ID
    return timeoutId; // Return the initial timeout ID
}


/**
 * Handles errors during pathway execution, attempting to call the error generator pathway.
 * @param {Error} error The error object caught.
 * @param {object} args The original pathway arguments.
 * @param {boolean} effectiveVoiceResponse Whether voice response was enabled.
 * @param {string} entityId The entity ID for logging.
 * @returns {Promise<string>} A promise resolving to the error message string (either from generator or fallback).
 */
export async function handlePathwayError(error, args, effectiveVoiceResponse, entityId) {
    logger.error(`Error in sys_entity pathway[${entityId}]: ${error.stack || error} `);
    try {
        const errorArgs = {
            ...args,
            text: JSON.stringify(error.message || String(error)), // Ensure text is always a string
            voiceResponse: effectiveVoiceResponse,
            stream: false
        };
        const errorResult = await callPathway('sys_generator_error', errorArgs);
        // Attempt to parse if it looks like JSON, otherwise return as is
        try {
            const parsedResult = JSON.parse(errorResult);
            // Handle potential nested structure if error generator returns JSON object
            return typeof parsedResult === 'object' && parsedResult !== null && parsedResult.result
                ? String(parsedResult.result)
                : String(errorResult);
        } catch {
            return String(errorResult); // Return as string if not valid JSON
        }
    } catch (errorGenError) {
        logger.error(`[${entityId}] Failed to call sys_generator_error: ${errorGenError.stack || errorGenError} `);
        // Provide a user-friendly fallback message
        return "I encountered an issue while processing your request and couldn't generate a specific error message. Please try again.";
    }
} 