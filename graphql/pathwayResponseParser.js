const { parseNumberedList, parseNumberedObjectList } = require('./parser')

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

module.exports = { PathwayResponseParser };