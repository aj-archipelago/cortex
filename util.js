const { parseNumberedList } = require("./parser");

const hasListReturn = (endpoint) => {
    const { count, n, list } = endpoint;
    return count > 1 || n > 1 || list;
}

module.exports = {
    hasListReturn,
}