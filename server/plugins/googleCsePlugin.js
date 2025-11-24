import ModelPlugin from './modelPlugin.js';
import logger from '../../lib/logger.js';
import { config } from '../../config.js';

class GoogleCsePlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
    }

    getRequestParameters(text, parameters = {}, prompt) {
        const env = config.getEnv();
        const apiKey = env["GOOGLE_CSE_KEY"];
        const cxEnv = env["GOOGLE_CSE_CX"];

        if (!apiKey) {
            throw new Error("GOOGLE_CSE_KEY is not set in the environment variables!");
        }
        const cxParam = parameters.cx || cxEnv;
        if (!cxParam) {
            throw new Error("GOOGLE_CSE_CX is not set in the environment variables!");
        }

        const {
            q,                // query string
            num,              // number of results (1..10)
            start,            // start index for paging
            safe,             // 'off' or 'active'
            dateRestrict,     // e.g., 'd1', 'w1', 'm1', 'y1'
            siteSearch,       // restrict to site/domain
            siteSearchFilter, // 'e' to exclude or 'i' to include
            searchType,       // 'image' for image results
            gl,               // country code
            hl,               // interface language
            lr,               // language restrict, e.g., 'lang_en'
            sort,             // sorting expression
            exactTerms,       // required terms
            excludeTerms,     // terms to exclude
            orTerms,          // alternative terms
            fileType,         // restrict by filetype
        } = parameters;

        const query = q || text || '';
        if (!query || query.trim() === '') {
            throw new Error("Google Custom Search requires a non-empty query parameter (q or text)");
        }

        const params = {
            key: apiKey,
            cx: cxParam,
            q: query,
        };

        // Add optional parameters if present
        if (num !== undefined) params.num = num;
        if (start !== undefined) params.start = start;
        if (safe) params.safe = safe; // 'off' | 'active'
        if (dateRestrict) params.dateRestrict = dateRestrict;
        if (siteSearch) params.siteSearch = siteSearch;
        if (siteSearchFilter) params.siteSearchFilter = siteSearchFilter; // 'e' | 'i'
        if (searchType) params.searchType = searchType; // 'image'
        if (gl) params.gl = gl;
        if (hl) params.hl = hl;
        if (lr) params.lr = lr;
        if (sort) params.sort = sort;
        if (exactTerms) params.exactTerms = exactTerms;
        if (excludeTerms) params.excludeTerms = excludeTerms;
        if (orTerms) params.orTerms = orTerms;
        if (fileType) params.fileType = fileType;

        return {
            data: [],
            params
        };
    }

    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = this.getRequestParameters(text, parameters, prompt);

        cortexRequest.data = requestParameters.data;
        cortexRequest.params = requestParameters.params;
        cortexRequest.method = 'GET';
        // URL already points to https://www.googleapis.com/customsearch/v1

        return this.executeRequest(cortexRequest);
    }

    parseResponse(data) {
        // Return raw JSON string for the pathway/tool to parse
        return JSON.stringify(data);
    }

    logRequestData(data, responseData, prompt) {
        // Keep verbose logging consistent
        logger.verbose(`${this.parseResponse(responseData)}`);
        prompt && prompt.debugInfo && (prompt.debugInfo += `\n${JSON.stringify(data)}`);
    }
}

export default GoogleCsePlugin;
