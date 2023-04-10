class Prompt {
    constructor(params) {
        if (typeof params === 'string' || params instanceof String) {
            this.prompt = params;
        } else {
            const { prompt, saveResultTo, messages } = params;
            this.prompt = prompt;
            this.saveResultTo = saveResultTo;
            this.messages = messages;
            this.params = params;
        }

        this.usesTextInput = promptContains('text', this.prompt ? this.prompt : this.messages);
        this.usesPreviousResult = promptContains('previousResult', this.prompt ? this.prompt : this.messages);
        this.debugInfo = '';
    }
}

// function to check if a Handlebars template prompt contains a variable
// can work with a single prompt or an array of messages
function promptContains(variable, prompt) {
    const regexp = /{{+(.*?)}}+/g;
    let matches = [];
    let match;

    // if it's an array, it's the messages format
    if (Array.isArray(prompt)) {
      prompt.forEach(p => {
        while (match = p.content && regexp.exec(p.content)) {
          matches.push(match[1]);
        }
      });
    } else {
      while ((match = regexp.exec(prompt)) !== null) {
        matches.push(match[1]);
      }
    }

    const variables = matches.filter(function (varName) {
        return varName.indexOf("#") !== 0 && varName.indexOf("/") !== 0;
    })

    return variables.includes(variable);
}

export { Prompt, promptContains };