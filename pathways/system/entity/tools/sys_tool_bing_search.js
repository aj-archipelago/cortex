// sys_tool_bing_search.js
// Agent tool wrapper for the Azure Foundry Bing hosted-agent Responses endpoint.

import { callPathway } from '../../../../lib/pathwayTools.js';
import logger from '../../../../lib/logger.js';
import { getSearchResultId } from '../../../../lib/util.js';

const asInteger = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : NaN;
};

const stripCodeFence = (text) => {
    const trimmed = String(text || '').trim();
    const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    return match ? match[1].trim() : trimmed;
};

const extractJsonCandidate = (text) => {
    const stripped = stripCodeFence(text);
    if (!stripped) return '';

    const direct = stripped.trim();
    if (direct.startsWith('{') || direct.startsWith('[')) {
        return direct;
    }

    const firstObject = direct.indexOf('{');
    const lastObject = direct.lastIndexOf('}');
    if (firstObject !== -1 && lastObject > firstObject) {
        return direct.slice(firstObject, lastObject + 1);
    }

    const firstArray = direct.indexOf('[');
    const lastArray = direct.lastIndexOf(']');
    if (firstArray !== -1 && lastArray > firstArray) {
        return direct.slice(firstArray, lastArray + 1);
    }

    return '';
};

const parseJsonIfPresent = (text) => {
    const candidate = extractJsonCandidate(text);
    if (!candidate) return null;

    try {
        return JSON.parse(candidate);
    } catch {
        return null;
    }
};

const resultContent = (result) => (
    result.content
    || result.snippet
    || result.description
    || result.summary
    || ''
);

const normalizeResult = (result) => {
    if (!result || typeof result !== 'object') return null;

    const url = result.url || result.link || result.href || '';
    const title = result.title || result.name || url;
    const content = resultContent(result);

    if (!title && !url && !content) return null;

    return {
        searchResultId: getSearchResultId(),
        title,
        url,
        content,
    };
};

const getStructuredResults = (parsed) => {
    if (Array.isArray(parsed)) return parsed;
    if (!parsed || typeof parsed !== 'object') return [];

    if (Array.isArray(parsed.results)) return parsed.results;
    if (Array.isArray(parsed.value)) return parsed.value;
    if (Array.isArray(parsed.items)) return parsed.items;
    if (Array.isArray(parsed.web?.results)) return parsed.web.results;

    return [];
};

const cleanMarkdownText = (text) => (
    String(text || '')
        .replace(/\*\*/g, '')
        .replace(/^\s*\d+[.)]\s*/, '')
        .replace(/^\s*[-*]\s+/, '')
        .replace(/\s+/g, ' ')
        .trim()
);

const normalizeUrl = (url) => String(url || '').replace(/[.,;:)]+$/g, '');

const extractMarkdownLinkResults = (text) => {
    const lines = String(text || '').split(/\r?\n/);
    const results = [];
    const seen = new Set();
    const markdownLinkRegex = /\[([^\]]+)]\((https?:\/\/[^)\s]+)\)/g;

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        let match;

        while ((match = markdownLinkRegex.exec(line)) !== null) {
            const title = cleanMarkdownText(match[1]);
            const url = normalizeUrl(match[2]);
            if (!url || seen.has(url)) continue;

            const lineWithoutLink = cleanMarkdownText(line.replace(match[0], ''));
            const nextLine = lines.slice(index + 1).find((candidate) => cleanMarkdownText(candidate));
            const content = lineWithoutLink || cleanMarkdownText(nextLine || title);

            seen.add(url);
            results.push({
                searchResultId: getSearchResultId(),
                title: title || url,
                url,
                content,
            });
        }
    }

    return results;
};

const extractPlainUrlResults = (text) => {
    const lines = String(text || '').split(/\r?\n/);
    const results = [];
    const seen = new Set();
    const urlRegex = /(https?:\/\/[^\s)\]]+)/g;

    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const matches = [...line.matchAll(urlRegex)];

        for (const match of matches) {
            const url = normalizeUrl(match[1]);
            if (!url || seen.has(url)) continue;

            const previousLine = index > 0 ? cleanMarkdownText(lines[index - 1]) : '';
            const content = cleanMarkdownText(line.replace(match[0], ''));

            seen.add(url);
            results.push({
                searchResultId: getSearchResultId(),
                title: previousLine || url,
                url,
                content,
            });
        }
    }

    return results;
};

export const normalizeBingAgentResults = (agentText, query = '') => {
    const parsed = parseJsonIfPresent(agentText);
    const structuredResults = getStructuredResults(parsed)
        .map(normalizeResult)
        .filter(Boolean);

    if (structuredResults.length > 0) {
        return structuredResults;
    }

    const markdownResults = extractMarkdownLinkResults(agentText);
    if (markdownResults.length > 0) {
        return markdownResults;
    }

    const plainUrlResults = extractPlainUrlResults(agentText);
    if (plainUrlResults.length > 0) {
        return plainUrlResults;
    }

    const content = cleanMarkdownText(agentText);
    if (!content) return [];

    return [{
        searchResultId: getSearchResultId(),
        title: query ? `Bing search results for: ${query}` : 'Bing search results',
        url: '',
        content,
    }];
};

function validateParameters(args) {
    if (!args.q || typeof args.q !== 'string' || args.q.trim() === '') {
        return "Parameter 'q' or alias 'query' is required and must be a non-empty string.";
    }

    const count = asInteger(args.count, 10);
    if (!Number.isInteger(count) || count < 1 || count > 25) {
        return "Parameter 'count' must be an integer between 1 and 25.";
    }

    return null;
}

export default {
    prompt: [],
    timeout: 300,
    inputParameters: {
        q: '',
        query: '',
        count: 10,
        freshness: 'week',
        market: 'en-us',
        set_lang: 'en',
        userMessage: '',
    },
    toolDefinition: {
        enabled: false,
        type: 'function',
        icon: '🧭',
        function: {
            name: 'SearchInternetBing',
            description: 'Search the internet with the Bing hosted agent for current web results. This is a backup internet search tool for Google CSE and returns normalized citation-friendly results.',
            parameters: {
                type: 'object',
                properties: {
                    q: {
                        type: 'string',
                        description: 'The complete query to pass to the Bing hosted search agent.',
                    },
                    query: {
                        type: 'string',
                        description: 'Alias for q. Use either q or query for the search string.',
                    },
                    count: {
                        type: 'integer',
                        description: 'Number of results to return, from 1 to 25. Default 10.',
                    },
                    freshness: {
                        type: 'string',
                        description: "Freshness preference for the search, such as 'day', 'week', or 'month'.",
                    },
                    market: {
                        type: 'string',
                        description: "Market preference for search results, such as 'en-us'.",
                    },
                    set_lang: {
                        type: 'string',
                        description: "Language preference for search results, such as 'en'.",
                    },
                    userMessage: {
                        type: 'string',
                        description: "A user-friendly message that describes what you're doing with this tool.",
                    },
                },
                required: [],
            },
        },
    },

    executePathway: async ({ args, resolver }) => {
        const normalizedArgs = {
            ...args,
            q: args.q || args.query,
            count: asInteger(args.count, 10),
        };

        const validationError = validateParameters(normalizedArgs);
        if (validationError) {
            logger.error(`Bing hosted-agent search parameter validation failed: ${validationError}`);
            return JSON.stringify({
                error: validationError,
                recoveryMessage: 'Please correct the parameter format and try again.',
            });
        }

        try {
            const response = await callPathway('bing_afagent_search_results', {
                ...normalizedArgs,
                text: normalizedArgs.q,
            }, resolver);

            if (resolver.errors && resolver.errors.length > 0) {
                const errorMessages = Array.isArray(resolver.errors)
                    ? resolver.errors.map((err) => err.message || err)
                    : [resolver.errors.message || resolver.errors];
                return JSON.stringify({
                    error: errorMessages.join('; '),
                    recoveryMessage: 'This tool failed. You should try another internet search tool.',
                });
            }

            if (!response) {
                logger.error('Bing hosted-agent search returned null response');
                return JSON.stringify({
                    error: 'No response received from Bing hosted-agent search',
                    recoveryMessage: 'This tool failed. You should try another internet search tool.',
                });
            }

            let parsedResponse;
            try {
                parsedResponse = JSON.parse(response);
            } catch (parseError) {
                logger.error(`Failed to parse Bing hosted-agent response envelope: ${parseError.message}`);
                return JSON.stringify({
                    error: `Invalid response format from Bing hosted-agent search: ${parseError.message}`,
                    recoveryMessage: 'This tool failed. You should try another internet search tool.',
                });
            }

            if (parsedResponse.error || parsedResponse.Error) {
                const errorValue = parsedResponse.error || parsedResponse.Error;
                const errorMessage = typeof errorValue === 'object'
                    ? errorValue.message || JSON.stringify(errorValue)
                    : errorValue;
                logger.error(`Bing hosted-agent search error: ${errorMessage}`);
                return JSON.stringify({
                    error: errorMessage,
                    recoveryMessage: 'This tool failed. You should try another internet search tool.',
                });
            }

            const agentText = typeof parsedResponse.value === 'string'
                ? parsedResponse.value
                : JSON.stringify(parsedResponse.value ?? parsedResponse);

            resolver.tool = JSON.stringify({ toolUsed: 'BingHostedAgentSearch' });
            return JSON.stringify({
                _type: 'SearchResponse',
                value: normalizeBingAgentResults(agentText, normalizedArgs.q),
            });
        } catch (error) {
            const errorMessage = error?.message || error?.toString() || String(error);
            logger.error(`Error in Bing hosted-agent search: ${errorMessage}`);
            return JSON.stringify({
                error: errorMessage,
                recoveryMessage: 'This tool failed. You should try another internet search tool.',
            });
        }
    },
};
