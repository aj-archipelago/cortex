# Cortex
Cortex is an extensible and open-source caching GraphQL API that provides an abstraction layer for interacting with modern natural language AI models. It simplifies and accelerates the task of querying NL AI models (e.g. LLMs like GPT-3) by providing a structured interface to the largely unstructured world of AI prompting.

## Why build Cortex?
Using modern NL AI models can be complex and costly. Most models require precisely formatted, carefully engineered and sequenced prompts to produce consistent results, and the completions are typically unstructured text without proper validation or formatting. Additionally, these models are typically costly and slow to query and implement hard request size and rate restrictions that need to be carefully navigated for optimum throughput.  Cortex offers a solution to these problems and provides a simple and extensible package for interacting with NL AI models.

## Features

* Simple architecture to build functional endpoints (called `pathways`), that implement common NL AI tasks. Included core pathways include summarization, translation, rewrites, completion, spelling and grammar correction, style guide rule application, entity extraction, topic classification, headline generation, sentiment analysis, and bias analysis.
* Allows for building multi-model, multi-vendor, and model-agnostic pathways (choose the right model or combination of models for the job, implement redundancy)
* Easy, templatized prompt definition with flexible support for most prompt engineering techniques and strategies ranging from simple, single prompts to complex prompt chains with context continuity.
* Integrated context persistence: have your pathways "remember" whatever you want and use it on the next request to the model
* Automatic traffic management and content optimization: configurable model-specific input chunking, request parallelization, rate limiting, and chunked response aggregation
* Extensible parsing and validation of input data - protect your model calls from bad inputs or filter prompt injection attempts.
* Extensible parsing and validation of return data - return formatted objects to your application instead of just string blobs!
* Caching of repeated queries to provide instant results and avoid excess requests to the underlying model in repetitive use cases (chat bots, unit tests, etc.)

## Coming soon

* Model-specific cache key optimizations to increase hit rate and reduce cache size
* Structured analytics and reporting on AI API call frequency, cost, cache hit rate, etc.

## Installation
In order to use Cortex, you must first have a working Node.js environment. The version of Node.js should be at least 8.9.0 or higher. After verifying that you have the correct version of Node.js installed, you can then proceed to install the Cortex dependencies. This is done by running the command `npm install --save cortex` in your project directory. Finally, you will need to set up the environment variables needed for the config.json file.

## Using Cortex
To use Cortex, you will first need to access the GraphQL playground. This is done by navigating to the `/graphql` endpoint of your project. From there, you can begin making requests and getting responses.

When making requests, you must use the GraphQL query language. This language has a specific syntax and structure, and different types of values. To get the most out of Cortex, it is important to understand how these work.

Examples of queries and responses can be found in the Cortex documentation. These examples can help you get started making requests and getting responses.

In addition to the examples, there are also some tips for getting the most out of Cortex. These include using variables in your queries, using aliases to rename fields, and using directives to conditionally include or exclude fields.

## Extensibility
Cortex is designed to be highly extensible. This allows you to customize the API to fit your needs. You can add new features, modify existing features, and even add integrations with other APIs.

## Analytics and Reporting
Cortex provides built-in analytics and reporting capabilities. This allows you to collect data and run reports on how the API is being used. This can be useful for tracking performance, debugging issues, and understanding usage patterns.

## Troubleshooting
If you encounter any issues while using Cortex, there are a few things you can do. First, check the Cortex documentation for any common errors and their solutions. If that does not help, you can also open an issue on the Cortex GitHub repository.

## Contributing
If you would like to contribute to Cortex, there are two ways to do so. You can submit issues to the Cortex GitHub repository or submit pull requests with your proposed changes.

## License
Cortex is released under the MIT License. See [LICENSE](https://github.com/ALJAZEERAPLUS/cortex/blob/main/LICENSE) for more details.

## Developer Setup
1. Check your NodeJS version. It should be 14 or above. 
```
node -v
```

2. Install dependencies
```
npm install
```

3. Set up any environment variables needed by your config json. The default config is at (config/default.json)
```
export OPENAI_API_KEY=<insert key>
export AZURE_OAI_API_KEY=<insert key>
```
4. Start the dev server
```
npm start
```
5. Go to http://localhost:4000 in your browser to access the GraphQL playground.
