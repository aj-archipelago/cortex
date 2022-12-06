const { config } = require("./config");
const { request } = require("./request");
const handlebars = require("handlebars");

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

    const defaultParams = {
        // prompt,
        max_tokens: 2048,
        // model: "text-davinci-002",
        // "temperature": 1,
        // "top_p": 1,
        // "n": 1,
        // "presence_penalty": 0,
        // "frequency_penalty": 0,
        // "best_of": 1,
    }

    const promptFn = handlebars.compile(endpoint.prompt);

    return { ...defaultParams, ...{ prompt: promptFn({ text }) } };
}

const endpointName = 'headline';
const fn = async(endpointName, text) => {
    const url = getUrl(endpointName);
    const params = getParams(endpointName, text);
    
    const api = config.get('API');
    const headers = {}
    for (const [key, value] of Object.entries(api.headers)) {
        headers[key] = handlebars.compile(value)({ ...config.getEnv() });
    }
    return await request({ url, params, headers });
}

const endpointFn = (endpointName) => {
    // return (_, { text }) => `endpointName: ${endpointName}, text: ${text}`; // TODO fn 
    return (_, { text }) => fn(endpointName, text);
}

const fns = {};
for (const endpointName of endpointNames) {
    fns[endpointName] = endpointFn(endpointName);
}

module.exports = {
    fns
}