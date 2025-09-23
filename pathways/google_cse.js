// google_cse.js
// Google Custom Search pathway

export default {
    inputParameters: {
        text: ``,
        q: ``,
        num: 10,
        start: 1,
        safe: 'off', // 'off' | 'active'
        dateRestrict: '',
        siteSearch: '',
        siteSearchFilter: '', // 'e' | 'i'
        searchType: '', // 'image'
        gl: '',
        hl: '',
        lr: '',
        sort: '',
        exactTerms: '',
        excludeTerms: '',
        orTerms: '',
        fileType: ''
    },
    timeout: 400,
    enableDuplicateRequests: false,
    model: 'google-cse',
};
