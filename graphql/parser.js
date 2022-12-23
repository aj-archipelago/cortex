//simples form string single or list return
const getResponseResult = (data) => {
    const { choices } = data;
    if (!choices || !choices.length) {
        return; //TODO no choices case
    }
    const result = choices.map(({ text }) => text.trim());
    return result.length > 1 ? result : result[0];
}

//simply trim and parse with given regex
const regexParser = (text, regex) => {
    return text.trim().split(regex).map(s => s.trim()).filter(s => s.length);
}

// parse numbered list text format into list
const parseNumberedList = (str) => {
    return regexParser(str, /\d+\. ?/);
}

// parse a numbered object list text format into list of objects
const parseNumberedObjectList = (text, fields = ['name', 'definition']) => {
    const values = parseNumberedList(text);

    const result = [];
    for (const value of values) {
        try {
            const splitted = regexParser(value, /:(.*)/);
            const obj = {};
            for (let i = 0; i < fields.length; i++) {
                obj[fields[i]] = splitted[i];
            }
            result.push(obj);
        } catch (e) {
            console.warn(`Failed to parse value in parseNumberedObjectList, value: ${value}, fields: ${fields}`);
        }
    }

    return result;
}

module.exports = {
    getResponseResult,
    regexParser,
    parseNumberedList,
    parseNumberedObjectList,
};
