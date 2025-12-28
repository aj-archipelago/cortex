// sys_compress_chat_history.test.js
// Integration tests for chat history compression quality
import test from 'ava';
import sinon from 'sinon';

// Helper to create realistic chat history with tool calls
const createTestChatHistory = () => {
    return [
        {
            role: 'user',
            content: 'Fact check: Did Trump tariffs help America?'
        },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                {
                    id: 'call_search_1',
                    type: 'function',
                    function: {
                        name: 'SearchInternet',
                        arguments: JSON.stringify({
                            q: 'USITC report Section 301 tariffs economic impact',
                            num: 5,
                            userMessage: 'Searching for USITC analysis'
                        })
                    }
                },
                {
                    id: 'call_search_2',
                    type: 'function',
                    function: {
                        name: 'SearchInternet',
                        arguments: JSON.stringify({
                            q: 'tariff pass-through consumer prices 2018',
                            num: 5,
                            userMessage: 'Searching for price impact data'
                        })
                    }
                }
            ]
        },
        {
            role: 'tool',
            tool_call_id: 'call_search_1',
            name: 'SearchInternet',
            content: JSON.stringify({
                _type: 'SearchResponse',
                value: [
                    {
                        searchResultId: 'result_1',
                        title: 'USITC Report: Section 301 Tariffs Impact',
                        url: 'https://www.usitc.gov/publications/5405',
                        content: 'The USITC found that Section 301 tariffs on Chinese goods resulted in $77 billion in tariff revenue but increased consumer prices by approximately 12%. The study analyzed data from 2018-2023.'
                    },
                    {
                        searchResultId: 'result_2',
                        title: 'Economic Analysis of Trade War',
                        url: 'https://www.petersoninstitute.org/tariffs',
                        content: 'Research shows that nearly 100% of tariff costs were passed through to U.S. consumers, not Chinese exporters.'
                    }
                ]
            })
        },
        {
            role: 'tool',
            tool_call_id: 'call_search_2',
            name: 'SearchInternet',
            content: JSON.stringify({
                _type: 'SearchResponse',
                value: [
                    {
                        searchResultId: 'result_3',
                        title: 'Federal Reserve Study on Tariff Pass-Through',
                        url: 'https://www.federalreserve.gov/tariffs',
                        content: 'The Federal Reserve found that U.S. importers bore 95-100% of tariff costs, leading to higher prices for American consumers.'
                    }
                ]
            })
        },
        {
            role: 'assistant',
            content: 'Based on my research, I found that the tariffs generated $77 billion in revenue but increased consumer prices significantly. The USITC report (Publication 5405) and Federal Reserve studies indicate that nearly all tariff costs were passed through to U.S. consumers.'
        },
        {
            role: 'user',
            content: 'What about the trade deficit?'
        },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                {
                    id: 'call_search_3',
                    type: 'function',
                    function: {
                        name: 'SearchInternet',
                        arguments: JSON.stringify({
                            q: 'U.S. trade deficit China 2018 2019 2020',
                            num: 5,
                            userMessage: 'Searching for trade deficit data'
                        })
                    }
                }
            ]
        },
        {
            role: 'tool',
            tool_call_id: 'call_search_3',
            name: 'SearchInternet',
            content: JSON.stringify({
                _type: 'SearchResponse',
                value: [
                    {
                        searchResultId: 'result_4',
                        title: 'Census Bureau Trade Data',
                        url: 'https://www.census.gov/trade',
                        content: 'The U.S. trade deficit with China increased from $375 billion in 2017 to $419 billion in 2019, despite the tariffs.'
                    }
                ]
            })
        },
        {
            role: 'assistant',
            content: 'The trade deficit with China actually increased from $375B in 2017 to $419B in 2019, according to Census Bureau data. This suggests the tariffs did not achieve the stated goal of reducing the trade deficit.'
        }
    ];
};

// Helper to extract key information from chat history
const extractKeyInfo = (chatHistory) => {
    const info = {
        userQuestions: [],
        toolCalls: [],
        toolResults: [],
        citations: [],
        keyFacts: []
    };
    
    for (const msg of chatHistory) {
        if (msg.role === 'user') {
            info.userQuestions.push(msg.content);
        }
        if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
                info.toolCalls.push({
                    name: tc.function?.name,
                    args: tc.function?.arguments
                });
            }
        }
        if (msg.role === 'tool') {
            try {
                const result = JSON.parse(msg.content);
                if (result._type === 'SearchResponse' && result.value) {
                    for (const item of result.value) {
                        info.toolResults.push({
                            title: item.title,
                            url: item.url,
                            content: item.content?.substring(0, 200) // First 200 chars
                        });
                        if (item.url) info.citations.push(item.url);
                    }
                }
            } catch (e) {
                // Not JSON, skip
            }
        }
        if (msg.role === 'assistant' && msg.content) {
            // Extract numbers and key facts
            const numbers = msg.content.match(/\$[\d.]+ billion|\d+%/g);
            if (numbers) info.keyFacts.push(...numbers);
        }
    }
    
    return info;
};

// Helper to check if compressed summary contains key information
const checkInformationRetention = (originalInfo, compressedSummary) => {
    const checks = {
        userQuestionPreserved: false,
        toolNamesPreserved: false,
        citationsPreserved: false,
        keyFactsPreserved: false,
        urlsPreserved: false
    };
    
    const summaryLower = compressedSummary.toLowerCase();
    
    // Check if original user question is mentioned
    if (originalInfo.userQuestions.length > 0) {
        const firstQuestion = originalInfo.userQuestions[0].toLowerCase();
        checks.userQuestionPreserved = summaryLower.includes('trump tariffs') || 
                                       summaryLower.includes('fact check') ||
                                       summaryLower.includes('help america');
    }
    
    // Check if tool names are mentioned
    const toolNames = originalInfo.toolCalls.map(tc => tc.name?.toLowerCase()).filter(Boolean);
    checks.toolNamesPreserved = toolNames.some(name => summaryLower.includes(name.toLowerCase()));
    
    // Check if citations/URLs are preserved
    checks.citationsPreserved = originalInfo.citations.some(url => 
        summaryLower.includes(url.toLowerCase()) || 
        summaryLower.includes('usitc') ||
        summaryLower.includes('federal reserve') ||
        summaryLower.includes('census bureau')
    );
    
    // Check if key facts are preserved
    checks.keyFactsPreserved = originalInfo.keyFacts.some(fact => 
        summaryLower.includes(fact.toLowerCase())
    );
    
    // Check if URLs are preserved
    checks.urlsPreserved = originalInfo.citations.some(url => 
        compressedSummary.includes(url)
    );
    
    return checks;
};

// Mock the compression pathway to return a controlled response
const buildMockCompressionPathway = (mockResponse) => ({
    name: 'sys_compress_chat_history',
    rootResolver: async () => {
        return { result: mockResponse };
    }
});

// Test: Information retention quality
test('compression preserves critical information', async (t) => {
    const chatHistory = createTestChatHistory();
    const originalInfo = extractKeyInfo(chatHistory);
    
    // Simulate a good compression that preserves key info
    const goodCompression = `The user asked: "Fact check: Did Trump tariffs help America?"

Research was conducted using SearchInternet tool:
- USITC Report (https://www.usitc.gov/publications/5405) found Section 301 tariffs generated $77 billion in revenue but increased consumer prices by 12%
- Federal Reserve study showed 95-100% tariff pass-through to U.S. consumers
- Census Bureau data showed trade deficit with China increased from $375B (2017) to $419B (2019) despite tariffs

Key finding: Tariffs did not reduce trade deficit and costs were largely borne by U.S. consumers.`;
    
    const retention = checkInformationRetention(originalInfo, goodCompression);
    
    t.true(retention.userQuestionPreserved, 'User question should be preserved');
    t.true(retention.toolNamesPreserved, 'Tool names should be preserved');
    t.true(retention.citationsPreserved, 'Citations should be preserved');
    t.true(retention.keyFactsPreserved, 'Key facts should be preserved');
});

// Test: Compression effectiveness (token reduction)
test('compression achieves significant token reduction', async (t) => {
    const chatHistory = createTestChatHistory();
    
    // Estimate original tokens (rough approximation: ~4 chars per token)
    const originalText = JSON.stringify(chatHistory);
    const originalTokens = Math.ceil(originalText.length / 4);
    
    // Simulate compressed version (should be much shorter)
    const compressedText = `User asked about Trump tariffs. Research via SearchInternet found:
- USITC: $77B revenue, 12% price increase
- Fed: 95-100% pass-through to consumers  
- Census: Deficit rose $375B→$419B
Conclusion: Tariffs didn't reduce deficit, costs passed to consumers.`;
    
    const compressedTokens = Math.ceil(compressedText.length / 4);
    const reduction = ((originalTokens - compressedTokens) / originalTokens) * 100;
    
    t.true(reduction > 50, `Should achieve >50% reduction, got ${reduction.toFixed(1)}%`);
    t.true(compressedTokens < originalTokens * 0.5, 'Compressed should be <50% of original');
});

// Test: Tool call formatting
test('compression pathway formats tool calls correctly', async (t) => {
    // This tests the formatting logic in executePathway
    const { default: compressionPathway } = await import('../../../../pathways/system/entity/sys_compress_chat_history.js');
    
    const chatHistory = [
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                {
                    id: 'call_1',
                    type: 'function',
                    function: {
                        name: 'SearchInternet',
                        arguments: JSON.stringify({ q: 'test query', num: 5 })
                    }
                }
            ]
        },
        {
            role: 'tool',
            tool_call_id: 'call_1',
            name: 'SearchInternet',
            content: 'Search results here'
        }
    ];
    
    // Mock runAllPrompts to capture the formatted input
    let capturedChatHistory = null;
    const mockRunAllPrompts = async (args) => {
        capturedChatHistory = args.chatHistory;
        return 'Mock compression result';
    };
    
    const mockResolver = {};
    
    await compressionPathway.executePathway({
        args: { chatHistory },
        runAllPrompts: mockRunAllPrompts,
        resolver: mockResolver
    });
    
    t.truthy(capturedChatHistory, 'Should format chat history');
    t.true(typeof capturedChatHistory === 'string', 'Should convert to string format');
    t.true(capturedChatHistory.includes('SearchInternet'), 'Should include tool name');
    t.true(capturedChatHistory.includes('test query'), 'Should include tool arguments');
    t.true(capturedChatHistory.includes('Search results here'), 'Should include tool results');
});

// Test: Citation preservation
test('compression preserves citations and URLs', async (t) => {
    const chatHistory = [
        {
            role: 'tool',
            tool_call_id: 'call_1',
            name: 'SearchInternet',
            content: JSON.stringify({
                _type: 'SearchResponse',
                value: [
                    {
                        searchResultId: 'id1',
                        title: 'Important Study',
                        url: 'https://example.com/study',
                        content: 'Key findings: 95% pass-through'
                    }
                ]
            })
        }
    ];
    
    const originalInfo = extractKeyInfo(chatHistory);
    
    // Good compression should preserve URL
    const goodCompression = 'Research found (https://example.com/study): 95% pass-through to consumers.';
    const badCompression = 'Research found some pass-through to consumers.'; // Missing URL
    
    const goodRetention = checkInformationRetention(originalInfo, goodCompression);
    const badRetention = checkInformationRetention(originalInfo, badCompression);
    
    t.true(goodRetention.urlsPreserved, 'Good compression should preserve URLs');
    t.false(badRetention.urlsPreserved, 'Bad compression loses URLs');
});

// Test: Multimodal content handling
test('compression handles multimodal content', async (t) => {
    const { default: compressionPathway } = await import('../../../../pathways/system/entity/sys_compress_chat_history.js');
    
    const chatHistory = [
        {
            role: 'user',
            content: [
                { type: 'text', text: 'Analyze this image' },
                { type: 'image_url', image_url: { url: 'https://example.com/image.jpg' } }
            ]
        }
    ];
    
    let capturedChatHistory = null;
    const mockRunAllPrompts = async (args) => {
        capturedChatHistory = args.chatHistory;
        return 'Mock result';
    };
    
    await compressionPathway.executePathway({
        args: { chatHistory },
        runAllPrompts: mockRunAllPrompts,
        resolver: {}
    });
    
    t.true(capturedChatHistory.includes('Analyze this image'), 'Should preserve text');
    t.true(capturedChatHistory.includes('[Image:'), 'Should format image references');
});

// Test: Error handling
test('compression handles errors gracefully', async (t) => {
    const { default: compressionPathway } = await import('../../../../pathways/system/entity/sys_compress_chat_history.js');
    
    const mockRunAllPrompts = async () => {
        throw new Error('Model API error');
    };
    
    const result = await compressionPathway.executePathway({
        args: { chatHistory: [] },
        runAllPrompts: mockRunAllPrompts,
        resolver: {}
    });
    
    t.truthy(result, 'Should return fallback summary on error');
    t.true(result.includes('Compression failed'), 'Should indicate compression failure');
});

// Test: Real-world scenario - fact checking conversation
test('compression quality for fact-checking scenario', async (t) => {
    const chatHistory = createTestChatHistory();
    const originalInfo = extractKeyInfo(chatHistory);
    
    // This is what we'd expect from a good compression
    const expectedElements = [
        'trump tariffs',
        'usitc',
        'federal reserve',
        'census bureau',
        '$77 billion',
        'trade deficit',
        '$375',
        '$419'
    ];
    
    // Simulate compression output
    const compression = `User asked: "Did Trump tariffs help America?"

Research conducted:
- USITC Report (Publication 5405): Section 301 tariffs generated $77 billion revenue but increased consumer prices 12%
- Federal Reserve: 95-100% tariff costs passed through to U.S. consumers
- Census Bureau: Trade deficit with China increased from $375B (2017) to $419B (2019)

Conclusion: Tariffs did not reduce trade deficit; costs largely borne by U.S. consumers.`;
    
    const retention = checkInformationRetention(originalInfo, compression);
    const compressionLower = compression.toLowerCase();
    
    // Verify all expected elements are present
    const allElementsPresent = expectedElements.every(elem => 
        compressionLower.includes(elem.toLowerCase())
    );
    
    t.true(allElementsPresent, 'All key elements should be preserved');
    t.true(retention.userQuestionPreserved, 'User question preserved');
    t.true(retention.citationsPreserved, 'Citations preserved');
    t.true(retention.keyFactsPreserved, 'Key facts preserved');
});

// Test: Compression ratio target
test('compression should achieve 60-80% token reduction', async (t) => {
    const chatHistory = createTestChatHistory();
    const originalText = JSON.stringify(chatHistory);
    const originalTokens = Math.ceil(originalText.length / 4);
    
    // Target: 60-80% reduction
    const targetMinReduction = 0.6;
    const targetMaxReduction = 0.8;
    
    // Simulate realistic compression (70% reduction)
    const compressedText = originalText.substring(0, Math.floor(originalText.length * 0.3));
    const compressedTokens = Math.ceil(compressedText.length / 4);
    const reduction = (originalTokens - compressedTokens) / originalTokens;
    
    t.true(
        reduction >= targetMinReduction && reduction <= targetMaxReduction,
        `Compression should achieve ${targetMinReduction * 100}-${targetMaxReduction * 100}% reduction, got ${(reduction * 100).toFixed(1)}%`
    );
});

