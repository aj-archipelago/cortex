// test_langchain.mjs
// LangChain Cortex integration test

// Import required modules
import { ChatOpenAI } from "@langchain/openai";

export default {

    // Agent test case
    resolver: async (parent, args, contextValue, _info) => {

        const { config } = contextValue;

        // example of reading from a predefined config variable
        const openAIApiKey = config.get('openaiApiKey');

        const model = new ChatOpenAI({ openAIApiKey: openAIApiKey, temperature: 0 });

        console.log(`====================`);
        console.log("Loaded langchain.");
        const input = args.text;
        console.log(`Executing with input "${input}"...`);
        const result = await model.invoke(input);
        console.log(`Got output "${result.content}"`);
        console.log(`====================`);

        return result?.content;
    },
};


