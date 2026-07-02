// brave_search.js
// Brave Search API pathway.

export default {
    inputParameters: {
        text: '',
        q: '',
        country: '',
        search_lang: '',
        searchLang: '',
        ui_lang: '',
        uiLang: '',
        count: 10,
        offset: 0,
        safesearch: 'moderate',
        freshness: '',
        text_decorations: false,
        textDecorations: false,
        spellcheck: true,
        result_filter: '',
        resultFilter: '',
        goggles_id: '',
        gogglesId: '',
        units: '',
        extra_snippets: false,
        extraSnippets: false,
        summary: false,
    },
    timeout: 400,
    enableDuplicateRequests: false,
    model: 'brave-search',
};
