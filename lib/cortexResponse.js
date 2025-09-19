class CortexResponse {
    constructor({
        output_text = "",
        output = null,
        finishReason = 'stop',
        toolCalls = null,
        functionCall = null,
        citations = null,
        searchQueries = null,
        searchResults = null,
        realTimeData = null,
        artifacts = null,
        usage = null,
        metadata = {},
        error = null
    } = {}) {
        this._output_text = output_text;
        this._output = output;
        this._finishReason = finishReason;
        this._toolCalls = toolCalls;
        this._functionCall = functionCall;
        this._citations = citations;
        this._searchQueries = searchQueries;
        this._searchResults = searchResults;
        this._realTimeData = realTimeData;
        this._artifacts = artifacts;
        this._usage = usage;
        this._metadata = {
            timestamp: new Date().toISOString(),
            ...metadata
        };
        this._error = error;
    }

    // Getters
    get output_text() { return this._output_text; }
    get output() { return this._output; }
    get finishReason() { return this._finishReason; }
    get toolCalls() { return this._toolCalls; }
    get tool_calls() { return this._toolCalls; } // For legacy compatibility
    get functionCall() { return this._functionCall; }
    get citations() { return this._citations; }
    get searchQueries() { return this._searchQueries; }
    get searchResults() { return this._searchResults; }
    get realTimeData() { return this._realTimeData; }
    get artifacts() { return this._artifacts; }
    get usage() { return this._usage; }
    get metadata() { return this._metadata; }
    get error() { return this._error; }

    // Setters
    set output_text(value) { this._output_text = value; }
    set output(value) { this._output = value; }
    set finishReason(value) { this._finishReason = value; }
    set toolCalls(value) { 
        this._toolCalls = value;
        if (value && value.length > 0) {
            this._finishReason = 'tool_calls';
        }
    }
    set functionCall(value) { 
        this._functionCall = value;
        if (value) {
            this._finishReason = 'function_call';
        }
    }
    set citations(value) { this._citations = value; }
    set searchQueries(value) { this._searchQueries = value; }
    set searchResults(value) { this._searchResults = value; }
    set realTimeData(value) { this._realTimeData = value; }
    set artifacts(value) { this._artifacts = value; }
    set usage(value) { this._usage = value; }
    set metadata(value) { this._metadata = { ...this._metadata, ...value }; }
    set error(value) { this._error = value; }

    // Utility methods
    hasToolCalls() {
        return this._toolCalls && this._toolCalls.length > 0;
    }

    hasCitations() {
        return this._citations && this._citations.length > 0;
    }

    hasSearchResults() {
        return this._searchResults && this._searchResults.length > 0;
    }

    hasArtifacts() {
        return this._artifacts && this._artifacts.length > 0;
    }

    isError() {
        return this._error !== null;
    }

    hasOutput() {
        return this._output && this._output.length > 0;
    }

    hasOutputText() {
        return this._output_text && this._output_text.length > 0;
    }

    // Get text content from output array (OpenAI format)
    getTextFromOutput() {
        if (!this._output || !Array.isArray(this._output)) {
            return this._output_text || "";
        }
        
        // Extract text from output items that have text content
        const textItems = this._output
            .filter(item => item && item.text)
            .map(item => item.text);
        
        return textItems.join("");
    }


    // String compatibility methods
    toString() {
        return this._output_text;
    }
    
    valueOf() {
        return this._output_text;
    }
    
    toJSON() {
        return this._output_text;
    }

    // Convert to plain object
    toObject() {
        return {
            output_text: this._output_text,
            output: this._output,
            finishReason: this._finishReason,
            toolCalls: this._toolCalls,
            functionCall: this._functionCall,
            citations: this._citations,
            searchQueries: this._searchQueries,
            searchResults: this._searchResults,
            realTimeData: this._realTimeData,
            artifacts: this._artifacts,
            usage: this._usage,
            metadata: this._metadata,
            error: this._error
        };
    }
}

export default CortexResponse;
