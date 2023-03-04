//simples form string single or list return
const getResponseResult = (data) => {
    const { choices } = data;
    if (!choices || !choices.length) {
        return; //TODO no choices case
    }
    const textResult = choices.map(({ text }) => text && text.trim());
    const messageResult = choices.map(({ message }) => message && message.content && message.content.trim());

    return messageResult[0] || textResult[0] || null;
}

//simply trim and parse with given regex
const regexParser = (text, regex) => {
    return text.trim().split(regex).map(s => s.trim()).filter(s => s.length);
}

// parse numbered list text format into list
// this supports most common numbered list returns like "1.", "1)", "1-"
const parseNumberedList = (str) => {
    return regexParser(str, /^\s*[\[\{\(]*\d+[\s.=\-:,;\]\)\}]/gm);
}

// parse a numbered object list text format into list of objects
const parseNumberedObjectList = (text, format) => {
    const fields = format.match(/\b(\w+)\b/g);
    const values = parseNumberedList(text);

    const result = [];
    for (const value of values) {
        try {
            const splitted = regexParser(value, /[:-](.*)/);
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
    parseNumberedObjectList
};
