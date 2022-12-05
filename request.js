const axios = require('axios');

const request = ({ url, params, headers }) => {
    try {
        return axios.post(url, params, { headers });
    } catch (e) {
        return { error: e };
    }
}

const openaiRequest = async (params) => {
    const { deploymentName = 'archipelago-davinci' } = params;
    // const { prompt } = params;
    // console.log('openaiRequest for prompt: ', prompt);
    const headers = {
        "api-key": OPENAI_APIKEY,
        "Content-Type": "application/json"
    }

    const postParams = {
        ...{
            // prompt,
            max_tokens: 2048,
            // model: "text-davinci-002",
            // "temperature": 1,
            // "top_p": 1,
            // "n": 1,
            // "presence_penalty": 0,
            // "frequency_penalty": 0,
            // "best_of": 1,
        }, ...params
    };

    try {
        const url = OPENAI_APIBASEURL + "openai/deployments/" + deploymentName + "/completions?api-version=2022-06-01-preview";
        const response = await axios.post(url, postParams, { headers });
        return response;
    } catch (e) {
        return { error: e };
    }
}

const pass = async (params) => {
    const response = await openaiRequest(params);

    if (response.error) {
        return response.error.message || response.error
    }
    else {
        return response.data.choices[0].text;
    }
}

module.exports = {
    request
}