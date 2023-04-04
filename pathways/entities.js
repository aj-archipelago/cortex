// entities.js
// Entity extraction module
// This module exports a prompt that takes an input text and extracts the top entities and their definitions as specified by the count parameter.

export default {
    // Set the temperature to 0 to favor more deterministic output when generating entity extraction.
    temperature: 0,

    prompt: `{{text}}\n\nList the top {{count}} entities and their definitions for the above in the format {{format}}:`,

    // Define the format for displaying the extracted entities and their definitions.
    format: `(name: definition)`,

    // Define input parameters for the prompt, such as the number of entities to extract.
    inputParameters: {
        count: 5,
    },

    // Set the list option to true as the prompt is expected to return a list of entities.
    list: true,
};

