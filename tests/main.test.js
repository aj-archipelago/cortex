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

it('validates tags endpoint', async () => {
    const text = '\n\nistanbul\n\n'.repeat(1000);
    const response = await testServer.executeOperation({
        query: 'query ($text: String!) { tags(text: $text) { result } }',
        variables: { text },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.tags?.result).toBeDefined();
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

it('validates grammar endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query grammar($text: String!) { grammar(text: $text) { result } }',
        variables: { text: 'helo there my dear worldd!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.grammar.result).toMatch(/hello.*world/i);
});

it('validates headline endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query headline($text: String!) { headline(text: $text) { result } }',
        variables: { text: 'hello there my dear world!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.headline?.result?.length).toBeGreaterThan(0);
    response.data?.headline?.result.forEach((headline) => {
        expect(headline).toBeDefined();
    });
});

it('validates keywords endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query keywords($text: String!) { keywords(text: $text) { result } }',
        variables: { text: 'hello there my dear world!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.keywords?.result.length).toBeGreaterThan(0);
    response.data?.keywords.result.forEach((keyword) => {
        expect(keyword).toBeDefined();
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

it('validates pass endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query pass($text: String!) { pass(text: $text) { result } }',
        variables: { text: 'hello there my dear world!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.pass.result).toBeDefined();
});

it('validates sentiment endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query sentiment($text: String!) { sentiment(text: $text) { result } }',
        variables: { text: 'hello there my dear world!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.sentiment.result).toBeDefined();
});

it('validates spelling endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query spelling($text: String!) { spelling(text: $text) { result } }',
        variables: { text: 'helo there my dear worldd!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.spelling.result).toMatch(/hello.*world/i);
});

it('validates styleguide endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query styleguide($text: String!) { styleguide(text: $text) { result } }',
        variables: { text: 'helo there my dear worldd!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.styleguide.result).toMatch(/hello.*world/i);
});

it('validates styleguidemulti endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query styleguidemulti($text: String!) { styleguidemulti(text: $text) { result } }',
        variables: { text: 'helo there my dear worldd!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.styleguidemulti.result).toMatch(/hello.*world/i);
});

it('validates summary endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query summary($text: String!) { summary(text: $text) { result } }',
        variables: { text: 'hello there my dear world!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.summary.result).toBeDefined();
});

it('validates topics endpoint with given num of count return', async () => {
    const response = await testServer.executeOperation({
        query: 'query topics($text: String!, $count: Int) { topics(text: $text, count: $count) { result } }',
        variables: { text: 'hello there my dear world!', count: 3 },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.topics.result.length).toBe(3);
    response.data?.topics.result.forEach((topic) => {
        expect(topic).toBeDefined();
    });
});

it('validates keywords endpoint with long text', async () => {
    const text = '\n\nistanbul\n\n'.repeat(1000);
    const response = await testServer.executeOperation({
        query: 'query keywords($text: String!) { keywords(text: $text) { result } }',
        variables: { text },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.keywords?.result.length).toBeGreaterThan(0);
    response.data?.keywords.result.forEach((keyword) => {
        expect(keyword).toBeDefined();
    });
});

module.exports = {
    getTestServer,
};