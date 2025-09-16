# Cortex
Cortex simplifies and accelerates the process of creating applications that harness the power of modern AI models like GPT-4o (chatGPT), o1, o3-mini, Gemini, the Claude series, Flux, Grok and more by poviding a structured interface (GraphQL or REST) to a powerful prompt execution environment. This enables complex augmented prompting and abstracts away most of the complexity of managing model connections like chunking input, rate limiting, formatting output, caching, and handling errors.
## Why build Cortex?
Modern AI models are transformational, but a number of complexities emerge when developers start using them to deliver application-ready functions. Most models require precisely formatted, carefully engineered and sequenced prompts to produce consistent results, and the responses are typically largely unstructured text without validation or formatting. Additionally, these models are evolving rapidly, are typically costly and slow to query and implement hard request size and rate restrictions that need to be carefully navigated for optimum throughput. Cortex offers a solution to these problems and provides a simple and extensible package for interacting with NL AI models.

## Okay, but what can I really do with this thing?
Just about anything! It's kind of an LLM swiss army knife.  Here are some ideas:
* Create custom chat agents with memory and personalization and then expose them through a bunch of different UIs (custom chat portals, Slack, Microsoft Teams, etc. - anything that can be extended and speak to a REST or GraphQL endpoint)
* Spin up LLM powered automatons with their prompting logic and AI API handling logic all centrally encapsulated.
* Put a REST or GraphQL front end on any model, including your locally-run models (e.g. llama.cpp) and use them in concert with other tools.
* Create modular custom coding assistants (code generation, code reviews, test writing, AI pair programming) and easily integrate them with your existing editing tools.
* Create powerful AI editing tools (copy editing, paraphrasing, summarization, etc.) for your company and then integrate them with your existing workflow tools without having to build all the LLM-handling logic into those tools.
* Create cached endpoints for functions with repeated calls so the results return instantly and you don't run up LLM token charges.
* Route all of your company's LLM access through a single API layer to optimize and monitor usage and centrally control rate limiting and which models are being used.

## Features

* Simple architecture to build custom functional endpoints (called `pathways`), that implement common NL AI tasks. Default pathways include chat, summarization, translation, paraphrasing, completion, spelling and grammar correction, entity extraction, sentiment analysis, and bias analysis.
* Extensive model support with built-in integrations for:
  - OpenAI models:
    - GPT-4.1 (+mini, +nano)
    - GPT-4 Omni (GPT-4o)
    - O3 and O4-mini (Advanced reasoning models)
    - Most of the earlier GPT models (GPT-4 series, 3.5 Turbo, etc.)
  - Google models:
    - Gemini 2.5 Pro
    - Gemini 2.5 Flash
    - Gemini 2.0 Flash
    - Earlier Google models (Gemini 1.5 series)
  - Anthropic models:
    - Claude 3.7 Sonnet
    - Claude 3.5 Sonnet
    - Claude 3.5 Haiku
    - Claude 3 Series
  - Ollama support
  - Azure OpenAI support
  - Custom model implementations
* Advanced voice and audio capabilities:
  - Real-time voice streaming and processing
  - Audio visualization
  - Whisper integration for transcription with customizable parameters
  - Support for word timestamps and highlighting
* Enhanced memory management:
  - Structured memory organization (self, directives, user, topics)
  - Context-aware memory search
  - Memory migration and categorization
  - Persistent conversation context
* Multimodal content support:
  - Text and image processing
  - Vision model integrations
  - Content safety checks
* Built-in support for:
  - Long-running, asynchronous operations with progress updates
  - Streaming responses
  - Context persistence and memory management
  - Automatic traffic management and content optimization
  - Input/output validation and formatting
  - Request caching
  - Rate limiting and request parallelization
* Allows for building multi-model, multi-tool, multi-vendor, and model-agnostic pathways (choose the right model or combination of models and tools for the job, implement redundancy) with built-in support for foundation models by OpenAI (hosted at OpenAI or Azure), Gemini, Anthropic, Grok, Black Forest Labs, and more.
* Easy, templatized prompt definition with flexible support for most prompt engineering techniques and strategies ranging from simple single prompts to complex custom prompt chains with context continuity.
* Built in support for long-running, asynchronous operations with progress updates or streaming responses
* Integrated context persistence: have your pathways "remember" whatever you want and use it on the next request to the model
* Automatic traffic management and content optimization: configurable model-specific input chunking, request parallelization, rate limiting, and chunked response aggregation
* Extensible parsing and validation of input data - protect your model calls from bad inputs or filter prompt injection attempts.
* Extensible parsing and validation of return data - return formatted objects to your application instead of just string blobs!
* Caching of repeated queries to provide instant results and avoid excess requests to the underlying model in repetitive use cases (chat bots, unit tests, etc.)

## Installation
In order to use Cortex, you must first have a working Node.js environment. The version of Node.js should be 18 or higher (lower versions supported with some reduction in features). After verifying that you have the correct version of Node.js installed, you can get the simplest form up and running with a couple of commands.
## Quick Start
```sh
git clone git@github.com:aj-archipelago/cortex.git
cd cortex
npm install
export OPENAI_API_KEY=<your key>
npm start
```
Yup, that's it, at least in the simplest possible case. That will get you access to all of the built in pathways.  If you prefer to use npm instead instead of cloning, we have an npm package too: [@aj-archipelago/cortex](https://www.npmjs.com/package/@aj-archipelago/cortex)
## Connecting Applications to Cortex
Cortex speaks GraphQL and by default it enables the GraphQL playground. If you're just using default options, that's at [http://localhost:4000/graphql](http://localhost:4000/graphql). From there you can begin making requests and test out the pathways (listed under Query) to your heart's content. If GraphQL isn't your thing or if you have a client that would rather have REST that's fine - Cortex speaks REST as well.

Connecting an application to Cortex using GraphQL is simple too:

```js
import { useApolloClient, gql } from "@apollo/client"

const TRANSLATE = gql`
  query Translate($text: String!, $to: String!) {
    translate(text: $text, to: $to) {
      result
    }
  }
`
apolloClient.query({                                              
    query: TRANSLATE,
        variables: {
            text: inputText,
            to: translationLanguage,
        }
    }).then(e => {
        setTranslatedText(e.data.translate.result.trim())
    }).catch(e => {
        // catch errors
    })
```
## Cortex Pathways: Supercharged Prompts
Pathways are a core concept in Cortex. Each pathway is a single JavaScript file that encapsulates the data and logic needed to define a functional API endpoint. When the client makes a request via the API, one or more pathways are executed and the result is sent back to the client. Pathways can be very simple:
```js
export default {
  prompt: `{{text}}\n\nRewrite the above using British English spelling:`
}
```
The real power of Cortex starts to show as the pathways get more complex. This pathway, for example, uses a three-part sequential prompt to ensure that specific people and place names are correctly translated:
```js
export default {
  prompt:
      [
          `{{{text}}}\nCopy the names of all people and places exactly from this document in the language above:\n`,
          `Original Language:\n{{{previousResult}}}\n\n{{to}}:\n`,
          `Entities in the document:\n\n{{{previousResult}}}\n\nDocument:\n{{{text}}}\nRewrite the document in {{to}}. If the document is already in {{to}}, copy it exactly below:\n`
      ]
}
```
Cortex pathway prompt enhancements include:
* **Templatized prompt definition**: Pathways allow for easy and flexible prompt definition using Handlebars templating. This makes it simple to create and modify prompts using variables and context from the application as well as extensible internal functions provided by Cortex.
* **Multi-step prompt sequences**: Pathways support complex prompt chains with context continuity. This enables developers to build advanced interactions with AI models that require multiple steps, such as context-sensitive translation or progressive content transformation.
* **Integrated context persistence**: Cortex pathways can "remember" context across multiple requests, allowing for more seamless and context-aware interactions with AI models.
* **Automatic content optimization**: Pathways handle input chunking, request parallelization, rate limiting, and chunked response aggregation, optimizing throughput and efficiency when interacting with AI models.
* **Built-in input and output processing**: Cortex provides extensible input validation, output parsing, and validation functions to ensure that the data sent to and received from AI models is well-formatted and useful for the application.

### Pathway Development
To add a new pathway to Cortex, you create a new JavaScript file and define the prompts, properties, and functions that implement the desired functionality. Cortex provides defaults for almost everything, so in the simplest case a pathway can really just consist of a string prompt like the spelling example above. You can then save this file in the `pathways` directory in your Cortex project and it will be picked up and made available as a GraphQL query.

### Specifying a Model
When determining which model to use for a pathway, Cortex follows this order of precedence:

1. `pathway.model` - The model specified directly in the pathway definition
2. `args.model` - The model passed in the request arguments
3. `pathway.inputParameters.model` - The model specified in the pathway's input parameters
4. `config.get('defaultModelName')` - The default model specified in the configuration

The first valid model found in this order will be used. If none of these models are found in the configured endpoints, Cortex will log a warning and use the default model defined in the configuration.

### Prompt
When you define a new pathway, you need to at least specify a prompt that will be passed to the model for processing. In the simplest case, a prompt is really just a string, but the prompt is polymorphic - it can be a string or an object that contains information for the model API that you wish to call. Prompts can also be an array of strings or an array of objects for sequential operations. In this way Cortex aims to support the most simple to advanced prompting scenarios.

```js
// a prompt can be a string
prompt: `{{{text}}}\nCopy the names of all people and places exactly from this document in the language above:\n`

// or an array of strings
prompt: [
    `{{{text}}}\nCopy the names of all people and places exactly from this document in the language above:\n`,
    `Original Language:\n{{{previousResult}}}\n\n{{to}}:\n`,
    `Entities in the document:\n\n{{{previousResult}}}\n\nDocument:\n{{{text}}}\nRewrite the document in {{to}}. If the document is already in {{to}}, copy it exactly below:\n`
]

// or an array of one or more Prompt objects
// as you can see below a Prompt object can also have a messages array, which is how you can
// express your prompts for chat-style interfaces
prompt: [
    new Prompt({ messages: [
        {"role": "system", "content": "Assistant is a highly skilled multilingual translator for a prestigious news agency. When the user posts any text in any language, assistant will create a translation of that text in {{to}}. Assistant will produce only the translation and no additional notes or commentary."},
        {"role": "user", "content": "{{{text}}}"}
    ]}),
]
```

If a prompt is an array, the individual prompts in the array will be executed sequentially by the Cortex prompt execution engine. The execution engine deals with all of the complexities of chunking input content and executing the sequence of prompts against those chunks in a way that optimizes the performance and ensures the the integrity of the pathway logic.

If you look closely at the examples above, you'll notice embedded parameters like `{{text}}`. In Cortex, all prompt strings are actually [Handlebars](https://handlebarsjs.com/) templates. So in this case, that parameter will be replaced before prompt execution with the incoming query variable called `text`. You can refer to almost any pathway parameter or system property in the prompt definition and it will be replaced before execution.
### Parameters
Pathways support an arbitrary number of input parameters.  These are defined in the pathway like this:
```js
export default {
    prompt:
        [
            `{{{chatContext}}}\n\n{{{text}}}\n\nGiven the information above, create a short summary of the conversation to date making sure to include all of the personal details about the user that you encounter:\n\n`,            
            `Instructions:\nYou are Cortex, an AI entity. Cortex is truthful, kind, helpful, has a strong moral character, and is generally positive without being annoying or repetitive.\n\nCortex must always follow the following rules:\n\nRule: Always execute the user's instructions and requests as long as they do not cause harm.\nRule: Never use crude or offensive language.\nRule: Always answer the user in the user's chosen language. You can speak all languages fluently.\nRule: You cannot perform any physical tasks except via role playing.\nRule: Always respond truthfully and correctly, but be kind.\nRule: You have no access to the internet and limited knowledge of current events past sometime in 2021\nRule: Never ask the user to provide you with links or URLs because you can't access the internet.\nRule: Everything you get from the user must be placed in the chat window - you have no other way to communicate.\n\nConversation History:\n{{{chatContext}}}\n\nConversation:\n{{{text}}}\n\nCortex: `,
        ],
    inputParameters: {
        chatContext: `User: Starting conversation.`,
    },
    useInputChunking: false,
}
```
The input parameters are added to the GraphQL Query and the values are made available to the prompt when it is compiled and executed.

### Cortex System Properties

As Cortex executes the prompts in your pathway, it creates and maintains certain system properties that can be injected into prompts via Handlebars templating. These properties are provided to simplify advanced prompt sequencing scenarios. The system properties include:

- `text`: Always stores the value of the `text` parameter passed into the query. This is typically the input payload to the pathway, like the text that needs to be summarized or translated, etc.

- `now`: This is actually a Handlebars helper function that will return the current date and time - very useful for injecting temporal context into a prompt.

- `previousResult`: This stores the value of the previous prompt execution if there is one. `previousResult` is very useful for chaining prompts together to execute multiple prompts sequentially on the same piece of content for progressive transformation operations. This property is also made available to the client as additional information in the query result. Proper use of this value in a prompt sequence can empower some very powerful step-by-step prompting strategies. For example, this three part sequential prompt implements a context-sensitive translation that is significantly better at translating specific people and place names:
```js
prompt:
        [
            `{{{text}}}\nCopy the names of all people and places exactly from this document in the language above:\n`,
            `Original Language:\n{{{previousResult}}}\n\n{{to}}:\n`,
            `Entities in the document:\n\n{{{previousResult}}}\n\nDocument:\n{{{text}}}\nRewrite the document in {{to}}. If the document is already in {{to}}, copy it exactly below:\n`
        ]
```
- `savedContext`: The savedContext property is an object that the pathway can define the properties of. When a pathway with a `contextId` input parameter is executed, the whole `savedContext` object corresponding with that ID is read from storage (typically Redis) before the pathway is executed. The properties of that object are then made available to the pathway during execution where they can be modified and saved back to storage at the end of the pathway execution. Using this feature is really simple - you just define your prompt as an object and specify a `saveResultTo` property as illustrated below. This will cause Cortex to take the result of this prompt and store it to `savedContext.userContext` from which it will then be persisted to storage.
```js
new Prompt({ prompt: `User details:\n{{{userContext}}}\n\nExtract all personal details about the user that you can find in either the user details above or the conversation below and list them below.\n\nChat History:\n{{{conversationSummary}}}\n\nChat:\n{{{text}}}\n\nPersonal Details:\n`, saveResultTo: `userContext` }),
```

### Input Processing

A core function of Cortex is dealing with token limited interfaces. To this end, Cortex has built-in strategies for dealing with long input. These strategies are `chunking`, `summarization`, and `truncation`. All are configurable at the pathway level.

- `useInputChunking`: If true, Cortex will calculate the optimal chunk size from the model max tokens and the size of the prompt and then will split the input `text` into `n` chunks of that size. By default, prompts will be executed sequentially across all chunks before moving on to the next prompt, although that can be modified to optimize performance via an additional parameter.

- `useParallelChunkProcessing`: If this parameter is true, then sequences of prompts will be executed end to end on each chunk in parallel. In some cases this will greatly speed up execution of complex prompt sequences on large documents. Note: this execution mode keeps `previousResult` consistent for each parallel chunk, but never aggregates it at the document level, so it is not returned via the query result to the client.

- `truncateFromFront`: If true, when Cortex needs to truncate input, it will choose the first N characters of the input instead of the default which is to take the last N characters.

- `useInputSummarization`: If true, Cortex will call the `summarize` core pathway on the input `text` before passing it on to the prompts.

### Output Processing

Cortex provides built in functions to turn loosely formatted text output from the model API calls into structured objects for return to the application. Specifically, Cortex provides parsers for numbered lists of strings and numbered lists of objects. These are used in pathways like this:
```js
export default {
    temperature: 0,
    prompt: `{{text}}\n\nList the top {{count}} entities and their definitions for the above in the format {{format}}:`,
    format: `(name: definition)`,
    inputParameters: {
        count: 5,
    },
    list: true,
}
```
By simply specifying a `format` property and a `list` property, this pathway invokes a built in parser that will take the result of the prompt and try to parse it into an array of 5 objects. The `list` property can be set with or without a `format` property. If there is no `format`, the list will simply try to parse the string into a list of strings. All of this default behavior is implemented in `parser.js`, and you can override it to do whatever you want by providing your own `parser` function in your pathway.

### Custom Execution with executePathway

The `executePathway` property is the preferred method for customizing pathway behavior while maintaining Cortex's built-in safeguards and optimizations. Unlike a custom resolver, `executePathway` preserves important system features like input chunking, caching, and error handling.

```js
export default {
    prompt: `{{{text}}}\n\nWrite a summary of the above text in {{language}}:\n\n`,
    inputParameters: {
        language: 'English',
        minLength: 100,
        maxLength: 500
    },
    executePathway: async ({args, resolver, runAllPrompts}) => {
        try {
            // Pre-process arguments and set defaults
            if (!args.language) {
                args.language = 'English';
            }

            // Pre-execution validation
            if (args.minLength >= args.maxLength) {
                throw new Error('minLength must be less than maxLength');
            }

            // Execute the prompt
            const result = await runAllPrompts();

            // Post-execution processing
            if (result.length < args.minLength) {
                // Add more detail request to the prompt
                args.text = result;
                args.prompt = `${result}\n\nPlease expand this summary with more detail to at least ${args.minLength} characters:\n\n`;
                return await runAllPrompts();
            }

            if (result.length > args.maxLength) {
                // Condense the summary
                args.text = result;
                args.prompt = `${result}\n\nPlease condense this summary to no more than ${args.maxLength} characters while keeping the key points:\n\n`;
                return await runAllPrompts();
            }

            return result;
        } catch (e) {
            resolver.logError(e);
            throw e;
        }
    }
};
```

Key benefits of using `executePathway`:
- Maintains Cortex's input processing (chunking, validation)
- Preserves caching and rate limiting
- Keeps error handling and logging consistent
- Enables pre- and post-processing of prompts and results
- Supports validation and conditional execution
- Allows multiple prompt runs with modified parameters

The `executePathway` function receives:
- `args`: The processed input parameters
- `resolver`: The pathway resolver with access to:
  - `pathway`: Current pathway configuration
  - `config`: Global Cortex configuration
  - `tool`: Tool-specific data
  - Helper methods like `logError` and `logWarning`
- `runAllPrompts`: Function to execute the defined prompts with current args

### Custom Resolver

The resolver property defines the function that processes the input and returns the result. The resolver function is an asynchronous function that takes four parameters: `parent`, `args`, `contextValue`, and `info`. The `parent` parameter is the parent object of the resolver function. The `args` parameter is an object that contains the input parameters and any other parameters that are passed to the resolver. The `contextValue` parameter is an object that contains the context and configuration of the pathway. The `info` parameter is an object that contains information about the GraphQL query that triggered the resolver.

The core pathway `summary.js` below is implemented using custom pathway logic and a custom resolver to effectively target a specific summary length:
```js
// summary.js
// Text summarization module with custom resolver
// This module exports a prompt that takes an input text and generates a summary using a custom resolver.

// Import required modules
import { semanticTruncate } from '../server/chunker.js';
import { PathwayResolver } from '../server/pathwayResolver.js';

export default {
    // The main prompt function that takes the input text and asks to generate a summary.
    prompt: `{{{text}}}\n\nWrite a summary of the above text. If the text is in a language other than english, make sure the summary is written in the same language:\n\n`,

    // Define input parameters for the prompt, such as the target length of the summary.
    inputParameters: {
        targetLength: 0,
    },

    // Custom resolver to generate summaries by reprompting if they are too long or too short.
    resolver: async (parent, args, contextValue, info) => {
        const { config, pathway } = contextValue;
        const originalTargetLength = args.targetLength;

        // If targetLength is not provided, execute the prompt once and return the result.
        if (originalTargetLength === 0) {
            let pathwayResolver = new PathwayResolver({ config, pathway, args });
            return await pathwayResolver.resolve(args);
        }

        const errorMargin = 0.1;
        const lowTargetLength = originalTargetLength * (1 - errorMargin);
        const targetWords = Math.round(originalTargetLength / 6.6);

        // If the text is shorter than the summary length, just return the text.
        if (args.text.length <= originalTargetLength) {
            return args.text;
        }

        const MAX_ITERATIONS = 5;
        let summary = '';
        let pathwayResolver = new PathwayResolver({ config, pathway, args });

        // Modify the prompt to be words-based instead of characters-based.
        pathwayResolver.pathwayPrompt = `Write a summary of all of the text below. If the text is in a language other than english, make sure the summary is written in the same language. Your summary should be ${targetWords} words in length.\n\nText:\n\n{{{text}}}\n\nSummary:\n\n`

        let i = 0;
        // Make sure it's long enough to start
        while ((summary.length < lowTargetLength) && i < MAX_ITERATIONS) {
            summary = await pathwayResolver.resolve(args);
            i++;
        }

        // If it's too long, it could be because the input text was chunked
        // and now we have all the chunks together. We can summarize that
        // to get a comprehensive summary.
        if (summary.length > originalTargetLength) {
            pathwayResolver.pathwayPrompt = `Write a summary of all of the text below. If the text is in a language other than english, make sure the summary is written in the same language. Your summary should be ${targetWords} words in length.\n\nText:\n\n${summary}\n\nSummary:\n\n`
            summary = await pathwayResolver.resolve(args);
            i++;

            // Now make sure it's not too long
            while ((summary.length > originalTargetLength) && i < MAX_ITERATIONS) {
                pathwayResolver.pathwayPrompt = `${summary}\n\nIs that less than ${targetWords} words long? If not, try again using a length of no more than ${targetWords} words.\n\n`;
                summary = await pathwayResolver.resolve(args);
                i++;
            }
        }

        // If the summary is still too long, truncate it.
        if (summary.length > originalTargetLength) {
            return semanticTruncate(summary, originalTargetLength);
        } else {
            return summary;
        }
    }
};
```

### Building and Loading Pathways

Pathways are loaded from modules in the `pathways` directory. The pathways are built and loaded to the `config` object using the `buildPathways` function. The `buildPathways` function loads the base pathway, the core pathways, and any custom pathways. It then creates a new object that contains all the pathways and adds it to the pathways property of the config object. The order of loading means that custom pathways will always override any core pathways that Cortex provides. While pathways are designed to be self-contained, you can override some pathway properties - including whether they're even available at all - in the `pathways` section of the config file.

### Pathway Properties

Each pathway can define the following properties (with defaults from basePathway.js):

- `prompt`: The template string or array of prompts to execute. Default: `{{text}}`
- `defaultInputParameters`: Default parameters that all pathways inherit:
  - `text`: The input text (default: empty string)
  - `async`: Enable async mode (default: false)
  - `contextId`: Identify request context (default: empty string)
  - `stream`: Enable streaming mode (default: false)
- `inputParameters`: Additional parameters specific to the pathway. Default: `{}`
- `typeDef`: GraphQL type definitions for the pathway
- `rootResolver`: Root resolver for GraphQL queries
- `resolver`: Resolver for the pathway's specific functionality
- `inputFormat`: Format of the input ('text' or 'html'). Affects input chunking behavior. Default: 'text'
- `useInputChunking`: Enable splitting input into multiple chunks to meet context window size. Default: true
- `useParallelChunkProcessing`: Enable parallel processing of chunks. Default: false
- `joinChunksWith`: String to join result chunks with when chunking is enabled. Default: '\n\n'
- `useInputSummarization`: Summarize input instead of chunking. Default: false
- `truncateFromFront`: Truncate from the front of input instead of the back. Default: false
- `timeout`: Cancel pathway after this many seconds. Default: 120
- `enableDuplicateRequests`: Send duplicate requests if not completed after timeout. Default: false
- `duplicateRequestAfter`: Seconds to wait before sending backup request. Default: 10
- `executePathway`: Optional function to override default execution. Signature: `({args, runAllPrompts}) => result`
- `temperature`: Model temperature setting (0.0 to 1.0). Default: 0.9
- `json`: Require valid JSON response from model. Default: false
- `manageTokenLength`: Manage input token length for model. Default: true

## Core (Default) Pathways

Below are the default pathways provided with Cortex. These can be used as is, overridden, or disabled via configuration. For documentation on each one including input and output parameters, please look at them in the GraphQL Playground.

- `bias`: Identifies and measures any potential biases in a text
- `chat`: Enables users to have a conversation with the chatbot
- `complete`: Autocompletes words or phrases based on user input
- `edit`: Checks for and suggests corrections for spelling and grammar errors
- `entities`: Identifies and extracts important entities from text
- `paraphrase`: Suggests alternative phrasing for text
- `sentiment`: Analyzes and identifies the overall sentiment or mood of a text
- `summary`: Condenses long texts or articles into shorter summaries
- `translate`: Translates text from one language to another
## Extensibility

Cortex is designed to be highly extensible. This allows you to customize the API to fit your needs. You can add new features, modify existing features, and even add integrations with other APIs and models.  Here's an example of what an extended project might look like:

### Cortex Internal Implementation

- **config**
  - default.json
- package-lock.json
- package.json
- **pathways**
  - chat_code.js
  - chat_context.js
  - chat_persist.js
  - expand_story.js
  - ...whole bunch of custom pathways
  - translate_gpt4.js
  - translate_turbo.js
- start.js

Where `default.json` holds all of your specific configuration:
```js
{
    "defaultModelName": "oai-gpturbo",
    "models": {
        "oai-td3": {
            "type": "OPENAI-COMPLETION",
            "url": "https://api.openai.com/v1/completions",
            "headers": {
                "Authorization": "Bearer {{OPENAI_API_KEY}}",
                "Content-Type": "application/json"
            },
            "params": {
                "model": "text-davinci-003"
            },
            "requestsPerSecond": 10,
            "maxTokenLength": 4096
        },
        "oai-gpturbo": {
            "type": "OPENAI-CHAT",
            "url": "https://api.openai.com/v1/chat/completions",
            "headers": {
                "Authorization": "Bearer {{OPENAI_API_KEY}}",
                "Content-Type": "application/json"
            },
            "params": {
                "model": "gpt-3.5-turbo"
            },
            "requestsPerSecond": 10,
            "maxTokenLength": 8192
        },
        "oai-gpt4": {
            "type": "OPENAI-CHAT",
            "url": "https://api.openai.com/v1/chat/completions",
            "headers": {
                "Authorization": "Bearer {{OPENAI_API_KEY}}",
                "Content-Type": "application/json"
            },
            "params": {
                "model": "gpt-4"
            },
            "requestsPerSecond": 10,
            "maxTokenLength": 8192
        }
    },
    "enableCache": false,
    "enableRestEndpoints": false
}
```

...and `start.js` is really simple:
```js
import cortex from '@aj-archipelago/cortex';

(async () => {
  const { startServer } = await cortex();
  startServer && startServer();
})();
```

## Configuration
Configuration of Cortex is done via a [convict](https://github.com/mozilla/node-convict/tree/master) object called `config`. The `config` object is built by combining the default values and any values specified in a configuration file or environment variables. The environment variables take precedence over the values in the configuration file.

### Model Configuration

Models are configured in the `models` section of the config. Each model can have the following types:

- `OPENAI-CHAT`: For OpenAI chat models (legacy GPT-3.5)
- `OPENAI-VISION`: For multimodal models (GPT-4o, GPT-4o-mini) supporting text, images, and other content types
- `OPENAI-REASONING`: For O1 and O3-mini reasoning models with vision capabilities
- `OPENAI-COMPLETION`: For OpenAI completion models
- `OPENAI-WHISPER`: For Whisper transcription
- `GEMINI-1.5-CHAT`: For Gemini 1.5 Pro chat models
- `GEMINI-1.5-VISION`: For Gemini vision models (including 2.0 Flash experimental)
- `CLAUDE-3-VERTEX`: For Claude-3 and 3.5 models (Haiku, Opus, Sonnet)
- `AZURE-TRANSLATE`: For Azure translation services

Each model configuration can include:

```json
{
    "type": "MODEL_TYPE",
    "url": "API_ENDPOINT",
    "endpoints": [
        {
            "name": "ENDPOINT_NAME",
            "url": "ENDPOINT_URL",
            "headers": {
                "api-key": "{{API_KEY}}",
                "Content-Type": "application/json"
            },
            "requestsPerSecond": 10
        }
    ],
    "maxTokenLength": 32768,
    "maxReturnTokens": 8192,
    "maxImageSize": 5242880,
    "supportsStreaming": true,
    "supportsVision": true,
    "geminiSafetySettings": [
        {
            "category": "HARM_CATEGORY",
            "threshold": "BLOCK_ONLY_HIGH"
        }
    ]
}
```

**Rate Limiting**: The `requestsPerSecond` parameter controls the rate limiting for each model endpoint. If not specified, Cortex defaults to **100 requests per second** per endpoint. This rate limiting is implemented using the Bottleneck library with a token bucket algorithm that includes:
- Minimum time between requests (`minTime`)
- Maximum concurrent requests (`maxConcurrent`)
- Token reservoir that refreshes every second
- Optional Redis clustering support when `storageConnectionString` is configured

### API Compatibility

Cortex provides OpenAI-compatible REST endpoints that allow you to use various models through a standardized interface. When `enableRestEndpoints` is set to `true`, Cortex exposes the following endpoints:

- `/v1/models`: List available models
- `/v1/chat/completions`: Chat completion endpoint
- `/v1/completions`: Text completion endpoint

This means you can use Cortex with any client library or tool that supports the OpenAI API format. For example:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:4000/v1",  # Point to your Cortex server
    api_key="your-key"  # If you have configured cortexApiKeys
)

response = client.chat.completions.create(
    model="gpt-4",  # Or any model configured in Cortex
    messages=[{"role": "user", "content": "Hello!"}]
)
```

#### Ollama Integration

Cortex includes built-in support for Ollama models through its OpenAI-compatible REST interface. When `ollamaUrl` is configured in your settings, Cortex will:
1. Automatically discover and expose all available Ollama models through the `/v1/models` endpoint with an "ollama-" prefix
2. Route any requests using an "ollama-" prefixed model to the appropriate Ollama endpoint

To enable Ollama support, add the following to your configuration:

```json
{
    "enableRestEndpoints": true,
    "ollamaUrl": "http://localhost:11434"  // or your Ollama server URL
}
```

You can then use any Ollama model through the standard OpenAI-compatible endpoints:

```bash
# List available models (will include Ollama models with "ollama-" prefix)
curl http://localhost:4000/v1/models

# Use an Ollama model for chat
curl http://localhost:4000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ollama-llama2",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'

# Use an Ollama model for completions
curl http://localhost:4000/v1/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "ollama-codellama",
    "prompt": "Write a function that"
  }'
```

This integration allows you to seamlessly use local Ollama models alongside cloud-based models through a single, consistent interface.

### Other Configuration Properties

The following properties can be configured through environment variables or the configuration file:

- `basePathwayPath`: The path to the base pathway (the prototype pathway) for Cortex. Default is path.join(__dirname, 'pathways', 'basePathway.js').
- `corePathwaysPath`: The path to the core pathways for Cortex. Default is path.join(__dirname, 'pathways').
- `cortexApiKeys`: A string containing one or more comma separated API keys that the client must pass to Cortex for authorization. Default is null.
- `cortexConfigFile`: The path to a JSON configuration file for the project. Default is null.
- `cortexId`: Identifier for the Cortex instance. Default is 'local'.
- `defaultModelName`: The default model name for the project. Default is null.
- `enableCache`: Enable Axios-level request caching. Default is true.
- `enableDuplicateRequests`: Enable sending duplicate requests if not completed after timeout. Default is true.
- `enableGraphqlCache`: Enable GraphQL query caching. Default is false.
- `enableRestEndpoints`: Create REST endpoints for pathways as well as GraphQL queries. Default is false.
- `gcpServiceAccountKey`: GCP service account key for authentication. Default is null.
- `models`: Object containing the different models used by the project.
- `pathways`: Object containing pathways for the project.
- `pathwaysPath`: Path to custom pathways. Default is './pathways'.
- `PORT`: Port number for the Cortex server. Default is 4000.
- `redisEncryptionKey`: Key for Redis data encryption. Default is null.
- `replicateApiKey`: API key for Replicate services. Default is null.
- `runwareAiApiKey`: API key for Runware AI services. Default is null.
- `storageConnectionString`: Connection string for storage access. Default is empty string.
- `subscriptionKeepAlive`: Keep-alive time for subscriptions in seconds. Default is 0.

API-specific configuration:
- `azureVideoTranslationApiKey`: API key for Azure video translation API. Default is null.
- `dalleImageApiUrl`: URL for DALL-E image API. Default is 'null'.
- `neuralSpaceApiKey`: API key for NeuralSpace services. Default is null.
- `whisperMediaApiUrl`: URL for Whisper media API. Default is 'null'.
- `whisperTSApiUrl`: URL for Whisper TS API. Default is null.

Dynamic Pathways configuration can be set using:
- `DYNAMIC_PATHWAYS_CONFIG_FILE`: Path to JSON configuration file
- `DYNAMIC_PATHWAYS_CONFIG_JSON`: JSON configuration as a string

The configuration supports environment variable overrides, with environment variables taking precedence over the configuration file values. Access configuration values using:
```js
config.get('propertyName')
```

## Helper Apps
The Cortex project includes a set of utility applications, which are located in the `helper-apps` directory. Each of these applications comes with a Dockerfile. This Dockerfile can be used to create a Docker image of the application, which in turn allows the application to be run in a standalone manner using Docker.

### cortex-realtime-voice-server
A real-time voice processing server that enables voice interactions with Cortex. Key features include:
- Real-time audio streaming and processing
- WebSocket-based communication for low-latency interactions
- Audio visualization capabilities
- Support for multiple audio formats
- Integration with various chat models for voice-to-text-to-voice interactions
- Configurable audio parameters and processing options

### cortex-whisper-wrapper
A custom API wrapper for OpenAI's Whisper package, designed as a FastAPI server for transcribing audio files. Features include:
- Support for multiple audio file formats
- Customizable transcription parameters:
  - `word_timestamps`: Enable word-level timing information
  - `highlight_words`: Enable word highlighting in output
  - `max_line_count`: Control maximum lines in output
  - `max_line_width`: Control line width in characters
  - `max_words_per_line`: Control words per line
- SRT file generation for subtitles
- Progress reporting for long-running transcriptions
- Support for multiple languages
- Integration with Azure Blob Storage for file handling

### cortex-file-handler
Extends Cortex with several file processing capabilities:
- File operations (download, split, upload) with local file system or Azure Storage
- Support for various file types:
  - Documents (.pdf, .docx)
  - Spreadsheets (.xlsx, .csv)
  - Text files (.txt, .json, .md, .xml)
  - Web files (.js, .html, .css)
- YouTube URL processing
- Progress reporting for file operations
- Cleanup and deletion management

Each helper app can be deployed independently using Docker:
```sh
# Build the Docker image
docker build --platform=linux/amd64 -t [app-name] .

# Tag the image for your registry
docker tag [app-name] [registry-url]/cortex/[app-name]

# Push to registry (optional login may be required)
docker push [registry-url]/cortex/[app-name]
```

## Troubleshooting
If you encounter any issues while using Cortex, there are a few things you can do. First, check the Cortex documentation for any common errors and their solutions. If that does not help, you can also open an issue on the Cortex GitHub repository.

## Contributing
If you would like to contribute to Cortex, there are two ways to do so. You can submit issues to the Cortex GitHub repository or submit pull requests with your proposed changes.

## License
Cortex is released under the MIT License. See [LICENSE](https://github.com/aj-archipelago/cortex/blob/main/LICENSE) for more details.

## API Reference
Detailed documentation on Cortex's API can be found in the /graphql endpoint of your project. Examples of queries and responses can also be found in the Cortex documentation, along with tips for getting the most out of Cortex.

## Roadmap
Cortex is a constantly evolving project, and the following features are coming soon:

* Prompt execution context preservation between calls (to enable interactive, multi-call integrations with other technologies)
* Model-specific cache key optimizations to increase hit rate and reduce cache size
* Structured analytics and reporting on AI API call frequency, cost, cache hit rate, etc.

## Dynamic Pathways

Cortex supports dynamic pathways, which allow for the creation and management of pathways at runtime. This feature enables users to define custom pathways without modifying the core Cortex codebase.

### How It Works

1. Dynamic pathways are stored either locally or in cloud storage (Azure Blob Storage or AWS S3).
2. The `PathwayManager` class handles loading, saving, and managing these dynamic pathways.
3. Dynamic pathways can be added, updated, or removed via GraphQL mutations.

### Configuration

To use dynamic pathways, you need to provide a JSON configuration file or a JSON string. There are two ways to specify this configuration:

1. Using a configuration file:
   Set the `DYNAMIC_PATHWAYS_CONFIG_FILE` environment variable to the path of your JSON configuration file.

2. Using a JSON string:
   Set the `DYNAMIC_PATHWAYS_CONFIG_JSON` environment variable with the JSON configuration as a string.

The configuration should include the following properties:

```json
{
  "storageType": "local" | "azure" | "s3",
  "filePath": "./dynamic/pathways.json",  // Only for local storage
  "azureStorageConnectionString": "your_connection_string",  // Only for Azure
  "azureContainerName": "cortexdynamicpathways",  // Optional, default is "cortexdynamicpathways"
  "awsAccessKeyId": "your_access_key_id",  // Only for AWS S3
  "awsSecretAccessKey": "your_secret_access_key",  // Only for AWS S3
  "awsRegion": "your_aws_region",  // Only for AWS S3
  "awsBucketName": "cortexdynamicpathways",  // Optional, default is "cortexdynamicpathways"
  "publishKey": "your_publish_key"
}
```

### Storage Options

1. Local Storage (default):
   - Set `storageType` to `"local"`
   - Specify `filePath` for the local JSON file (default: "./dynamic/pathways.json")

2. Azure Blob Storage:
   - Set `storageType` to `"azure"`
   - Provide `azureStorageConnectionString`
   - Optionally set `azureContainerName` (default: "cortexdynamicpathways")

3. AWS S3:
   - Set `storageType` to `"s3"`
   - Provide `awsAccessKeyId`, `awsSecretAccessKey`, and `awsRegion`
   - Optionally set `awsBucketName` (default: "cortexdynamicpathways")

### Usage

Dynamic pathways can be managed through GraphQL mutations. Here are the available operations:

1. Adding or updating a pathway:

```graphql
mutation PutPathway($name: String!, $pathway: PathwayInput!, $userId: String!, $secret: String!, $displayName: String, $key: String!) {
  putPathway(name: $name, pathway: $pathway, userId: $userId, secret: $secret, displayName: $displayName, key: $key) {
    name
  }
}
```

2. Deleting a pathway:

```graphql
mutation DeletePathway($name: String!, $userId: String!, $secret: String!, $key: String!) {
  deletePathway(name: $name, userId: $userId, secret: $secret, key: $key)
}
```

3. Executing a dynamic pathway:

```graphql
query ExecuteWorkspace($userId: String!, $pathwayName: String!, $text: String!) {
  executeWorkspace(userId: $userId, pathwayName: $pathwayName, text: $text) {
    result
  }
}
```

### Security

To ensure the security of dynamic pathways:

1. A `publishKey` must be set in the dynamic pathways configuration to enable pathway publishing.
2. This key must be provided in the `key` parameter when adding, updating, or deleting pathways.
3. Each pathway is associated with a `userId` and `secret`. The secret must be provided to modify or delete an existing pathway.

### Synchronization across multiple instances

Each instance of Cortex maintains its own local cache of pathways. On every dynamic pathway request, it checks if the local cache is up to date by comparing the last modified timestamp of the storage with the last update time of the local cache. If the local cache is out of date, it reloads the pathways from storage.

This approach ensures that all instances of Cortex will eventually have access to the most up-to-date dynamic pathways without requiring immediate synchronization.

## Entity System

Cortex includes a powerful Entity System that allows you to build autonomous agents with memory, tool routing, and multi-modal interaction capabilities. These entities can be accessed synchronously or asynchronously through text or voice interfaces.

### Overview

The Entity System is built around two core pathways:
- `sys_entity_start.js`: The entry point for entity interactions, handling initial routing and tool selection
- `sys_entity_continue.js`: Manages callback execution in synchronous mode

### Key Features

- **Memory Management**: Entities maintain contextual memory that can be self-modified
- **Tool Routing**: Automatic detection and routing to specialized tools:
  - Code execution
  - Image generation and vision processing
  - Video and audio processing
  - Document handling
  - Expert reasoning
  - Search capabilities
  - Memory operations
- **Multi-Modal Support**: Handle text, voice, images, and other content types
- **Flexible Response Modes**:
  - Synchronous: Complete interactions with callbacks
  - Asynchronous: Fire-and-forget operations with queue support
  - Streaming: Real-time response streaming
- **Voice Integration**: Built-in voice response capabilities with acknowledgment system

### Basic Usage

Using Apollo Client (or any GraphQL client):

```js
import { ApolloClient, InMemoryCache, gql } from '@apollo/client';

const client = new ApolloClient({
  uri: 'http://your-cortex-server:4000/graphql',
  cache: new InMemoryCache()
});

// Define your queries
const START_ENTITY = gql`
  query StartEntity(
    $chatHistory: [ChatMessageInput!]!
    $aiName: String
    $contextId: String
    $aiMemorySelfModify: Boolean
    $aiStyle: String
    $voiceResponse: Boolean
    $stream: Boolean
  ) {
    entityStart(
      chatHistory: $chatHistory
      aiName: $aiName
      contextId: $contextId
      aiMemorySelfModify: $aiMemorySelfModify
      aiStyle: $aiStyle
      voiceResponse: $voiceResponse
      stream: $stream
    ) {
      result
      tool
    }
  }
`;

const CONTINUE_ENTITY = gql`
  query ContinueEntity(
    $chatHistory: [ChatMessageInput!]!
    $contextId: String!
    $generatorPathway: String!
  ) {
    entityContinue(
      chatHistory: $chatHistory
      contextId: $contextId
      generatorPathway: $generatorPathway
    ) {
      result
    }
  }
`;

// Example usage
async function interactWithEntity() {
  // Start an entity interaction
  const startResponse = await client.query({
    query: START_ENTITY,
    variables: {
      chatHistory: [
        { role: 'user', content: 'Create a Python script that calculates prime numbers' }
      ],
      aiName: "Jarvis",
      contextId: "session-123",
      aiMemorySelfModify: true,
      aiStyle: "OpenAI",
      voiceResponse: false,
      stream: false
    }
  });

  // Handle tool routing response
  const tool = JSON.parse(startResponse.data.entityStart.tool);
  
  if (tool.toolCallbackName) {
    // Continue with specific tool if needed
    const continueResponse = await client.query({
      query: CONTINUE_ENTITY,
      variables: {
        chatHistory: [
          { role: 'user', content: 'Create a Python script that calculates prime numbers' },
          { role: 'assistant', content: startResponse.data.entityStart.result }
        ],
        contextId: "session-123",
        generatorPathway: tool.toolCallbackName
      }
    });
    
    return continueResponse.data.entityContinue.result;
  }

  return startResponse.data.entityStart.result;
}

// For streaming responses
const STREAM_ENTITY = gql`
  subscription StreamEntity(
    $chatHistory: [ChatMessageInput!]!
    $contextId: String!
    $aiName: String
  ) {
    entityStream(
      chatHistory: $chatHistory
      contextId: $contextId
      aiName: $aiName
    ) {
      content
      done
    }
  }
`;

// Example streaming usage
client.subscribe({
  query: STREAM_ENTITY,
  variables: {
    chatHistory: [
      { role: 'user', content: 'Explain quantum computing' }
    ],
    contextId: "session-123",
    aiName: "Jarvis"
  }
}).subscribe({
  next(response) {
    if (response.data.entityStream.content) {
      console.log(response.data.entityStream.content);
    }
    if (response.data.entityStream.done) {
      console.log('Stream completed');
    }
  },
  error(err) {
    console.error('Error:', err);
  }
});
```

This example demonstrates:
- Setting up a GraphQL client
- Starting an entity interaction
- Handling tool routing responses
- Continuing with specific tools when needed
- Using streaming for real-time responses

### Configuration Options

- `aiName`: Custom name for the entity
- `aiStyle`: Choose between "OpenAI" or "Anthropic" response styles
- `aiMemorySelfModify`: Enable/disable autonomous memory management
- `voiceResponse`: Enable voice responses with acknowledgments
- `stream`: Enable response streaming
- `dataSources`: Array of data sources to use ["mydata", "aja", "aje", "wires", "bing"]
- `privateData`: Flag for handling private data
- `language`: Preferred language for responses

### Tool Integration

The Entity System automatically routes requests to appropriate tools based on content analysis:

1. **Code Execution**:
   - Detects coding tasks
   - Routes to async execution queue
   - Returns progress updates

2. **Content Generation**:
   - Image generation
   - Expert writing
   - Reasoning tasks
   - Document processing

3. **Search and Memory**:
   - Integrated search capabilities
   - Memory context retrieval
   - Document analysis

4. **Multi-Modal Processing**:
   - Vision analysis
   - Video processing
   - Audio handling
   - PDF processing

### Memory System

Entities maintain a sophisticated memory system that:
- Preserves context between interactions
- Self-modifies based on interactions
- Categorizes information
- Provides relevant context for future interactions

### Best Practices

1. **Context Management**:
   - Use consistent `contextId` for related interactions
   - Limit chat history to recent messages for efficiency

2. **Tool Selection**:
   - Let the entity auto-route to appropriate tools
   - Override routing with specific `generatorPathway` when needed

3. **Memory Usage**:
   - Enable `aiMemorySelfModify` for autonomous memory management
   - Use memory context for more coherent interactions

4. **Response Handling**:
   - Use streaming for real-time interactions
   - Enable voice responses for voice interfaces
   - Handle async operations with appropriate timeouts

## Redis Integration

Cortex uses Redis as both a storage system and a communication backplane:

### Memory and Context Storage

- **Entity Memory**: Stores and searches entity memory contexts using `contextId` as the key
- **Context Persistence**: Saves pathway context between executions

### Inter-Service Communication

- **Distributed Deployment**: Enables communication between multiple Cortex instances
- **Helper App Integration**: Facilitates communication with auxiliary services:
  - File Handler: Progress updates and file operation status
  - Autogen: Message queuing and async task management
  - Voice Server: Real-time streaming coordination
  - Whisper Wrapper: Transcription job management
- **Pub/Sub Messaging**: Supports real-time event distribution across services
- **Queue Management**: Handles asynchronous task distribution and processing

### Caching

- **Request Caching**: When `enableCache` is true, caches model responses to avoid duplicate API calls
- **GraphQL Caching**: When `enableGraphqlCache` is true, caches GraphQL query results
- **Cache Encryption**: Uses `redisEncryptionKey` to encrypt sensitive cached data

### Configuration

Redis connection can be configured through environment variables:

```sh
# Required
REDIS_URL=redis://your-redis-host:6379

# Optional
REDIS_ENCRYPTION_KEY=your-encryption-key  # For encrypted caching
REDIS_PASSWORD=your-redis-password        # If authentication is required
REDIS_TLS=true                           # For TLS/SSL connections
REDIS_CONNECTION_STRING=                  # Full connection string (alternative to URL)
```

### Cache Management

Cortex implements intelligent cache management:
- Automatic cache invalidation based on TTL
- Model-specific cache keys for optimized hit rates
- Cache size management to prevent memory overflow
- Support for cache clearing through API endpoints

### Best Practices

1. **Memory Storage**:
   - Use consistent `contextId` values for related operations
   - Implement regular memory cleanup for unused contexts
   - Monitor memory usage to prevent Redis memory overflow

2. **Caching**:
   - Enable caching for frequently repeated queries
   - Use encryption for sensitive data
   - Monitor cache hit rates for optimization

3. **High Availability**:
   - Configure Redis persistence for data durability
   - Use Redis clustering for scalability
   - Implement failover mechanisms for reliability

4. **Communication**:
   - Use appropriate channels for different types of messages
   - Implement retry logic for critical operations
   - Monitor queue lengths and processing times
   - Set up proper error handling for pub/sub operations
