// lc_test.js
// LangChain Cortex integration test

// Import required modules
import { OpenAI } from "langchain/llms";
//import { PromptTemplate } from "langchain/prompts";
//import { LLMChain, ConversationChain } from "langchain/chains";
import { initializeAgentExecutor } from "langchain/agents";
import { SerpAPI, Calculator } from "langchain/tools";
//import { BufferMemory } from "langchain/memory";

export default {

    // Agent test case
    resolver: async (parent, args, contextValue, _info) => {

        const { config } = contextValue;
        const env = config.getEnv();

        // example of reading from a predefined config variable
        const openAIApiKey = config.get('openaiApiKey');
        // example of reading straight from environment
        const serpApiKey = env.SERPAPI_API_KEY;

        const model = new OpenAI({ openAIApiKey: openAIApiKey, temperature: 0 });
        const tools = [new SerpAPI( serpApiKey ), new Calculator()];

        const executor = await initializeAgentExecutor(
            tools,
            model,
            "zero-shot-react-description"
            );

        console.log(`====================`);
        console.log("Loaded langchain agent.");
        const input = args.text;
        console.log(`Executing with input "${input}"...`);
        const result = await executor.call({ input });
        console.log(`Got output ${result.output}`);
        console.log(`====================`);

        return result?.output;
    },

    /*
    // Agent test case
    resolver: async (parent, args, contextValue, info) => {

        const { config } = contextValue;
        const openAIApiKey = config.get('openaiApiKey');
        const serpApiKey = config.get('serpApiKey');

        const model = new OpenAI({ openAIApiKey: openAIApiKey, temperature: 0 });
        const tools = [new SerpAPI( serpApiKey ), new Calculator()];

        const executor = await initializeAgentExecutor(
            tools,
            model,
            "zero-shot-react-description"
            );

        console.log(`====================`);
        console.log("Loaded langchain agent.");
        const input = args.text;
        console.log(`Executing with input "${input}"...`);
        const result = await executor.call({ input });
        console.log(`Got output ${result.output}`);
        console.log(`====================`);

        return result?.output;
    },
    */
    // Simplest test case
    /*
    resolver: async (parent, args, contextValue, info) => {
     
        const { config } = contextValue;
        const openAIApiKey = config.get('openaiApiKey');

        const model = new OpenAI({ openAIApiKey: openAIApiKey, temperature: 0.9 });

        const template = "What is a good name for a company that makes {product}?";

        const prompt = new PromptTemplate({
            template: template,
            inputVariables: ["product"],
        });

        const chain = new LLMChain({ llm: model, prompt: prompt });  

        console.log(`====================`);
        console.log(`Calling langchain with prompt: ${prompt?.template}`);
        console.log(`Input text: ${args.text}`);
        const res = await chain.call({ product: args.text });
        console.log(`Result: ${res?.text}`);
        console.log(`====================`);     

        return res?.text?.trim();
    },
    */
};


