// Default resolver for all pathways

const { request } = require("./request");
const handlebars = require("handlebars");
const { getResponseResult, parseNumberedList } = require("./parser");
const { hasListReturn } = require("./util");
const { Exception } = require("handlebars");
const nlp = require('compromise')
const plg = require('compromise-paragraphs')

nlp.extend(plg)

const getUrl = (config, model) => {
    const generateUrl = handlebars.compile(model.url);
    return generateUrl({ ...model, ...config.getEnv() });
}

const getReqParams = (pathway, text, prompt) => {
    const { temperature } = pathway;
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

async function makeRestRequest(params, overrideParams={}) {
    const { config, pathway, text, prompt, info } = params;
    const defaultModel = config.get('default_model')
    const model = config.get('models')[pathway.model || defaultModel];

    const url = getUrl(config, model);
    const reqParams = getReqParams(pathway, text, prompt);

    const { temperature } = reqParams;
    if (temperature == 0) {
        info.cacheControl.setCacheHint({ maxAge: 60 * 60 * 24, scope: 'PUBLIC' });
    }

    const headers = {};
    for (const [key, value] of Object.entries(model.headers)) {
        headers[key] = handlebars.compile(value)({ ...config.getEnv() });
    }
    const defaultReqParams = model.params || {};
    const sendingParams = { ...defaultReqParams, ...reqParams, ...overrideParams }
    console.log(`===\n${sendingParams.prompt}`)
    const data = await request({ url, params: sendingParams, headers });

    if (data.error) {
        throw new Exception(`An error was returned from the server: ${data.error}`);
    }

    return getResponseResult(data);
}

async function makeParallelRequests(params) {
    const { text, prompt } = params;
    const paragraphs = nlp(text).paragraphs().views.map(v => v.text());

    const data = await Promise.all(paragraphs.map(paragraph =>
        makeRestRequest({ ...params, text: paragraph, prompt })));

    return data.join("\n\n");
}

async function makeSequentialRequests(params) {
    const { text, prompt } = params;
    let ctext = text;
    for (const p of prompt) {
        ctext = await makeRequest({ ...params, text: ctext, prompt: p });
    }
    return ctext;
}

async function makeRequest(params) {
    const { config, pathway, parent, args, contextValue, info } = params;
    const { chunk } = pathway;

    if (chunk) {
        return await makeParallelRequests(params)
    }
    return await makeRestRequest(params)
}

async function processRequest(params) {
    const { prompt } = params;
    if (Array.isArray(prompt)) {
        return await makeSequentialRequests(params);
    }
    return await makeRequest(params);
}

const resolver = async (params) => {
    const { pathway, args } = params;
    const { text } = args;
    const { prompt, parser } = pathway;

    const executePrompt = async (text, overrideParams = {}) =>
        await processRequest({ ...params, text, prompt, ...overrideParams })

    const data = await executePrompt(text);

    if (parser) {
        return await parser(
            data, 
            executePrompt);
    }
    if (hasListReturn(pathway)) {
        return parseNumberedList(data)
    }
    return data;
}

module.exports = {
    resolver
}