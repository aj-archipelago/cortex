// sys_tool_brave_search.js
// Agent tool wrapper for Brave Search.
import { callPathway } from '../../../../lib/pathwayTools.js';
import logger from '../../../../lib/logger.js';
import { config } from '../../../../config.js';
import { getSearchResultId } from '../../../../lib/util.js';

const asInteger = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isInteger(parsed) ? parsed : NaN;
};

const asBoolean = (value) => {
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
};

const normalizeResultFilter = (value) => {
    if (Array.isArray(value)) return value.join(',');
    return value;
};

function validateParameters(args) {
    if (!args.q || typeof args.q !== 'string' || args.q.trim() === '') {
        return "Parameter 'q' or alias 'query' is required and must be a non-empty string.";
    }

    const count = asInteger(args.count, 10);
    if (!Number.isInteger(count) || count < 1 || count > 20) {
        return "Parameter 'count' must be an integer between 1 and 20.";
    }

    const offset = asInteger(args.offset, 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 9) {
        return "Parameter 'offset' must be an integer between 0 and 9.";
    }

    if (args.country && (typeof args.country !== 'string' || !/^[a-z]{2}$/i.test(args.country))) {
        return "Parameter 'country' must be a two-letter country code.";
    }

    const searchLang = args.search_lang || args.searchLang;
    if (searchLang && (typeof searchLang !== 'string' || !/^[a-z]{2}$/i.test(searchLang))) {
        return "Parameter 'search_lang' must be a two-letter language code.";
    }

    const uiLang = args.ui_lang || args.uiLang;
    if (uiLang && (typeof uiLang !== 'string' || !/^[a-z]{2}(?:-[A-Z]{2})?$/.test(uiLang))) {
        return "Parameter 'ui_lang' must be a locale like 'en' or 'en-US'.";
    }

    if (args.safesearch && !['off', 'moderate', 'strict'].includes(args.safesearch)) {
        return "Parameter 'safesearch' must be 'off', 'moderate', or 'strict'.";
    }

    if (args.units && !['metric', 'imperial'].includes(args.units)) {
        return "Parameter 'units' must be 'metric' or 'imperial'.";
    }

    const resultFilter = normalizeResultFilter(args.result_filter || args.resultFilter);
    if (resultFilter && typeof resultFilter !== 'string') {
        return "Parameter 'result_filter' must be a comma-separated string or array.";
    }

    return null;
}

const resultContent = (result) => (
    [
        result.description,
        ...(Array.isArray(result.extra_snippets) ? result.extra_snippets : []),
    ].filter(Boolean).join('\n')
);

const normalizeBraveResults = (parsedResponse) => {
    const groups = [
        ['web', parsedResponse?.web?.results],
        ['news', parsedResponse?.news?.results],
        ['video', parsedResponse?.videos?.results],
    ];
    const seen = new Set();
    const results = [];

    for (const [sourceType, values] of groups) {
        for (const item of Array.isArray(values) ? values : []) {
            const url = item.url || item.link || '';
            const title = item.title || '';
            const key = url || `${title}:${item.age || item.page_age || ''}`;
            if (!key || seen.has(key)) continue;
            seen.add(key);
            results.push({
                searchResultId: getSearchResultId(),
                title,
                url,
                content: resultContent(item),
                sourceType,
                age: item.age || '',
                pageAge: item.page_age || '',
                familyFriendly: item.family_friendly,
                language: item.language || '',
            });
        }
    }

    return results;
};

export default {
    prompt: [],
    timeout: 300,
    inputParameters: {
        q: '',
        query: '',
        count: 10,
        offset: 0,
        country: '',
        search_lang: '',
        searchLang: '',
        ui_lang: '',
        uiLang: '',
        safesearch: 'moderate',
        freshness: '',
        result_filter: '',
        resultFilter: '',
        text_decorations: false,
        textDecorations: false,
        spellcheck: true,
        extra_snippets: false,
        extraSnippets: false,
        summary: false,
        units: '',
        userMessage: '',
    },
    toolDefinition: {
        enabled: false,
        type: 'function',
        icon: '🌐',
        function: {
            name: 'SearchInternetBrave',
            description: 'Search the internet with Brave Search for current web and news results. This is a backup internet search tool for Google CSE and returns normalized citation-friendly results.',
            parameters: {
                type: 'object',
                properties: {
                    q: {
                        type: 'string',
                        description: 'The complete query to pass to Brave Search.',
                    },
                    query: {
                        type: 'string',
                        description: 'Alias for q. Use either q or query for the search string.',
                    },
                    count: {
                        type: 'integer',
                        description: 'Number of results to return, from 1 to 20. Default 10.',
                    },
                    offset: {
                        type: 'integer',
                        description: 'Pagination offset from 0 to 9. Default 0.',
                    },
                    country: {
                        type: 'string',
                        description: "Two-letter country code for result locality, such as 'us' or 'gb'.",
                    },
                    search_lang: {
                        type: 'string',
                        description: "Two-letter language code for search results, such as 'en' or 'ar'.",
                    },
                    ui_lang: {
                        type: 'string',
                        description: "UI locale for Brave Search, such as 'en' or 'en-US'.",
                    },
                    safesearch: {
                        type: 'string',
                        description: "Safe search setting: 'off', 'moderate', or 'strict'.",
                    },
                    freshness: {
                        type: 'string',
                        description: "Freshness filter, such as 'pd', 'pw', 'pm', 'py', or a Brave-supported date range.",
                    },
                    result_filter: {
                        type: 'string',
                        description: "Comma-separated Brave result filters, such as 'web' or 'web,news'.",
                    },
                    extra_snippets: {
                        type: 'boolean',
                        description: 'Whether to request extra snippets when available.',
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
            offset: asInteger(args.offset, 0),
            result_filter: normalizeResultFilter(args.result_filter || args.resultFilter),
            text_decorations: asBoolean(args.text_decorations ?? args.textDecorations),
            extra_snippets: asBoolean(args.extra_snippets ?? args.extraSnippets),
            spellcheck: asBoolean(args.spellcheck),
            summary: asBoolean(args.summary),
        };

        const validationError = validateParameters(normalizedArgs);
        if (validationError) {
            logger.error(`Brave Search parameter validation failed: ${validationError}`);
            return JSON.stringify({
                error: validationError,
                recoveryMessage: 'Please correct the parameter format and try again.',
            });
        }

        const env = config.getEnv?.() || {};
        if (!env.BRAVE_SEARCH_API_KEY
            && !env.BRAVE_API_KEY
            && !process.env.BRAVE_SEARCH_API_KEY
            && !process.env.BRAVE_API_KEY) {
            logger.error('Brave Search is not available - missing BRAVE_SEARCH_API_KEY');
            return JSON.stringify({
                error: 'Brave Search is not available - missing BRAVE_SEARCH_API_KEY',
                recoveryMessage: 'This tool is not configured. You should try a different search tool.',
            });
        }

        try {
            const response = await callPathway('brave_search', {
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
                logger.error('Brave Search returned null response');
                return JSON.stringify({
                    error: 'No response received from Brave Search',
                    recoveryMessage: 'This tool failed. You should try another internet search tool.',
                });
            }

            let parsedResponse;
            try {
                parsedResponse = JSON.parse(response);
            } catch (parseError) {
                logger.error(`Failed to parse Brave Search response: ${parseError.message}`);
                return JSON.stringify({
                    error: `Invalid response format from Brave Search: ${parseError.message}`,
                    recoveryMessage: 'This tool failed. You should try another internet search tool.',
                });
            }

            if (parsedResponse.error || parsedResponse.Error) {
                const errorValue = parsedResponse.error || parsedResponse.Error;
                const errorMessage = typeof errorValue === 'object'
                    ? errorValue.message || JSON.stringify(errorValue)
                    : errorValue;
                logger.error(`Brave Search API error: ${errorMessage}`);
                return JSON.stringify({
                    error: errorMessage,
                    recoveryMessage: 'This tool failed. You should try another internet search tool.',
                });
            }

            resolver.tool = JSON.stringify({ toolUsed: 'BraveSearch' });
            return JSON.stringify({ _type: 'SearchResponse', value: normalizeBraveResults(parsedResponse) });
        } catch (error) {
            const errorMessage = error?.message || error?.toString() || String(error);
            logger.error(`Error in Brave Search: ${errorMessage}`);
            return JSON.stringify({
                error: errorMessage,
                recoveryMessage: 'This tool failed. You should try another internet search tool.',
            });
        }
    },
};
