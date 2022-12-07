const { config } = require("./config");
const { request } = require("./request");
const handlebars = require("handlebars");
const { parser, parseNumberedList } = require("./parser");
const { hasListReturn } = require("./util");

const endpoints = config.get('endpoints');
const endpointNames = Object.keys(endpoints);


const getUrl = (endpointName) => {
    const endpoint = endpoints[endpointName];
    // if (config.get('')) // 'AZURE-OAI
    const api = config.get('API');
    const urlFn = handlebars.compile(api.url);
    return urlFn({ ...api, ...config.getEnv() });
}

const getParams = (endpointName, text) => {
    const endpoint = endpoints[endpointName];
    const { temperature, prompt } = endpoint;
    const promptFn = handlebars.compile(endpoint.prompt);

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

const fn = async (endpointName, args, info) => {
    const { text } = args;
    const url = getUrl(endpointName);
    const params = getParams(endpointName, text);

    const { temperature } = params;
    if (temperature == 0) {
        info.cacheControl.setCacheHint({ maxAge: 60 * 60 * 24, scope: 'PUBLIC' });
    }

    const api = config.get('API');
    const headers = {}
    for (const [key, value] of Object.entries(api.headers)) {
        headers[key] = handlebars.compile(value)({ ...config.getEnv() });
    }
    //f()
    const data = await request({ url, params, headers });

    if (hasListReturn(endpoints[endpointName])) {
        return parseNumberedList(data);
    }
    return parser(data);
}

const fns = {};
for (const endpointName of endpointNames) {
    fns[endpointName] = (parent, args, contextValue, info) => fn(endpointName, args, info);
}

module.exports = {
    fns
}