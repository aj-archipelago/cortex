const { ApolloServer } = require('apollo-server');
const { typeDefs, resolvers } = require('./index')();

jest.setTimeout(60000);

const testServer = new ApolloServer({
    typeDefs,
    resolvers,
});

afterAll(() => {
    // stop server after all tests
    testServer.stop();
});

it('validates bias endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query bias($text: String!) { bias(text: $text) }',
        variables: { text: 'hello there my dear world!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.bias).toMatch(/(yes|no|bias)/i)
});

it('validates completion endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query complete($text: String!) { complete(text: $text) }',
        variables: { text: 'hello there my dear world!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.complete.length).toBeGreaterThan(0);
});

it('validates entities endpoint with given num of count return', async () => {
    const response = await testServer.executeOperation({
        query: 'query entities($text: String!, $count: Int) { entities(text: $text, count: $count){ name, definition} }',
        variables: { text: 'hello there my dear world!', count: 3 },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.entities.length).toBe(3);
    response.data?.entities.forEach((entity) => {
        expect(entity.name).toBeDefined();
        expect(entity.definition).toBeDefined();
    });
});

it('validates grammar endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query grammar($text: String!) { grammar(text: $text) }',
        variables: { text: 'helo there my dear worldd!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.grammar).toMatch(/hello.*world/i);
});

it('validates headline endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query headline($text: String!) { headline(text: $text) }',
        variables: { text: 'hello there my dear world!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.headline.length).toBeGreaterThan(0);
    response.data?.headline.forEach((headline) => {
        expect(headline).toBeDefined();
    });
});

it('validates keywords endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query keywords($text: String!) { keywords(text: $text) }',
        variables: { text: 'hello there my dear world!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.keywords.length).toBeGreaterThan(0);
    response.data?.keywords.forEach((keyword) => {
        expect(keyword).toBeDefined();
    });
});

it('validates paraphrase endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query paraphrase($text: String!) { paraphrase(text: $text) }',
        variables: { text: 'hello there my dear world!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.paraphrase).toBeDefined();
});

it('validates pass endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query pass($text: String!) { pass(text: $text) }',
        variables: { text: 'hello there my dear world!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.pass).toBeDefined();
});

it('validates sentiment endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query sentiment($text: String!) { sentiment(text: $text) }',
        variables: { text: 'hello there my dear world!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.sentiment).toBeDefined();
});

it('validates spelling endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query spelling($text: String!) { spelling(text: $text) }',
        variables: { text: 'helo there my dear worldd!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.spelling).toMatch(/hello.*world/i);
});

it('validates styleguide endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query styleguide($text: String!) { styleguide(text: $text) }',
        variables: { text: 'helo there my dear worldd!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.styleguide).toMatch(/hello.*world/i);
});

it('validates styleguidemulti endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query styleguidemulti($text: String!) { styleguidemulti(text: $text) }',
        variables: { text: 'helo there my dear worldd!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.styleguidemulti).toMatch(/hello.*world/i);
});

it('validates summary endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query summary($text: String!) { summary(text: $text) }',
        variables: { text: 'hello there my dear world!' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.summary).toBeDefined();
});

it('validates topics endpoint with given num of count return', async () => {
    const response = await testServer.executeOperation({
        query: 'query topics($text: String!, $count: Int) { topics(text: $text, count: $count) }',
        variables: { text: 'hello there my dear world!', count: 3 },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.topics.length).toBe(3);
    response.data?.topics.forEach((topic) => {
        expect(topic).toBeDefined();
    });
});