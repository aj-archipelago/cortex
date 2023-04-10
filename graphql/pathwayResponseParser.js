import { parseNumberedList, parseNumberedObjectList } from './parser.js';

class PathwayResponseParser {
    constructor(pathway) {
        this.pathway = pathway;
    }

    parse(data) {
        if (this.pathway.parser) {
            return this.pathway.parser(data);
        }

        if (this.pathway.list) {
            if (this.pathway.format) {
                return parseNumberedObjectList(data, this.pathway.format);
            }
            return parseNumberedList(data)
        }

        return data;
    }
}

export { PathwayResponseParser };