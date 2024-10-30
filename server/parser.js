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

async function parseNumberedObjectList(text, format) {
    const parsedList = await callPathway('sys_parse_numbered_object_list', { text, format });
    try {
        return JSON.parse(parsedList);
    } catch (error) {
        logger.warn(`Failed to parse numbered object list: ${error.message}`);
        return [];
    }
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
        JSON.parse(str); // Validate JSON
        return str;
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
