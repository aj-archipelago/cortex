import test from 'ava';
import { ApolloServer } from 'apollo-server';
import { config } from '../config.js';
import typeDefsresolversFactory from '../index.js';

let typeDefs;
let resolvers;

const initTypeDefsResolvers = async () => {
  const result = await typeDefsresolversFactory();
  typeDefs = result.typeDefs;
  resolvers = result.resolvers;
};

const getTestServer = () => {
  return new ApolloServer({
    typeDefs,
    resolvers,
    context: () => ({ config, requestState: {} }),
  });
};

let testServer;

test.before(async () => {
  await initTypeDefsResolvers();
  testServer = getTestServer();
});

//stop server after all tests
test.after.always('cleanup', async () => {
  await testServer.stop();
});

test('validates bias endpoint', async (t) => {
    const response = await testServer.executeOperation({
        query: 'query bias($text: String!) { bias(text: $text) { result } }',
        variables: { text: 'hello there my dear world!' },
    });

    t.is(response.errors, undefined);
    t.regex(response.data?.bias?.result, /(yes|no|bias)/i);
});

test('validates completion endpoint', async (t) => {
    const response = await testServer.executeOperation({
        query: 'query complete($text: String!) { complete(text: $text) { result } }',
        variables: { text: 'hello there my dear world!' },
    });

    t.is(response.errors, undefined);
    t.true(response.data?.complete?.result.length > 0);
});

test('validates entities endpoint with given num of count return', async (t) => {
    const response = await testServer.executeOperation({
        query: 'query entities($text: String!, $count: Int) { entities(text: $text, count: $count){ result { name, definition } } }',
        variables: { text: 'hello there my dear world!', count: 3 },
    });

    t.is(response.errors, undefined);
    t.is(response.data?.entities.result.length, 3);
    response.data?.result?.entities.forEach((entity) => {
        t.truthy(entity.name);
        t.truthy(entity.definition);
    });
});

test('validates paraphrase endpoint', async (t) => {
    const response = await testServer.executeOperation({
        query: 'query paraphrase($text: String!) { paraphrase(text: $text) { result } }',
        variables: { text: 'hello there my dear world!' },
    });

    t.is(response.errors, undefined);
    t.truthy(response.data?.paraphrase?.result);
});

test('validates sentiment endpoint', async (t) => {
    const response = await testServer.executeOperation({
        query: 'query sentiment($text: String!) { sentiment(text: $text) { result } }',
        variables: { text: 'hello there my dear world!' },
    });

    t.is(response.errors, undefined);
    t.truthy(response.data?.sentiment.result);
});

test('validates edit endpoint', async (t) => {
    const response = await testServer.executeOperation({
        query: 'query edit($text: String!) { edit(text: $text) { result } }',
        variables: { text: 'helo there my dear worldd!' },
    });

    t.is(response.errors, undefined);
    t.regex(response.data?.edit.result, /hello.*world/i);
});

test('validates summary endpoint', async (t) => {
    const response = await testServer.executeOperation({
        query: 'query summary($text: String!) { summary(text: $text) { result } }',
        variables: { text: 'hello there my dear world!' },
    });

    t.is(response.errors, undefined);
    t.truthy(response.data?.summary.result);
});

export {
    initTypeDefsResolvers,
    getTestServer,
};