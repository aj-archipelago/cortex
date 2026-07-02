import ModelPlugin from './modelPlugin.js';
import logger from '../../lib/logger.js';
import { config } from '../../config.js';

class BraveSearchPlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
    }

    getRequestParameters(text, parameters = {}, prompt) {
        const env = config.getEnv?.() || {};
        const apiKey = env.BRAVE_SEARCH_API_KEY
            || env.BRAVE_API_KEY
            || process.env.BRAVE_SEARCH_API_KEY
            || process.env.BRAVE_API_KEY;
        if (!apiKey) {
            throw new Error('BRAVE_SEARCH_API_KEY is not set in the environment variables!');
        }

        const {
            q,
            country,
            search_lang: searchLangSnake,
            searchLang,
            ui_lang: uiLangSnake,
            uiLang,
            count,
            offset,
            safesearch,
            freshness,
            text_decorations: textDecorationsSnake,
            textDecorations,
            spellcheck,
            result_filter: resultFilterSnake,
            resultFilter,
            goggles_id: gogglesIdSnake,
            gogglesId,
            units,
            extra_snippets: extraSnippetsSnake,
            extraSnippets,
            summary,
        } = parameters;

        const query = q || text || '';
        if (!query || query.trim() === '') {
            throw new Error('Brave Search requires a non-empty query parameter (q or text)');
        }

        const params = {
            q: query,
        };

        const addIfDefined = (key, value) => {
            if (value !== undefined && value !== '') params[key] = value;
        };

        addIfDefined('country', country);
        addIfDefined('search_lang', searchLangSnake ?? searchLang);
        addIfDefined('ui_lang', uiLangSnake ?? uiLang);
        addIfDefined('count', count);
        addIfDefined('offset', offset);
        addIfDefined('safesearch', safesearch);
        addIfDefined('freshness', freshness);
        addIfDefined('text_decorations', textDecorationsSnake ?? textDecorations);
        addIfDefined('spellcheck', spellcheck);
        addIfDefined('result_filter', resultFilterSnake ?? resultFilter);
        addIfDefined('goggles_id', gogglesIdSnake ?? gogglesId);
        addIfDefined('units', units);
        addIfDefined('extra_snippets', extraSnippetsSnake ?? extraSnippets);
        addIfDefined('summary', summary);

        return {
            data: [],
            headers: {
                'Accept': 'application/json',
                'Accept-Encoding': 'gzip',
                'X-Subscription-Token': apiKey,
            },
            params,
        };
    }

    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = this.getRequestParameters(text, parameters, prompt);

        cortexRequest.data = requestParameters.data;
        cortexRequest.headers = requestParameters.headers;
        cortexRequest.params = requestParameters.params;
        cortexRequest.method = 'GET';

        return this.executeRequest(cortexRequest);
    }

    parseResponse(data) {
        return JSON.stringify(data);
    }

    logRequestData(data, responseData, prompt) {
        const responseText = this.parseResponse(responseData);
        const { length, units } = this.getLength(responseText || '');
        logger.info(`[Brave Search response received containing ${length} ${units}]`);
        prompt && prompt.debugInfo && (prompt.debugInfo += `\n${JSON.stringify(data)}`);
    }
}

export default BraveSearchPlugin;
