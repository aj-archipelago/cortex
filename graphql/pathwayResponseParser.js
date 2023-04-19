import { parseNumberedList, parseNumberedObjectList, parseCommaSeparatedList } from './parser.js';

class PathwayResponseParser {
    constructor(pathway) {
        this.pathway = pathway;
    }

    isCommaSeparatedList(data) {
        const commaSeparatedPattern = /^([^,\n]+,)+[^,\n]+$/;
        return commaSeparatedPattern.test(data.trim());
    }

    parse(data) {
        if (this.pathway.parser) {
            return this.pathway.parser(data);
        }

        if (this.pathway.list) {
            if (this.isCommaSeparatedList(data)) {
                return parseCommaSeparatedList(data);
            } else {
                if (this.pathway.format) {
                    return parseNumberedObjectList(data, this.pathway.format);
                }
                return parseNumberedList(data);
            }
        }

        return data;
    }
}

export { PathwayResponseParser };