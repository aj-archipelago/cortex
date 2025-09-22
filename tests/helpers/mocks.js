import { Prompt } from '../../server/prompt.js';

export const mockConfig = {
    get: (key) => {
      const configs = {
        defaultModelName: 'testModel',
        models: {
          testModel: {
            name: 'testModel', 
            url: 'https://api.example.com/testModel',
            type: 'OPENAI-COMPLETION',
          },
        },
      };
      return configs[key];
    },
    getEnv: () => ({}),
  };
  
  export const mockPathwayString = {
    model: 'testModel',
    prompt: new Prompt('User: {{text}}\nAssistant: Please help {{name}} who is {{age}} years old.'),
  };

  export const mockPathwayFunction = {
    model: 'testModel',
    prompt: () => {
        return new Prompt('User: {{text}}\nAssistant: Please help {{name}} who is {{age}} years old.')
    },
  };

  export const mockPathwayMessages = {
    model: 'testModel',
    prompt: new Prompt({
        messages: [
          { role: 'user', content: 'Translate this: {{{text}}}' },
          { role: 'assistant', content: 'Translating: {{{text}}}' },
          { role: 'user', content: 'Nice work!' },
        ],
      }),
  };

  export const mockPathwayResolverString = {
    model: {
      name: 'testModel',
      url: 'https://api.example.com/testModel',
      type: 'OPENAI-COMPLETION',
    },
    modelName: 'testModel',
    pathway: mockPathwayString,
    config: mockConfig,
    prompt: new Prompt('User: {{text}}\nAssistant: Please help {{name}} who is {{age}} years old.'),
  };

  export const mockPathwayResolverFunction = {
    model: {
      name: 'testModel',
      url: 'https://api.example.com/testModel',
      type: 'OPENAI-COMPLETION',
    },
    modelName: 'testModel',
    pathway: mockPathwayFunction,
    config: mockConfig,
    prompt: () => {
        return new Prompt('User: {{text}}\nAssistant: Please help {{name}} who is {{age}} years old.')
    }
  };

  export const mockPathwayResolverMessages = {
    model: {
        name: 'testModel',
        type: 'OPENAI-CHAT',
        url: 'https://api.openai.com/v1/chat/completions',
        endpoints: [{
            name: 'Test Endpoint',
            url: 'https://api.openai.com/v1/chat/completions',
            headers: {
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
                'Content-Type': 'application/json'
            }
        }]
    },
    modelName: 'testModel',
    pathway: mockPathwayMessages,
    config: mockConfig,
    prompt: new Prompt({
        messages: [
          { role: 'user', content: 'Translate this: {{{text}}}' },
          { role: 'assistant', content: 'Translating: {{{text}}}' },
          { role: 'user', content: 'Nice work!' },
        ],
      }),
  };

  export const mockModelEndpoints = { 
    testModel: { name: 'testModel', url: 'https://api.example.com/testModel', type: 'OPENAI-COMPLETION' },
    anotherModel: { name: 'anotherModel', url: 'https://api.example.com/anotherModel', type: 'OPENAI-CHAT' }
  };