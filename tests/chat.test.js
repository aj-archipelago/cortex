const { getTestServer } = require("./main.test");

const testServer = getTestServer();

it('validates chat endpoint', async () => {
    const response = await testServer.executeOperation({
        query: 'query($contextId: String) { chat_context(contextId: $contextId) { result contextId } }',
        variables: { contextId: 'testId' },
    });

    expect(response.errors).toBeUndefined();
    expect(response.data?.chat_context?.result).toBeDefined();
}); 