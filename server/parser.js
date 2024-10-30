import logger from '../lib/logger.js';
import { callPathway } from '../lib/pathwayTools.js';

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
    const fieldMap = new Map(fields.map(f => [f.toLowerCase(), f]));

    return values.map(value => {
        const obj = {};
        const pairs = value.split(/,\s*/);
        for (let i = 0; i < pairs.length; i++) {
            const pair = pairs[i];

            // either there are actual fieldnames (separated by :) in which case we split by :
            // and do a hard match against the fieldMap, or there are soft or no fieldnames (separated by - or no separator)
            // in which case we try match but then infer the field name from the field order
            let splitIndex = pair.indexOf(':');
            if (splitIndex !== -1) {
                const key = pair.slice(0, splitIndex).trim().toLowerCase();
                const val = pair.slice(splitIndex + 1).trim();
                const field = fieldMap.get(key);
                if (field) {
                    obj[field] = val;
                }
                continue;
            }

            splitIndex = pair.indexOf('-');
            if (splitIndex !== -1) {
                const key = pair.slice(0, splitIndex).trim().toLowerCase();
                const val = pair.slice(splitIndex + 1).trim();
                const field = fieldMap.get(key);
                if (field) {
                    obj[field] = val;
                    continue;
                }
            }

            const inferredField = fields[i];
            if (inferredField) {
                obj[inferredField] = pair.trim();
            }
        }
        return Object.keys(obj).length > 0 ? obj : null;
    }).filter(Boolean);
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

async function parseJson(str) {
    try {
        const jsonStart = str.indexOf('{') !== -1 ? str.indexOf('{') : str.indexOf('[');
        const jsonEnd = str.lastIndexOf('}') !== -1 ? str.lastIndexOf('}') + 1 : str.lastIndexOf(']') + 1;
        const jsonStr = str.slice(jsonStart, jsonEnd);
        JSON.parse(jsonStr); // Validate JSON
        return jsonStr;
    } catch (error) {
        try {
            const repairedJson = await callPathway('sys_repair_json', { text: str });
            return JSON.parse(repairedJson) ? repairedJson : null;
        } catch (repairError) {
            logger.warn(`Failed to parse JSON: ${repairError.message}`);
            return null;
        }
    }
}

export {
    regexParser,
    parseNumberedList,
    parseNumberedObjectList,
    parseCommaSeparatedList,
    isCommaSeparatedList,
    isNumberedList,
    parseJson
};
