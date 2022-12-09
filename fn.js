const { request } = require("./request");
const handlebars = require("handlebars");
const { parser, parseNumberedList } = require("./parser");
const { hasListReturn } = require("./util");

const getUrl = (config) => {
    const api = config.get('api');
    const urlFn = handlebars.compile(api.url);
    return urlFn({ ...api, ...config.getEnv() });
}

const getParams = (endpoint, text) => {
    const { temperature, prompt } = endpoint;
    const promptFn = handlebars.compile(prompt);

    const params = {
        prompt: promptFn({ ...endpoint, text }),
        max_tokens: 2048,
        // model: "text-davinci-002",
        temperature: temperature ?? 0.7,
        // "top_p": 1,
        // "n": 1,
        // "presence_penalty": 0,
        // "frequency_penalty": 0,
        // "best_of": 1,
    }

    // return { ...defaultParams, ...overrideParams };
    return params;
}

const fn = async ({ config, endpoint, parent, args, contextValue, info }) => {
    const { text } = args;
    const url = getUrl(config);
    const params = getParams(endpoint, text);

    const { temperature } = params;
    if (temperature == 0) {
        info.cacheControl.setCacheHint({ maxAge: 60 * 60 * 24, scope: 'PUBLIC' });
    }

    const api = config.get('api');
    const headers = {}
    for (const [key, value] of Object.entries(api.headers)) {
        headers[key] = handlebars.compile(value)({ ...config.getEnv() });
    }
    const data = await request({ url, params, headers });

    return endpoint.parser ? endpoint.parser(data) : hasListReturn(endpoint) ? parseNumberedList(data) : parser(data);
}   



module.exports = {
    fn
}