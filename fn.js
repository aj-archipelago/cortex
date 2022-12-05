const { config } = require("./config");
const { request } = require("./request");
const handlebars = require("handlebars");

const neurons = config.get('neurons');
const neuronNames = Object.keys(neurons);


const getUrl = (neuronName) => {
    const neuron = neurons[neuronName];
    // if (config.get('')) // 'AZURE-OAI
    const api = config.get('API');
    const urlFn = handlebars.compile(api.url);
    return urlFn({ ...api, ...config.getEnv() });
}

const getParams = (neuronName, text) => {
    const neuron = neurons[neuronName];

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

    const promptFn = handlebars.compile(neuron.prompt);

    return { ...defaultParams, ...{ prompt: promptFn({ text }) } };
}

const neuronName = 'headline';
const headline = async (text) => {
    const url = getUrl(neuronName);
    const params = getParams(neuronName, text);
    
    const api = config.get('API');
    const headers = {}
    for (const [key, value] of Object.entries(api.headers)) {
        headers[key] = handlebars.compile(value)({ ...config.getEnv() });
    }
    const res = await request({ url, params, headers });
    return res;
}

headline(`Featured articles are considered to be some of the best articles Wikipedia has to offer, as determined by Wikipedia's editors. They are used by editors as examples for writing other articles. Before being listed here, articles are reviewed as featured article candidates for accuracy, neutrality, completeness, and style according to our featured article criteria. Many featured articles were previously good articles (which are reviewed with a less restrictive set of criteria). There are 6,176 featured articles out of 6,583,906 articles on the English Wikipedia (about 0.09% or one out of every 1,060. `) //TODO

const neuronFn = (neuronName) => {
    return (_, { text }) => `neuronName: ${neuronName}, text: ${text}`; // TODO fn 
}

const fns = {};
for (const neuronName of neuronNames) {
    fns[neuronName] = neuronFn(neuronName);
}

module.exports = {
    fns
}