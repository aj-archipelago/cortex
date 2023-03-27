const { ApolloServer } = require('apollo-server');
const { config } = require('../config');
const { typeDefs, resolvers } = require('../index')();

jest.setTimeout(60000);

const getTestServer = () => {
    return new ApolloServer({
        typeDefs,
        resolvers,
        context: () => ({ config, requestState: {} }),
    });
}

const testServer = getTestServer();

//stop server after all tests
afterAll(async () => {
    await testServer.stop();
});

it('validates bias endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query bias($text: String!) { bias(text: $text) { result } }',
        variables: { text: 'hello there my dear world!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.bias?.result).toMatch(/(yes|no|bias)/i)
});

it('validates completion endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query complete($text: String!) { complete(text: $text) { result } }',
        variables: { text: 'hello there my dear world!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.complete?.result.length).toBeGreaterThan(0);
});

it('validates entities endpoint with given num of count return', async () => {
    const response = await testServer.executeOperation({
        query: 'query entities($text: String!, $count: Int) { entities(text: $text, count: $count){ result { name, definition } } }',
        variables: { text: 'hello there my dear world!', count: 3 },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.entities.result.length).toBe(3);
    response.data?.result?.entities.forEach((entity) => {
        expect(entity.name).toBeDefined();
        expect(entity.definition).toBeDefined();
    });
});

it('validates paraphrase endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query paraphrase($text: String!) { paraphrase(text: $text) { result } }',
        variables: { text: 'hello there my dear world!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.paraphrase?.result).toBeDefined();
});

it('validates sentiment endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query sentiment($text: String!) { sentiment(text: $text) { result } }',
        variables: { text: 'hello there my dear world!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.sentiment.result).toBeDefined();
});

it('validates edit endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query edit($text: String!) { edit(text: $text) { result } }',
        variables: { text: 'helo there my dear worldd!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.edit.result).toMatch(/hello.*world/i);
});

it('validates summary endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query summary($text: String!) { summary(text: $text) { result } }',
        variables: { text: 'hello there my dear world!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.summary.result).toBeDefined();
});

module.exports = {
    getTestServer,
};