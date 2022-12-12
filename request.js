const axios = require('axios');

const postRequest = async ({ url, params, headers }) => {
    try {
        return await axios.post(url, params, { headers });
    } catch (e) {
        return { error: e }; //retry logic
    }
}


const request = async (params) => {
    const response = await postRequest(params);
    const { error, data } = response;
    if (error) {
        return { error: `${error.response?.status} ${error.code}: ${error.response?.data?.error?.message}` || error };
    }

    return data;
}

module.exports = {
    request, postRequest
}