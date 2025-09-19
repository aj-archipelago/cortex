import { parseNumberedList, parseNumberedObjectList, parseCommaSeparatedList, isCommaSeparatedList, isNumberedList, parseJson } from './parser.js';
import CortexResponse from '../lib/cortexResponse.js';

class PathwayResponseParser {
    constructor(pathway) {
        this.pathway = pathway;
    }

    async parse(data) {
        
        let dataToParse = data;
        
        if (data instanceof CortexResponse) {
            dataToParse = data.toString();
        }       

        if (this.pathway.parser) {
            return this.pathway.parser(dataToParse);
        }

        if (this.pathway.list) {
            if (isNumberedList(dataToParse)) {
                if (this.pathway.format) {
                    return await parseNumberedObjectList(dataToParse, this.pathway.format);
                }
                return parseNumberedList(dataToParse);
            } else if (isCommaSeparatedList(dataToParse)) {
                return parseCommaSeparatedList(dataToParse);
            }
            return [dataToParse];
        }

        if (this.pathway.json) {
            return await parseJson(dataToParse);
        }

        return data;
    }
}

export { PathwayResponseParser };