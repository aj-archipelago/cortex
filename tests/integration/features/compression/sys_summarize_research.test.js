import test from 'ava';

/**
 * Integration tests for sys_summarize_research pathway
 * Tests that research tool calls and results are properly synthesized into summaries
 */

test('sys_summarize_research: formats tool calls and results correctly', async t => {
    const { default: summarizePathway } = await import('../../../../pathways/system/entity/sys_summarize_research.js');
    
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
                        arguments: JSON.stringify({
                            q: 'tariff economic impact studies',
                            userMessage: 'Searching for economic impact studies on tariffs'
                        })
                    }
                }
            ]
        },
        {
            role: 'tool',
            tool_call_id: 'call_1',
            name: 'SearchInternet',
            content: JSON.stringify({
                _type: 'SearchResponse',
                value: [
                    {
                        searchResultId: 'result_1',
                        title: 'Economic Impact of Tariffs',
                        url: 'https://example.com/tariff-study-2024',
                        content: 'A comprehensive study found that tariffs increased consumer prices by 0.3% and reduced manufacturing employment by 1.4%.'
                    }
                ]
            })
        }
    ];
    
    // Mock runAllPrompts to capture the formatted input
    let capturedChatHistory = null;
    const mockRunAllPrompts = async (args) => {
        capturedChatHistory = args.chatHistory;
        return 'Mock research summary result';
    };
    
    await summarizePathway.executePathway({
        args: { chatHistory },
        runAllPrompts: mockRunAllPrompts,
        resolver: {}
    });
    
    t.truthy(capturedChatHistory, 'Should format research data');
    t.true(typeof capturedChatHistory === 'string', 'Should convert to string format');
    t.true(capturedChatHistory.includes('SearchInternet'), 'Should include tool name');
    t.true(capturedChatHistory.includes('tariff economic impact'), 'Should include search query');
    t.true(capturedChatHistory.includes('https://example.com/tariff-study-2024'), 'Should include URL');
    t.true(capturedChatHistory.includes('0.3%') || capturedChatHistory.includes('1.4%'), 'Should include key data');
});

test('sys_summarize_research: extracts and preserves URLs and citations', async t => {
    const { default: summarizePathway } = await import('../../../../pathways/system/entity/sys_summarize_research.js');
    
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
                        arguments: JSON.stringify({
                            q: 'USITC tariff report 2024',
                            userMessage: 'Finding USITC tariff report data'
                        })
                    }
                }
            ]
        },
        {
            role: 'tool',
            tool_call_id: 'call_1',
            name: 'SearchInternet',
            content: JSON.stringify({
                _type: 'SearchResponse',
                value: [
                    {
                        searchResultId: 'usitc_1',
                        title: 'USITC Report 5405',
                        url: 'https://www.usitc.gov/publications/332/pub5405.pdf',
                        content: 'USITC found $2.8 billion annual production increase in upstream industries and $3.4 billion decrease in downstream industries.'
                    }
                ]
            })
        }
    ];
    
    let capturedChatHistory = null;
    const mockRunAllPrompts = async (args) => {
        capturedChatHistory = args.chatHistory;
        return 'Mock summary';
    };
    
    await summarizePathway.executePathway({
        args: { chatHistory },
        runAllPrompts: mockRunAllPrompts,
        resolver: {}
    });
    
    t.truthy(capturedChatHistory, 'Should format research data');
    
    // Verify URL extraction and preservation instruction
    t.true(
        capturedChatHistory.includes('https://www.usitc.gov/publications/332/pub5405.pdf') ||
        capturedChatHistory.includes('usitc.gov'),
        'Should extract and preserve URLs'
    );
    
    // Verify citation extraction
    t.true(
        capturedChatHistory.includes('usitc_1') ||
        capturedChatHistory.includes('USITC Report 5405') ||
        capturedChatHistory.includes('5405'),
        'Should extract citations'
    );
});

test('sys_summarize_research: includes research goal from userMessage', async t => {
    const { default: summarizePathway } = await import('../../../../pathways/system/entity/sys_summarize_research.js');
    
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
                        arguments: JSON.stringify({
                            q: 'tariff employment effects',
                            userMessage: 'Searching for employment impact data'
                        })
                    }
                }
            ]
        },
        {
            role: 'tool',
            tool_call_id: 'call_1',
            name: 'SearchInternet',
            content: JSON.stringify({
                _type: 'SearchResponse',
                value: [
                    {
                        searchResultId: 'emp_1',
                        title: 'Employment Effects',
                        url: 'https://example.com/employment',
                        content: 'Tariffs reduced manufacturing employment by 245,000 jobs.'
                    }
                ]
            })
        }
    ];
    
    let capturedChatHistory = null;
    const mockRunAllPrompts = async (args) => {
        capturedChatHistory = args.chatHistory;
        return 'Mock summary';
    };
    
    await summarizePathway.executePathway({
        args: { chatHistory },
        runAllPrompts: mockRunAllPrompts,
        resolver: {}
    });
    
    t.truthy(capturedChatHistory, 'Should format research data');
    
    // Verify research goal is included
    t.true(
        capturedChatHistory.includes('Searching for employment impact data') ||
        capturedChatHistory.includes('Research goal:'),
        'Should include research goal from userMessage'
    );
});

test('sys_summarize_research: handles multiple parallel tool calls', async t => {
    const { default: summarizePathway } = await import('../../../../pathways/system/entity/sys_summarize_research.js');
    
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
                        arguments: JSON.stringify({
                            q: 'test query 1',
                            userMessage: 'First search'
                        })
                    }
                },
                {
                    id: 'call_2',
                    type: 'function',
                    function: {
                        name: 'SearchInternet',
                        arguments: JSON.stringify({
                            q: 'test query 2',
                            userMessage: 'Second search'
                        })
                    }
                }
            ]
        },
        {
            role: 'tool',
            tool_call_id: 'call_1',
            name: 'SearchInternet',
            content: JSON.stringify({
                _type: 'SearchResponse',
                value: [
                    {
                        searchResultId: 'r1',
                        title: 'Result 1',
                        url: 'https://example.com/1',
                        content: 'First result content'
                    }
                ]
            })
        },
        {
            role: 'tool',
            tool_call_id: 'call_2',
            name: 'SearchInternet',
            content: JSON.stringify({
                _type: 'SearchResponse',
                value: [
                    {
                        searchResultId: 'r2',
                        title: 'Result 2',
                        url: 'https://example.com/2',
                        content: 'Second result content'
                    }
                ]
            })
        }
    ];
    
    let capturedChatHistory = null;
    const mockRunAllPrompts = async (args) => {
        capturedChatHistory = args.chatHistory;
        return 'Mock summary';
    };
    
    await summarizePathway.executePathway({
        args: { chatHistory },
        runAllPrompts: mockRunAllPrompts,
        resolver: {}
    });
    
    t.truthy(capturedChatHistory, 'Should format research data');
    
    // Verify both tool calls are included
    t.true(capturedChatHistory.includes('call_1') || capturedChatHistory.includes('First search'), 'Should include first tool call');
    t.true(capturedChatHistory.includes('call_2') || capturedChatHistory.includes('Second search'), 'Should include second tool call');
    
    // Verify both results are included
    t.true(capturedChatHistory.includes('https://example.com/1') || capturedChatHistory.includes('Result 1'), 'Should include first result');
    t.true(capturedChatHistory.includes('https://example.com/2') || capturedChatHistory.includes('Result 2'), 'Should include second result');
});

test('sys_summarize_research: handles empty research data gracefully', async t => {
    const { default: summarizePathway } = await import('../../../../pathways/system/entity/sys_summarize_research.js');
    
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
                        arguments: JSON.stringify({
                            q: 'test',
                            userMessage: 'Test search'
                        })
                    }
                }
            ]
        },
        {
            role: 'tool',
            tool_call_id: 'call_1',
            name: 'SearchInternet',
            content: JSON.stringify({
                _type: 'SearchResponse',
                value: []
            })
        }
    ];
    
    let capturedChatHistory = null;
    const mockRunAllPrompts = async (args) => {
        capturedChatHistory = args.chatHistory;
        return 'Mock summary for empty results';
    };
    
    const result = await summarizePathway.executePathway({
        args: { chatHistory },
        runAllPrompts: mockRunAllPrompts,
        resolver: {}
    });
    
    t.truthy(result, 'Should return a summary even with empty results');
    t.true(typeof result === 'string', 'Summary should be a string');
    t.truthy(capturedChatHistory, 'Should still format the research data');
});

test('sys_summarize_research: extracts source information for preservation', async t => {
    const { default: summarizePathway } = await import('../../../../pathways/system/entity/sys_summarize_research.js');
    
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
                        arguments: JSON.stringify({
                            q: 'Federal Reserve tariff study',
                            userMessage: 'Finding Fed study'
                        })
                    }
                }
            ]
        },
        {
            role: 'tool',
            tool_call_id: 'call_1',
            name: 'SearchInternet',
            content: JSON.stringify({
                _type: 'SearchResponse',
                value: [
                    {
                        searchResultId: 'fed_1',
                        title: 'Federal Reserve Board Study, 2024',
                        url: 'https://www.federalreserve.gov/econres/feds/files/2024086pap.pdf',
                        content: 'Flaaen and Pierce (2024) found that tariffs reduced manufacturing employment by 1.4%.'
                    }
                ]
            })
        }
    ];
    
    let capturedChatHistory = null;
    const mockRunAllPrompts = async (args) => {
        capturedChatHistory = args.chatHistory;
        return 'Mock summary';
    };
    
    await summarizePathway.executePathway({
        args: { chatHistory },
        runAllPrompts: mockRunAllPrompts,
        resolver: {}
    });
    
    t.truthy(capturedChatHistory, 'Should format research data');
    
    // Verify source information is extracted and included in preservation instructions
    t.true(
        capturedChatHistory.includes('federalreserve.gov') ||
        capturedChatHistory.includes('Federal Reserve Board Study') ||
        capturedChatHistory.includes('fed_1'),
        'Should extract and preserve source information'
    );
});

test('sys_summarize_research: includes multiple tool calls and results', async t => {
    const { default: summarizePathway } = await import('../../../../pathways/system/entity/sys_summarize_research.js');
    
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
                        arguments: JSON.stringify({
                            q: 'tariff revenue collection',
                            userMessage: 'Finding tariff revenue data'
                        })
                    }
                }
            ]
        },
        {
            role: 'tool',
            tool_call_id: 'call_1',
            name: 'SearchInternet',
            content: JSON.stringify({
                _type: 'SearchResponse',
                value: [
                    {
                        searchResultId: 'rev_1',
                        title: 'Tariff Revenue',
                        url: 'https://example.com/revenue',
                        content: 'Tax Foundation: $233 billion collected through March 2024.'
                    }
                ]
            })
        },
        {
            role: 'assistant',
            content: '',
            tool_calls: [
                {
                    id: 'call_2',
                    type: 'function',
                    function: {
                        name: 'SearchInternet',
                        arguments: JSON.stringify({
                            q: 'tariff revenue who pays',
                            userMessage: 'Finding who pays tariffs'
                        })
                    }
                }
            ]
        },
        {
            role: 'tool',
            tool_call_id: 'call_2',
            name: 'SearchInternet',
            content: JSON.stringify({
                _type: 'SearchResponse',
                value: [
                    {
                        searchResultId: 'rev_2',
                        title: 'Who Pays Tariffs',
                        url: 'https://example.com/who-pays',
                        content: 'Tax Foundation analysis shows tariffs are paid by U.S. importers and consumers.'
                    }
                ]
            })
        }
    ];
    
    let capturedChatHistory = null;
    const mockRunAllPrompts = async (args) => {
        capturedChatHistory = args.chatHistory;
        return 'Mock summary';
    };
    
    await summarizePathway.executePathway({
        args: { chatHistory },
        runAllPrompts: mockRunAllPrompts,
        resolver: {}
    });
    
    t.truthy(capturedChatHistory, 'Should format research data');
    
    // Verify both tool calls are included
    t.true(capturedChatHistory.includes('call_1') || capturedChatHistory.includes('Finding tariff revenue'), 'Should include first tool call');
    t.true(capturedChatHistory.includes('call_2') || capturedChatHistory.includes('Finding who pays'), 'Should include second tool call');
    
    // Verify both URLs are extracted for preservation
    t.true(
        capturedChatHistory.includes('https://example.com/revenue') ||
        capturedChatHistory.includes('https://example.com/who-pays'),
        'Should extract URLs for preservation'
    );
});

test('sys_summarize_research: handles errors gracefully', async t => {
    const { default: summarizePathway } = await import('../../../../pathways/system/entity/sys_summarize_research.js');
    
    const mockRunAllPrompts = async () => {
        throw new Error('Model API error');
    };
    
    const result = await summarizePathway.executePathway({
        args: { chatHistory: [] },
        runAllPrompts: mockRunAllPrompts,
        resolver: {}
    });
    
    t.truthy(result, 'Should return fallback summary on error');
    t.true(result.includes('Research summarization failed') || result.includes('failed'), 'Should indicate summarization failure');
});

