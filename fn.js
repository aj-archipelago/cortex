// Default resolver for all pathways

const { request } = require("./request");
const handlebars = require("handlebars");
const { getStringFromResponse, parseNumberedList } = require("./parser");
const { hasListReturn } = require("./util");
const { Exception } = require("handlebars");

const getUrl = (config, model) => {
    const generateUrl = handlebars.compile(model.url);
    return generateUrl({ ...model, ...config.getEnv() });
}

const getParams = (pathway, text) => {
    const { temperature, prompt } = pathway;
    const promptFn = handlebars.compile(prompt);

    const params = {
        prompt: promptFn({ ...pathway, text }),
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

const resolver = async ({ config, pathway, parent, args, contextValue, info }) => {
    const { text } = args;

    async function makeRequest(text) {
        const defaultModel = config.get('default_model')
        const model = config.get('models')[pathway.model || defaultModel];

        const url = getUrl(config, model);
        const params = getParams(pathway, text);

        const { temperature } = params;
        if (temperature == 0) {
            info.cacheControl.setCacheHint({ maxAge: 60 * 60 * 24, scope: 'PUBLIC' });
        }

        const headers = {};
        for (const [key, value] of Object.entries(model.headers)) {
            headers[key] = handlebars.compile(value)({ ...config.getEnv() });
        }
        const defaultParams = model.params || {};
        const data = await request({ url, params: {...defaultParams, ...params}, headers });
        return data;
    }

    const data = await makeRequest(text);

    if (data.error) {
        throw new Exception(`An error was returned from the server: ${data.error}`);
    }

    if (pathway.parser) {
        return await pathway.parser(data, makeRequest);
    }

    if (hasListReturn(pathway)) {
        return parseNumberedList(data)
    }  
    
    return await getStringFromResponse(data);
    
}   

module.exports = {
    resolver
}