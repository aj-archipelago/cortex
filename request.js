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

    return data;
}

module.exports = {
    request, postRequest
}