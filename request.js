const axios = require('axios');

const postRequest = ({ url, params, headers }) => {
    try {
        return axios.post(url, params, { headers });
    } catch (e) {
        return { error: e };
    }
}


const request = async (params) => {
    const response = await postRequest(params);
    const { error, data } = response;
    if (error) {
        return error.message || error;
    }

    const { choices } = data;
    if (!choices || !choices.length) {
        return; //TODO no choices
    }
    const result = choices.map(({ text }) => text);
    return result.length > 1 ? result : result[0];
}

module.exports = {
    request, postRequest
}