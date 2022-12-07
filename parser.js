//simples form string single or list return
const parser = async (data) => {
    const { choices } = data;
    if (!choices || !choices.length) {
        return; //TODO no choices case
    }
    const result = choices.map(({ text }) => text.trim());
    return result.length > 1 ? result : result[0];
}

// return list of strings out from single string split via given regex
const regexParser = async (data, regex) => {
    const text = await parser(data);
    return text.trim().split(regex).map(s => s.trim()).filter(s => s.length);
}

// parse numbered list text format into list
const parseNumberedList = async (data) => {
    return await regexParser(data, /\d+\. ?/);
}

// parse a numbered object list text format into list of objects
const parseNumberedObjectList = (text, fields = ['name', 'definition']) => {
    const values = parseNumberedList(text);

    const result = [];
    for (const value of values) {
        try {
            const splitted = parse(value, /:(.*)/);
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
    parser,
    regexParser,
    parseNumberedList,
    parseNumberedObjectList,
};