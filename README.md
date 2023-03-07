# Cortex
Cortex is an extensible and open-source caching GraphQL API that provides an abstraction layer for interacting with modern natural language AI models. It simplifies and accelerates the task of querying NL AI models (e.g. LLMs like GPT-3) by providing a structured interface to the largely unstructured world of AI prompting.

## Why build Cortex?
Using modern NL AI models can be complex and costly. Most models require precisely formatted, carefully engineered and sequenced prompts to produce consistent results, and the responses are typically largely unstructured text without validation or formatting. Additionally, these models are evolving rapidly, are typically costly and slow to query and implement hard request size and rate restrictions that need to be carefully navigated for optimum throughput.  Cortex offers a solution to these problems and provides a simple and extensible package for interacting with NL AI models.

## Features

* Simple architecture to build functional endpoints (called `pathways`), that implement common NL AI tasks. Included core pathways include chat, summarization, translation, rewrites, completion, spelling and grammar correction, entity extraction, topic classification, sentiment analysis, and bias analysis.
* Allows for building multi-model, multi-vendor, and model-agnostic pathways (choose the right model or combination of models for the job, implement redundancy)
* Easy, templatized prompt definition with flexible support for most prompt engineering techniques and strategies ranging from simple, single prompts to complex prompt chains with context continuity.
* Integrated context persistence: have your pathways "remember" whatever you want and use it on the next request to the model
* Automatic traffic management and content optimization: configurable model-specific input chunking, request parallelization, rate limiting, and chunked response aggregation
* Extensible parsing and validation of input data - protect your model calls from bad inputs or filter prompt injection attempts.
* Extensible parsing and validation of return data - return formatted objects to your application instead of just string blobs!
* Caching of repeated queries to provide instant results and avoid excess requests to the underlying model in repetitive use cases (chat bots, unit tests, etc.)

## Installation
In order to use Cortex, you must first have a working Node.js environment. The version of Node.js should be at least 14 or higher. After verifying that you have the correct version of Node.js installed, you can get the simplest form up and running with a couple of commands.
## Quick Start
```sh
git clone git@github.com:aj-archipelago/cortex.git
npm install
export OPENAI_API_KEY=<your key>
npm start
```
Yup, that's it, at least in the simplest possible case. That will get you access to all of the built in pathways.
## Using Cortex
Cortex speaks GraphQL, and by default it enables the GraphQL playground. If you're just using default options, that's at [http://localhost:4000/graphql](http://localhost:4000/graphql). From there you can begin making requests and test out the pathways (listed under Query) to your heart's content.

When it's time to talk to Cortex from an app, that's simple as well - you just use standard GraphQL client conventions:

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
        console.error(e)
        setTranslatedText(`An error occurred while trying to get translation.\n\n${e.toString()}`);
    })
```
## Default Queries (pathways)
Below are the default pathways provided with Cortex. These can be used as is, overridden, or disabled via configuration. For documentation on each one including input and output parameters, please look at them in the GraphQL Playground.
- `bias`: Identifies and measures any potential biases in a text
- `chat`: Enables users to have a conversation with the chatbot
- `complete`: Autocompletes words or phrases based on user input
- `edit`: Checks for and suggests corrections for spelling and grammar errors
- `entities`: Identifies and extracts important entities from text
- `rewrite`: Suggests alternative phrasing for text
- `sentiment`: Analyzes and identifies the overall sentiment or mood of a text
- `summarize`: Condenses long texts or articles into shorter summaries
- `topics`: Analyzes and identifies the main topic or subject of a text
- `translate`: Translates text from one language to another
## Extensibility
Cortex is designed to be highly extensible. This allows you to customize the API to fit your needs. You can add new features, modify existing features, and even add integrations with other APIs and models.
## Configuration
Configuration of Cortex is done via a [convict](https://github.com/mozilla/node-convict/tree/master) object called `config`. The `config` object is built by combining the default values and any values specified in a configuration file or environment variables. The environment variables take precedence over the values in the configuration file. Below are the configurable properties and their defaults:

- `basePathwayPath`: The path to the base pathway (the prototype pathway) for Cortex. Default properties for the pathway are set from their values in this basePathway. Default is path.join(__dirname, 'pathways', 'basePathway.js').
- `corePathwaysPath`: The path to the core pathways for Cortex. Default is path.join(__dirname, 'pathways').
- `cortexConfigFile`: The path to a JSON configuration file for the project. Default is null. The value can be set using the `CORTEX_CONFIG_FILE` environment variable.
- `defaultModelName`: The default model name for the project. Default is null. The value can be set using the `DEFAULT_MODEL_NAME` environment variable.
- `enableCache`: A boolean flag indicating whether to enable caching. Default is true. The value can be set using the `CORTEX_ENABLE_CACHE` environment variable.
- `models`: An object containing the different models used by the project. The default value contains an example OpenAI text-davinci-003 model configuration. The value can be set using the `CORTEX_MODELS` environment variable. Cortex is model and vendor agnostic - you can use this config to set up models of any type from any vendor.
- `openaiApiKey`: The API key used for accessing the OpenAI API. This is sensitive information and has no default value. The value can be set using the `OPENAI_API_KEY` environment variable.
- `openaiApiUrl`: The URL used for accessing the OpenAI API. Default is https://api.openai.com/v1/completions. The value can be set using the `OPENAI_API_URL` environment variable.
- `openaiDefaultModel`: The default model name used for the OpenAI API. Default is text-davinci-003. The value can be set using the `OPENAI_DEFAULT_MODEL` environment variable.
- `pathways`: An object containing pathways for the project. The default is an empty object that is filled in during the `buildPathways` step.
- `pathwaysPath`: The path to custom pathways for the project. Default is null.
- `PORT`: The port number for the Cortex server. Default is 4000. The value can be set using the `CORTEX_PORT` environment variable.
- `storageConnectionString`: The connection string used for accessing storage. This is sensitive information and has no default value. The value can be set using the `STORAGE_CONNECTION_STRING` environment variable.

The `buildPathways` function takes the config object and builds the `pathways` object by loading the core pathways and any custom pathways specified in the `pathwaysPath` property of the config object. The function returns the `pathways` object.

The `buildModels` function takes the `config` object and builds the `models` object by compiling handlebars templates for each model specified in the `models` property of the config object. The function returns the `models` object.

The `config` object can be used to access configuration values throughout the project. For example, to get the port number for the server, use 
```js
config.get('PORT')
```
## Pathways
Pathways are a core concept in Cortex. They let users define new functionality and extend the platform. Each pathway is a single JavaScript file that encapsulates the data and logic needed to define a functional API endpoint. Effectively, pathways define how a request from a client is processed when sent to Cortex.

To add a new pathway to Cortex, you create a new JavaScript file and define the prompts, properties, and functions that define the function you want to implement. Cortex provides defaults for almost everything, so in the simplest case a pathway can really just consist of a string prompt. You can then save this file in the `pathways` directory in your Cortex project and it will be picked up and made available as a GraphQL query.

Example of a very simple pathway (`spelling.js`):
```js
module.exports = {
    prompt: `{{text}}\n\nRewrite the above using British English spelling:`
}
```
### Prompt
When you define a new pathway, you need to at least specify a prompt that will be passed to the model for processing. In the simplest case, a prompt is really just a string, but the prompt is polymorphic - it can be a string or an object that contains information for the model API that you wish to call. Prompts can also be an array of strings or an array of objects for sequential operations. In this way Cortex aims to support the most simple to advanced prompting scenarios.

In the above example, the pathway simply prompts the model to rewrite some text using British English spelling. If you look closely, you'll notice the embedded `{{text}}` parameter. In Cortex, all prompt strings are actually [Handlebars](https://handlebarsjs.com/) templates. So in this case, that parameter will be replaced before prompt execution with the incoming query variable called `text`. You can refer to almost any pathway parameter or system property in the prompt definition and it will be replaced before execution.

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
module.exports = {
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
## Custom Pathways
Pathways in Cortex OS are implemented as JavaScript files that export a module. A pathway module is an object that contains properties that define the prompts and behavior of the pathway. Most properties have functional defaults, so you can only implement the bits that are important to you. The main properties of a pathway module are:

* `prompt`: The prompt that the pathway uses to interact with the model.
* `inputParameters`: Any custom parameters to the GraphQL query that the pathway requires to run.
* `resolver`: The resolver function that processes the input, executes the prompts, and returns the result.
* `parser`: The parser function that processes the output from the prompts and formats the result for return.

### Custom Resolver
The resolver property defines the function that processes the input and returns the result. The resolver function is an asynchronous function that takes four parameters: `parent`, `args`, `contextValue`, and `info`. The `parent` parameter is the parent object of the resolver function. The `args` parameter is an object that contains the input parameters and any other parameters that are passed to the resolver. The `contextValue` parameter is an object that contains the context and configuration of the pathway. The `info` parameter is an object that contains information about the GraphQL query that triggered the resolver.

The core pathway `summary.js` below is implemented using custom pathway logic and a custom resolver to effectively target a specific summary length:

```js
const { semanticTruncate } = require('../graphql/chunker');
const { PathwayResolver } = require('../graphql/pathwayResolver');

module.exports = {
    prompt: `{{{text}}}\n\nWrite a summary of the above text:\n\n`,

    inputParameters: {
        targetLength: 500,
    },
    resolver: async (parent, args, contextValue, info) => {
        const { config, pathway, requestState } = contextValue;
        const originalTargetLength = args.targetLength;
        const errorMargin = 0.2;
        const lowTargetLength = originalTargetLength * (1 - errorMargin);
        const targetWords = Math.round(originalTargetLength / 6.6);

        // if the text is shorter than the summary length, just return the text
        if (args.text.length <= originalTargetLength) {
            return args.text;
        }

        const MAX_ITERATIONS = 5;
        let summary = '';
        let bestSummary = '';
        let pathwayResolver = new PathwayResolver({ config, pathway, requestState });
        // modify the prompt to be words-based instead of characters-based
        pathwayResolver.pathwayPrompt = `{{{text}}}\n\nWrite a summary of the above text in exactly ${targetWords} words:\n\n`

        let i = 0;
        // reprompt if summary is too long or too short
        while (((summary.length > originalTargetLength) || (summary.length < lowTargetLength)) && i < MAX_ITERATIONS) {
            summary = await pathwayResolver.resolve(args);
            i++;
        }

        // if the summary is still too long, truncate it
        if (summary.length > originalTargetLength) {
            return semanticTruncate(summary, originalTargetLength);
        } else {
            return summary;
        }
    }
}
```
### Building and Loading Pathways
Pathways are loaded from modules in the `pathways` directory. The pathways are built and loaded to the `config` object using the `buildPathways` function. The `buildPathways` function loads the base pathway, the core pathways, and any custom pathways. It then creates a new object that contains all the pathways and adds it to the pathways property of the config object. The order of loading means that custom pathways will always override any core pathways that Cortext provides. While pathways are designed to be self-contained, you can override some pathway properties - including whether they're even available at all - in the `pathways` section of the config file.

## Troubleshooting
If you encounter any issues while using Cortex, there are a few things you can do. First, check the Cortex documentation for any common errors and their solutions. If that does not help, you can also open an issue on the Cortex GitHub repository.

## Contributing
If you would like to contribute to Cortex, there are two ways to do so. You can submit issues to the Cortex GitHub repository or submit pull requests with your proposed changes.

## License
Cortex is released under the MIT License. See [LICENSE](https://github.com/ALJAZEERAPLUS/cortex/blob/main/LICENSE) for more details.

## API Reference
Detailed documentation on Cortex's API can be found in the /graphql endpoint of your project. Examples of queries and responses can also be found in the Cortex documentation, along with tips for getting the most out of Cortex.

## Roadmap
Cortex is a constantly evolving project, and the following features are coming soon:

* Model-specific cache key optimizations to increase hit rate and reduce cache size
* Structured analytics and reporting on AI API call frequency, cost, cache hit rate, etc.
