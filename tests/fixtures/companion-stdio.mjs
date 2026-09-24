import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
input.on('line', line => {
    const message = JSON.parse(line);
    if (message.id === undefined) return;
    const result = message.method === 'initialize'
        ? { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'stdio-test', version: '1' } }
        : message.method === 'tools/list'
            ? { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }
            : { content: [{ type: 'text', text: 'stdio pong' }] };
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n');
});
