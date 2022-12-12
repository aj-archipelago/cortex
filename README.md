# Cortex

Cortex is a caching GraphQL API that provides an abstraction layer for interacting with modern natural language AI models. It’s extensible, open-sourced, and model-agnostic and provides a structured interface to the largely unstructured world of AI prompting.

## Why build Cortex?

Querying modern NL AI models (e.g. GPT-3) can be costly and cumbersome. Executing queries against large models like Davinci is very resource intensive and can result in excessive resource usage and cloud service charges. Additionally, querying can be complicated as most models require very specific formatting for consistent results and the returns are often free-form text without proper validation or formatting. Cortex solves these problems by providing a simple and extensible package for querying NL AI models.

## Features

1. Extensible abstraction of common NL AI tasks from the underlying models including:
   - Summarization
   - Entity extraction
   - Topic classification
   - Headline generation
   - Translation
   - Rewrites
   - Completion
   - Sentiment analysis
   - Bias analysis
   - Spelling and grammar correction
   - Style guide rule application

2. Definition of structured requests and returns
   - Easily configurable chunking and prompting strategies per task and per model using a simple prompt template format
   - Parallelization of chunked requests to the model layer for response acceleration
   - Encapsulation of prompting and parsing for structured return data (e.g. generation of lists as proper data structures instead of text blocks)

3. Caching of repeated queries to avoid excess requests to the base model in repetitive use cases (chat bots, unit tests, etc.)
   - Model-specific cache key optimizations to increase hit rate and reduce cache size
5. Insulation against emerging prompt-specific security concerns
   - Configurable prompt and return validation and sanitation
7. Structured analytics and reporting on AI API call frequency, cost, cache hit rate, etc.

## Getting Started

To use Cortex, simply install the package and initialize a Cortex instance with your desired NL AI model.

```
npm install archipelago-cortex
```

```
const Cortex = require('archipelago-cortex');
const cortex = new Cortex('myNLModel');
```

Then, use the provided GraphQL schema to make queries and receive structured data in return.

For more detailed usage instructions, see the [documentation](http://cortex.archipelago.com/docs).

## Contributions

We welcome contributions to Cortex! Please see our [contributing guidelines](http://cortex.archipelago.com/contributing) for more information.

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