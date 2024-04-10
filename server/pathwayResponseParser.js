import { parseNumberedList, parseNumberedObjectList, parseCommaSeparatedList, isCommaSeparatedList, isNumberedList, parseJson } from './parser.js';

class PathwayResponseParser {
    constructor(pathway) {
        this.pathway = pathway;
    }

    parse(data) {
        if (this.pathway.parser) {
            return this.pathway.parser(data);
        }

        if (this.pathway.list) {
            if (isNumberedList(data)) {
                if (this.pathway.format) {
                    return parseNumberedObjectList(data, this.pathway.format);
                }
                return parseNumberedList(data);
            } else if (isCommaSeparatedList(data)) {
                return parseCommaSeparatedList(data);
            }
            return [data];
        }

        if (this.pathway.json) {
            return parseJson(data);
        }

        return data;
    }
}

export { PathwayResponseParser };