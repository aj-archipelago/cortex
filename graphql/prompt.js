class Prompt {
    constructor(params) {
        if (typeof params === 'string' || params instanceof String) {
            this.prompt = params;
        } else {
            const { prompt, saveResultTo, messages, context, examples } = params;
            this.prompt = prompt;
            this.saveResultTo = saveResultTo;
            this.messages = messages;
            this.context = context;
            this.examples = examples;
            this.params = params;
        }

        this.usesTextInput = promptContains('text', this.prompt ? this.prompt : this.messages) ||
                             (this.context && promptContains('text', this.context)) ||
                             (this.examples && promptContains('text', this.examples));
        this.usesPreviousResult = promptContains('previousResult', this.prompt ? this.prompt : this.messages) ||
                                   (this.context && promptContains('previousResult', this.context)) ||
                                   (this.examples && promptContains('previousResult', this.examples));
        this.debugInfo = '';
    }
}

// function to check if a Handlebars template prompt contains a variable
// can work with a single prompt or an array of messages
function promptContains(variable, prompt) {
    const regexp = /{{+(.*?)}}+/g;
    let matches = [];
    let match;

    // if it's an array, it's either an OpenAI messages array or a PaLM messages
    // array or a PaLM examples array, all of which have a content property
    if (Array.isArray(prompt)) {
      prompt.forEach(p => {
        // eslint-disable-next-line no-cond-assign
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