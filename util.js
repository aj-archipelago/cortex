const hasListReturn = (pathway) => {
    const { count, n, list } = pathway;
    return count > 1 || n > 1 || list;
}

module.exports = {
    hasListReturn
}