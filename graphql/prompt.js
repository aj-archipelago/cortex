class Prompt {
    constructor(params) {
        if (typeof params === 'string' || params instanceof String) {
            this.prompt = params;
        } else {
            const { prompt, saveResultTo } = params;
            this.prompt = prompt;
            this.saveResultTo = saveResultTo;
            this.params = params;
        }

        this.usesTextInput = promptContains('text', this.prompt);
    }
}

// function to check if a Handlebars template prompt contains a variable
function promptContains(variable, prompt) {
    const regexp = /{{+(.*?)}}+/g;
    let matches = [];
    let match;

    while ((match = regexp.exec(prompt)) !== null) {
        matches.push(match[1]);
    }

    const variables = matches.filter(function (varName) {
        return varName.indexOf("#") !== 0 && varName.indexOf("/") !== 0;
    })

    return variables.includes(variable);
}

module.exports = { Prompt, promptContains };