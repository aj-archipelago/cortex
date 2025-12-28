// chatHistoryCompression.test.js
// Tests for chat history compression logic in sys_entity_agent.js
import test from 'ava';

/**
 * This test file validates the compression split logic that ensures
 * tool call/result pairs are never broken when compressing chat history.
 * 
 * The logic being tested (extracted from sys_entity_agent.js):
 * 1. Build a map: tool_call_id -> index of message containing that tool_call
 * 2. Start with default split (last 10 messages)
 * 3. Iteratively move split back if any tool result in toKeep references a tool_call in toCompress
 */

// Helper to generate test messages
const generateMessage = (role, content) => ({ role, content });
const generateToolCallMessage = (toolCalls) => ({
    role: 'assistant',
    content: '',
    tool_calls: toolCalls
});
const generateToolResultMessage = (toolCallId, name, result) => ({
    role: 'tool',
    tool_call_id: toolCallId,
    name,
    content: result
});

/**
 * Extracted compression split logic for testing
 * This mirrors the logic in sys_entity_agent.js toolCallback
 */
function findSafeSplitPoint(nonSystemMessages) {
    // Build map: tool_call_id -> index of message containing that tool_call
    const toolCallIndexMap = new Map();
    for (let i = 0; i < nonSystemMessages.length; i++) {
        const m = nonSystemMessages[i];
        if (m.tool_calls) {
            m.tool_calls.forEach(tc => tc.id && toolCallIndexMap.set(tc.id, i));
        }
    }
    
    // Find safe split point: start with last 10 msgs, then move back if needed
    // to ensure no tool result in toKeep references a tool_call in toCompress
    let splitIndex = Math.max(0, nonSystemMessages.length - 10);
    
    // Keep moving split back until all tool results in toKeep have their calls in toKeep too
    let adjusted = true;
    while (adjusted && splitIndex > 0) {
        adjusted = false;
        for (let i = splitIndex; i < nonSystemMessages.length; i++) {
            const m = nonSystemMessages[i];
            if (m.role === 'tool' && m.tool_call_id) {
                const callIndex = toolCallIndexMap.get(m.tool_call_id);
                if (callIndex !== undefined && callIndex < splitIndex) {
                    splitIndex = callIndex;
                    adjusted = true;
                    break;
                }
            }
        }
    }
    
    return {
        splitIndex,
        toCompress: nonSystemMessages.slice(0, splitIndex),
        toKeep: nonSystemMessages.slice(splitIndex)
    };
}

/**
 * Validates that all tool results in toKeep have their corresponding tool_calls also in toKeep
 */
function validateToolCallPairs(toKeep) {
    const toolCallIds = new Set();
    const toolResultIds = new Set();
    
    for (const m of toKeep) {
        if (m.tool_calls) {
            m.tool_calls.forEach(tc => tc.id && toolCallIds.add(tc.id));
        }
        if (m.role === 'tool' && m.tool_call_id) {
            toolResultIds.add(m.tool_call_id);
        }
    }
    
    // Every tool result should have its tool call in the same section
    for (const resultId of toolResultIds) {
        if (!toolCallIds.has(resultId)) {
            return { valid: false, orphanedResultId: resultId };
        }
    }
    
    return { valid: true };
}

// ============== TESTS ==============

test('findSafeSplitPoint: should keep tool call/result pairs together when result is in toKeep', (t) => {
    // Simulate a scenario from run.log: multiple search tool calls followed by results
    const messages = [
        generateMessage('user', 'Fact check this claim'),
        generateToolCallMessage([{ id: 'call_1', type: 'function', function: { name: 'SearchInternet', arguments: '{}' }}]),
        generateToolResultMessage('call_1', 'SearchInternet', 'Search result 1'),
        generateToolCallMessage([{ id: 'call_2', type: 'function', function: { name: 'SearchInternet', arguments: '{}' }}]),
        generateToolResultMessage('call_2', 'SearchInternet', 'Search result 2'),
        generateToolCallMessage([{ id: 'call_3', type: 'function', function: { name: 'SearchInternet', arguments: '{}' }}]),
        generateToolResultMessage('call_3', 'SearchInternet', 'Search result 3'),
        generateToolCallMessage([{ id: 'call_4', type: 'function', function: { name: 'SearchInternet', arguments: '{}' }}]),
        generateToolResultMessage('call_4', 'SearchInternet', 'Search result 4'),
        generateToolCallMessage([{ id: 'call_5', type: 'function', function: { name: 'SearchInternet', arguments: '{}' }}]),
        generateToolResultMessage('call_5', 'SearchInternet', 'Search result 5'),
        generateMessage('assistant', 'Here is my analysis based on the searches'),
    ];
    
    const { toCompress, toKeep } = findSafeSplitPoint(messages);
    
    // Validate that all pairs are intact in toKeep
    const validation = validateToolCallPairs(toKeep);
    t.true(validation.valid, `All tool call/result pairs should be intact. Orphaned: ${validation.orphanedResultId}`);
});

test('findSafeSplitPoint: should handle long chat history with many tool calls', (t) => {
    // Simulate a long conversation with 20+ tool calls (like the run.log scenario)
    const messages = [
        generateMessage('user', 'Conduct a thorough fact check'),
    ];
    
    // Add 20 tool call/result pairs
    for (let i = 1; i <= 20; i++) {
        messages.push(generateToolCallMessage([{ 
            id: `call_${i}`, 
            type: 'function', 
            function: { name: 'SearchInternet', arguments: `{"q":"query ${i}"}` }
        }]));
        messages.push(generateToolResultMessage(`call_${i}`, 'SearchInternet', `Result for query ${i}`));
    }
    
    messages.push(generateMessage('assistant', 'Final analysis'));
    
    const { splitIndex, toCompress, toKeep } = findSafeSplitPoint(messages);
    
    // Validate pairs
    const validation = validateToolCallPairs(toKeep);
    t.true(validation.valid, `All tool call/result pairs should be intact. Orphaned: ${validation.orphanedResultId}`);
    
    // Should have compressed some messages
    t.true(toCompress.length > 0, 'Should have messages to compress');
    t.true(toKeep.length >= 10, 'Should keep at least 10 messages');
});

test('findSafeSplitPoint: should handle tool result referencing earlier tool call', (t) => {
    // This is the exact bug scenario: tool result at index 12 references tool call at index 2
    const messages = [
        generateMessage('user', 'Question'),                                          // 0
        generateToolCallMessage([{ id: 'call_early', type: 'function', function: { name: 'Tool1', arguments: '{}' }}]),  // 1
        generateMessage('assistant', 'Some response'),                                // 2
        generateMessage('user', 'Follow up'),                                         // 3
        generateToolCallMessage([{ id: 'call_mid', type: 'function', function: { name: 'Tool2', arguments: '{}' }}]),    // 4
        generateToolResultMessage('call_mid', 'Tool2', 'Mid result'),                 // 5
        generateMessage('assistant', 'Analysis'),                                     // 6
        generateMessage('user', 'Another question'),                                  // 7
        generateMessage('assistant', 'Response'),                                     // 8
        generateMessage('user', 'More questions'),                                    // 9
        generateMessage('assistant', 'More responses'),                               // 10
        generateMessage('user', 'Final question'),                                    // 11
        generateToolResultMessage('call_early', 'Tool1', 'Delayed result for early call'), // 12 - Result for call at index 1!
    ];
    
    const { splitIndex, toCompress, toKeep } = findSafeSplitPoint(messages);
    
    // The split should be at or before index 1 to keep the pair together
    const validation = validateToolCallPairs(toKeep);
    t.true(validation.valid, `Tool call/result pair should be intact. Orphaned: ${validation.orphanedResultId}`);
    
    // Verify that call_early's tool_call message is in toKeep if its result is
    const hasCallEarlyResult = toKeep.some(m => m.role === 'tool' && m.tool_call_id === 'call_early');
    const hasCallEarlyCall = toKeep.some(m => m.tool_calls?.some(tc => tc.id === 'call_early'));
    
    if (hasCallEarlyResult) {
        t.true(hasCallEarlyCall, 'If call_early result is in toKeep, its tool_call must also be in toKeep');
    }
});

test('findSafeSplitPoint: should handle parallel tool calls in single message', (t) => {
    // Multiple tool calls in a single assistant message
    const messages = [
        generateMessage('user', 'Search for multiple things'),
        generateToolCallMessage([
            { id: 'call_a', type: 'function', function: { name: 'Search', arguments: '{"q":"A"}' }},
            { id: 'call_b', type: 'function', function: { name: 'Search', arguments: '{"q":"B"}' }},
            { id: 'call_c', type: 'function', function: { name: 'Search', arguments: '{"q":"C"}' }},
        ]),
        generateToolResultMessage('call_a', 'Search', 'Result A'),
        generateToolResultMessage('call_b', 'Search', 'Result B'),
        generateToolResultMessage('call_c', 'Search', 'Result C'),
        generateMessage('assistant', 'Analysis of A, B, and C'),
        // Add more messages to trigger compression
        ...Array(15).fill(null).map((_, i) => generateMessage('user', `Follow up ${i}`)),
    ];
    
    const { toKeep } = findSafeSplitPoint(messages);
    
    const validation = validateToolCallPairs(toKeep);
    t.true(validation.valid, `All parallel tool call pairs should be intact. Orphaned: ${validation.orphanedResultId}`);
});

test('findSafeSplitPoint: should not compress when fewer than 10 messages', (t) => {
    const messages = [
        generateMessage('user', 'Question'),
        generateToolCallMessage([{ id: 'call_1', type: 'function', function: { name: 'Tool', arguments: '{}' }}]),
        generateToolResultMessage('call_1', 'Tool', 'Result'),
        generateMessage('assistant', 'Answer'),
    ];
    
    const { splitIndex, toCompress, toKeep } = findSafeSplitPoint(messages);
    
    // With only 4 messages, split should be at 0 (nothing to compress)
    t.is(splitIndex, 0, 'Split should be at 0 for small message count');
    t.is(toCompress.length, 0, 'Nothing should be compressed');
    t.is(toKeep.length, 4, 'All messages should be kept');
});

test('findSafeSplitPoint: should handle messages without tool calls', (t) => {
    const messages = Array(25).fill(null).map((_, i) => 
        generateMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`)
    );
    
    const { splitIndex, toCompress, toKeep } = findSafeSplitPoint(messages);
    
    // Should split at default position (messages.length - 10 = 15)
    t.is(splitIndex, 15, 'Should use default split for messages without tool calls');
    t.is(toCompress.length, 15, 'Should compress first 15 messages');
    t.is(toKeep.length, 10, 'Should keep last 10 messages');
});

test('findSafeSplitPoint: real-world scenario from run.log - 8 parallel searches', (t) => {
    // Based on actual data from run.log: 8 search tool calls in parallel
    const messages = [
        generateMessage('user', 'Fact check: Did Trump tariffs help America?'),
        generateToolCallMessage([
            { id: 'call_N01vMig9', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"USITC report Section 301 tariffs"}' }},
            { id: 'call_bVkZcYOB', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"CBO tariff effects 2018"}' }},
            { id: 'call_NLMNb7YY', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"Fed tariff pass-through"}' }},
            { id: 'call_djTyEFwJ', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"NBER welfare cost tariffs"}' }},
            { id: 'call_Fhl93LW0', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"trade deficit effect tariffs"}' }},
            { id: 'call_bPEsX4aS', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"Section 232 steel tariffs"}' }},
            { id: 'call_gC9uE3tU', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"fact check Trump tariffs"}' }},
            { id: 'call_iBv0Qva', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"AllSides bias ratings"}' }},
        ]),
        generateToolResultMessage('call_N01vMig9', 'SearchInternet', 'USITC findings...'),
        generateToolResultMessage('call_bVkZcYOB', 'SearchInternet', 'CBO analysis...'),
        generateToolResultMessage('call_NLMNb7YY', 'SearchInternet', 'Fed research...'),
        generateToolResultMessage('call_djTyEFwJ', 'SearchInternet', 'NBER paper...'),
        generateToolResultMessage('call_Fhl93LW0', 'SearchInternet', 'Trade deficit data...'),
        generateToolResultMessage('call_bPEsX4aS', 'SearchInternet', 'Steel tariff study...'),
        generateToolResultMessage('call_gC9uE3tU', 'SearchInternet', 'Fact check results...'),
        generateToolResultMessage('call_iBv0Qva', 'SearchInternet', 'Bias ratings...'),
        generateMessage('assistant', 'Based on my research...'),
        // More tool calls for deeper research
        generateToolCallMessage([
            { id: 'call_NIl8lBxz', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"USITC PDF Section 301"}' }},
            { id: 'call_yP7PT7IB', type: 'function', function: { name: 'SearchInternet', arguments: '{"q":"Amiti Redding Weinstein"}' }},
        ]),
        generateToolResultMessage('call_NIl8lBxz', 'SearchInternet', 'USITC PDF...'),
        generateToolResultMessage('call_yP7PT7IB', 'SearchInternet', 'Academic paper...'),
        generateMessage('assistant', 'Continuing analysis...'),
        // Add filler to trigger compression threshold
        ...Array(10).fill(null).map((_, i) => generateMessage('user', `Additional question ${i}`)),
    ];
    
    const { toCompress, toKeep } = findSafeSplitPoint(messages);
    
    // Validate all pairs are intact
    const validation = validateToolCallPairs(toKeep);
    t.true(validation.valid, `All tool call/result pairs should be intact. Orphaned: ${validation.orphanedResultId}`);
    
    // Should have compressed something
    t.true(toCompress.length >= 5, 'Should have enough messages to compress');
});

test('findSafeSplitPoint: chain reaction - multiple dependent adjustments', (t) => {
    // Scenario where adjusting for one tool result reveals another dependency
    const messages = [
        generateMessage('user', 'Complex task'),
        generateToolCallMessage([{ id: 'call_1', type: 'function', function: { name: 'Tool', arguments: '{}' }}]), // 1
        generateToolCallMessage([{ id: 'call_2', type: 'function', function: { name: 'Tool', arguments: '{}' }}]), // 2
        generateToolCallMessage([{ id: 'call_3', type: 'function', function: { name: 'Tool', arguments: '{}' }}]), // 3
        // Many filler messages
        ...Array(20).fill(null).map((_, i) => generateMessage('user', `Filler ${i}`)),
        // Results come much later, out of order
        generateToolResultMessage('call_3', 'Tool', 'Result 3'), // 24
        generateToolResultMessage('call_2', 'Tool', 'Result 2'), // 25
        generateToolResultMessage('call_1', 'Tool', 'Result 1'), // 26
    ];
    
    const { splitIndex, toCompress, toKeep } = findSafeSplitPoint(messages);
    
    // All three tool calls (at indices 1, 2, 3) should be included in toKeep
    // because their results are in toKeep
    const validation = validateToolCallPairs(toKeep);
    t.true(validation.valid, `Chain of tool call pairs should be intact. Orphaned: ${validation.orphanedResultId}`);
    
    // Split should be at or before index 1
    t.true(splitIndex <= 1, `Split should be at or before index 1, got ${splitIndex}`);
});

test('findSafeSplitPoint: mixed complete and incomplete pairs', (t) => {
    // Some tool calls have results, some don't (simulating in-progress calls)
    const messages = [
        generateMessage('user', 'Task'),
        generateToolCallMessage([{ id: 'call_complete_1', type: 'function', function: { name: 'Tool', arguments: '{}' }}]),
        generateToolResultMessage('call_complete_1', 'Tool', 'Done'),
        generateToolCallMessage([{ id: 'call_complete_2', type: 'function', function: { name: 'Tool', arguments: '{}' }}]),
        generateToolResultMessage('call_complete_2', 'Tool', 'Done'),
        // More messages
        ...Array(12).fill(null).map((_, i) => generateMessage('user', `Question ${i}`)),
        // A tool call without result (in-progress)
        generateToolCallMessage([{ id: 'call_pending', type: 'function', function: { name: 'Tool', arguments: '{}' }}]),
    ];
    
    const { toCompress, toKeep } = findSafeSplitPoint(messages);
    
    // Validate complete pairs in toKeep are intact
    const validation = validateToolCallPairs(toKeep);
    t.true(validation.valid, `Complete tool call/result pairs should be intact. Orphaned: ${validation.orphanedResultId}`);
});

// Test for the exact error scenario from run.log
test('findSafeSplitPoint: should prevent "tool must be response to preceding tool_calls" error', (t) => {
    // This test simulates the exact scenario that caused the error:
    // After compression, a tool result message exists without its preceding tool_calls message
    
    const messages = [
        generateMessage('user', 'Fact check request'),
        // First batch of tool calls
        generateToolCallMessage([
            { id: 'call_search_1', type: 'function', function: { name: 'SearchInternet', arguments: '{}' }},
        ]),
        generateToolResultMessage('call_search_1', 'SearchInternet', 'Search results...'),
        // More conversation
        ...Array(15).fill(null).map((_, i) => generateMessage(i % 2 === 0 ? 'user' : 'assistant', `Message ${i}`)),
        // Later tool calls
        generateToolCallMessage([
            { id: 'call_search_2', type: 'function', function: { name: 'SearchInternet', arguments: '{}' }},
        ]),
        generateToolResultMessage('call_search_2', 'SearchInternet', 'More results...'),
        generateMessage('assistant', 'Final response'),
    ];
    
    const { toCompress, toKeep } = findSafeSplitPoint(messages);
    
    // Validate: no orphaned tool results
    const validation = validateToolCallPairs(toKeep);
    t.true(validation.valid, 
        `No tool result should be orphaned after split. ` +
        `This would cause "tool must be response to preceding tool_calls" error. ` +
        `Orphaned: ${validation.orphanedResultId}`
    );
    
    // Additional check: verify message order is preserved
    let lastToolCallIdx = -1;
    for (let i = 0; i < toKeep.length; i++) {
        const m = toKeep[i];
        if (m.tool_calls) {
            lastToolCallIdx = i;
        }
        if (m.role === 'tool') {
            // Find the tool_call this result belongs to
            const callExists = toKeep.slice(0, i).some(prev => 
                prev.tool_calls?.some(tc => tc.id === m.tool_call_id)
            );
            t.true(callExists, 
                `Tool result at index ${i} (tool_call_id: ${m.tool_call_id}) ` +
                `must have a preceding tool_calls message in toKeep`
            );
        }
    }
});

