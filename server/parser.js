import logger from '../lib/logger.js';

//simply trim and parse with given regex
const regexParser = (text, regex) => {
    return text.trim().split(regex).map(s => s.trim()).filter(s => s.length);
}

// parse numbered list text format into list
// this supports most common numbered list returns like "1.", "1)", "1-"
const parseNumberedList = (str) => {
    // eslint-disable-next-line no-useless-escape
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
            logger.warn(`Failed to parse value in parseNumberedObjectList, value: ${value}, fields: ${fields}`);
        }
    }

    return result;
}

// parse a comma-separated list text format into list
const parseCommaSeparatedList = (str) => {
    return str.split(',').map(s => s.trim()).filter(s => s.length);
}

const isCommaSeparatedList = (data) => {
    const commaSeparatedPattern = /^([^,\n]+,)+[^,\n]+$/;
    return commaSeparatedPattern.test(data.trim());
}

const isNumberedList = (data) => {
    const numberedListPattern = /^\s*[\[\{\(]*\d+[\s.=\-:,;\]\)\}]/gm;
    return numberedListPattern.test(data.trim());
}

export {
    regexParser,
    parseNumberedList,
    parseNumberedObjectList,
    parseCommaSeparatedList,
    isCommaSeparatedList,
    isNumberedList,
};
