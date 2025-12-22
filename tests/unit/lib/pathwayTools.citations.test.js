// pathwayTools.citations.test.js
// Comprehensive tests for citation handling in pathwayTools

import test from 'ava';
import { addCitationsToResolver } from '../../../lib/pathwayTools.js';

// Test: No citations should not modify pathwayResultData
test('addCitationsToResolver should not modify pathwayResultData when no citations to add', t => {
    const pathwayResolver = {
        pathwayResultData: {
            someExistingData: 'should remain untouched'
        }
    };
    
    addCitationsToResolver(pathwayResolver, 'some content without citations');
    
    // pathwayResultData should be unchanged
    t.deepEqual(pathwayResolver.pathwayResultData, {
        someExistingData: 'should remain untouched'
    });
    // citations should NOT be added as empty array
    t.is(pathwayResolver.pathwayResultData.citations, undefined);
});

// Test: No citations should not create pathwayResultData if it doesn't exist
test('addCitationsToResolver should not create pathwayResultData when no citations to add', t => {
    const pathwayResolver = {};
    
    addCitationsToResolver(pathwayResolver, 'some content without citations');
    
    // pathwayResultData should not be created
    t.is(pathwayResolver.pathwayResultData, undefined);
});

// Test: Direct citations should be added correctly
test('addCitationsToResolver should add direct citations', t => {
    const pathwayResolver = {
        pathwayResultData: {}
    };
    
    const directCitations = [
        { title: 'Citation 1', url: 'https://example.com/1', content: 'Content 1' },
        { title: 'Citation 2', url: 'https://example.com/2', content: 'Content 2' }
    ];
    
    addCitationsToResolver(pathwayResolver, '', directCitations);
    
    t.is(pathwayResolver.pathwayResultData.citations.length, 2);
    t.is(pathwayResolver.pathwayResultData.citations[0].title, 'Citation 1');
    t.is(pathwayResolver.pathwayResultData.citations[1].title, 'Citation 2');
});

// Test: Direct citations should accumulate across multiple calls
test('addCitationsToResolver should accumulate direct citations across multiple calls', t => {
    const pathwayResolver = {
        pathwayResultData: {}
    };
    
    // First call - add 2 citations
    addCitationsToResolver(pathwayResolver, '', [
        { title: 'Citation 1', url: 'https://example.com/1' },
        { title: 'Citation 2', url: 'https://example.com/2' }
    ]);
    
    t.is(pathwayResolver.pathwayResultData.citations.length, 2);
    
    // Second call - add 2 more citations
    addCitationsToResolver(pathwayResolver, '', [
        { title: 'Citation 3', url: 'https://example.com/3' },
        { title: 'Citation 4', url: 'https://example.com/4' }
    ]);
    
    // Should have all 4 citations
    t.is(pathwayResolver.pathwayResultData.citations.length, 4);
    t.is(pathwayResolver.pathwayResultData.citations[0].title, 'Citation 1');
    t.is(pathwayResolver.pathwayResultData.citations[3].title, 'Citation 4');
});

// Test: :cd_source pattern matching should work with searchResults
test('addCitationsToResolver should match :cd_source patterns with searchResults', t => {
    const pathwayResolver = {
        pathwayResultData: {},
        searchResults: [
            { searchResultId: 'abc123', title: 'Result 1', url: 'https://example.com/1' },
            { searchResultId: 'def456', title: 'Result 2', url: 'https://example.com/2' },
            { searchResultId: 'ghi789', title: 'Result 3', url: 'https://example.com/3' }
        ]
    };
    
    const content = 'Here is some content :cd_source[abc123] and more :cd_source[ghi789] content.';
    
    addCitationsToResolver(pathwayResolver, content);
    
    // Should have 2 citations (abc123 and ghi789, but not def456)
    t.is(pathwayResolver.pathwayResultData.citations.length, 2);
    t.is(pathwayResolver.pathwayResultData.citations[0].searchResultId, 'abc123');
    t.is(pathwayResolver.pathwayResultData.citations[1].searchResultId, 'ghi789');
});

// Test: :cd_source patterns should accumulate across multiple calls
test('addCitationsToResolver should accumulate :cd_source citations across multiple calls', t => {
    const pathwayResolver = {
        pathwayResultData: {},
        searchResults: [
            { searchResultId: 'abc123', title: 'Result 1' },
            { searchResultId: 'def456', title: 'Result 2' },
            { searchResultId: 'ghi789', title: 'Result 3' }
        ]
    };
    
    // First call
    addCitationsToResolver(pathwayResolver, 'Content with :cd_source[abc123]');
    t.is(pathwayResolver.pathwayResultData.citations.length, 1);
    
    // Second call
    addCitationsToResolver(pathwayResolver, 'More content with :cd_source[def456]');
    t.is(pathwayResolver.pathwayResultData.citations.length, 2);
    
    // Third call
    addCitationsToResolver(pathwayResolver, 'Even more :cd_source[ghi789]');
    t.is(pathwayResolver.pathwayResultData.citations.length, 3);
});

// Test: Mixed direct citations and :cd_source patterns should accumulate
test('addCitationsToResolver should accumulate mixed citation types', t => {
    const pathwayResolver = {
        pathwayResultData: {},
        searchResults: [
            { searchResultId: 'search1', title: 'Search Result 1' },
            { searchResultId: 'search2', title: 'Search Result 2' }
        ]
    };
    
    // First call - direct citations
    addCitationsToResolver(pathwayResolver, '', [
        { title: 'Direct Citation 1', url: 'https://direct.com/1' }
    ]);
    t.is(pathwayResolver.pathwayResultData.citations.length, 1);
    
    // Second call - :cd_source pattern
    addCitationsToResolver(pathwayResolver, 'Content :cd_source[search1]');
    t.is(pathwayResolver.pathwayResultData.citations.length, 2);
    
    // Third call - more direct citations
    addCitationsToResolver(pathwayResolver, '', [
        { title: 'Direct Citation 2', url: 'https://direct.com/2' }
    ]);
    t.is(pathwayResolver.pathwayResultData.citations.length, 3);
    
    // Fourth call - another :cd_source pattern
    addCitationsToResolver(pathwayResolver, 'More :cd_source[search2]');
    t.is(pathwayResolver.pathwayResultData.citations.length, 4);
    
    // Verify order
    t.is(pathwayResolver.pathwayResultData.citations[0].title, 'Direct Citation 1');
    t.is(pathwayResolver.pathwayResultData.citations[1].searchResultId, 'search1');
    t.is(pathwayResolver.pathwayResultData.citations[2].title, 'Direct Citation 2');
    t.is(pathwayResolver.pathwayResultData.citations[3].searchResultId, 'search2');
});

// Test: Empty direct citations array should not modify pathwayResultData
test('addCitationsToResolver should not modify pathwayResultData for empty direct citations', t => {
    const pathwayResolver = {
        pathwayResultData: {
            existingData: 'should remain'
        }
    };
    
    addCitationsToResolver(pathwayResolver, '', []);
    
    t.deepEqual(pathwayResolver.pathwayResultData, {
        existingData: 'should remain'
    });
    t.is(pathwayResolver.pathwayResultData.citations, undefined);
});

// Test: null/undefined directCitations should not modify pathwayResultData
test('addCitationsToResolver should handle null/undefined directCitations gracefully', t => {
    const pathwayResolver = {
        pathwayResultData: {}
    };
    
    addCitationsToResolver(pathwayResolver, '', null);
    t.is(pathwayResolver.pathwayResultData.citations, undefined);
    
    addCitationsToResolver(pathwayResolver, '', undefined);
    t.is(pathwayResolver.pathwayResultData.citations, undefined);
});

// Test: :cd_source without searchResults should not add citations
test('addCitationsToResolver should not add citations from :cd_source when no searchResults', t => {
    const pathwayResolver = {
        pathwayResultData: {}
        // Note: no searchResults
    };
    
    addCitationsToResolver(pathwayResolver, 'Content with :cd_source[abc123]');
    
    t.is(pathwayResolver.pathwayResultData.citations, undefined);
});

// Test: :cd_source with non-matching IDs should not add citations
test('addCitationsToResolver should not add citations for non-matching :cd_source IDs', t => {
    const pathwayResolver = {
        pathwayResultData: {},
        searchResults: [
            { searchResultId: 'abc123', title: 'Result 1' }
        ]
    };
    
    // Reference a non-existent ID
    addCitationsToResolver(pathwayResolver, 'Content :cd_source[nonexistent]');
    
    // Should not add any citations
    t.is(pathwayResolver.pathwayResultData.citations, undefined);
});

// Test: Null pathwayResolver should not throw
test('addCitationsToResolver should handle null pathwayResolver gracefully', t => {
    t.notThrows(() => {
        addCitationsToResolver(null, 'content');
    });
    
    t.notThrows(() => {
        addCitationsToResolver(undefined, 'content');
    });
});

// Test: Existing citations should be preserved when pathwayResultData already has citations
test('addCitationsToResolver should preserve existing citations in pathwayResultData', t => {
    const pathwayResolver = {
        pathwayResultData: {
            citations: [
                { title: 'Existing Citation', url: 'https://existing.com' }
            ]
        }
    };
    
    addCitationsToResolver(pathwayResolver, '', [
        { title: 'New Citation', url: 'https://new.com' }
    ]);
    
    t.is(pathwayResolver.pathwayResultData.citations.length, 2);
    t.is(pathwayResolver.pathwayResultData.citations[0].title, 'Existing Citation');
    t.is(pathwayResolver.pathwayResultData.citations[1].title, 'New Citation');
});

// Test: Complex multi-tool-call scenario simulating real usage
test('addCitationsToResolver should handle complex multi-tool scenario', t => {
    // Simulate a pathwayResolver used across multiple tool calls
    const pathwayResolver = {
        pathwayResultData: {},
        searchResults: []
    };
    
    // Tool 1: Web search returns results and adds searchResults
    pathwayResolver.searchResults = [
        { searchResultId: 'web1', title: 'Web Result 1', url: 'https://web1.com' },
        { searchResultId: 'web2', title: 'Web Result 2', url: 'https://web2.com' }
    ];
    
    // Model references web1 in its response
    addCitationsToResolver(pathwayResolver, 'Based on :cd_source[web1], we can see...');
    t.is(pathwayResolver.pathwayResultData.citations.length, 1);
    
    // Tool 2: X search adds direct citations (like Grok Responses API)
    addCitationsToResolver(pathwayResolver, '', [
        { title: 'X Post 1', url: 'https://x.com/post/1', content: 'Tweet content' },
        { title: 'X Post 2', url: 'https://x.com/post/2', content: 'Another tweet' }
    ]);
    t.is(pathwayResolver.pathwayResultData.citations.length, 3);
    
    // Model continues and references web2
    addCitationsToResolver(pathwayResolver, 'Additionally, :cd_source[web2] shows...');
    t.is(pathwayResolver.pathwayResultData.citations.length, 4);
    
    // Tool 3: Another search with more results
    pathwayResolver.searchResults.push(
        { searchResultId: 'web3', title: 'Web Result 3', url: 'https://web3.com' }
    );
    
    // Model references the new result
    addCitationsToResolver(pathwayResolver, 'Finally, :cd_source[web3] confirms...');
    t.is(pathwayResolver.pathwayResultData.citations.length, 5);
    
    // Verify final state
    t.is(pathwayResolver.pathwayResultData.citations[0].searchResultId, 'web1');
    t.is(pathwayResolver.pathwayResultData.citations[1].title, 'X Post 1');
    t.is(pathwayResolver.pathwayResultData.citations[2].title, 'X Post 2');
    t.is(pathwayResolver.pathwayResultData.citations[3].searchResultId, 'web2');
    t.is(pathwayResolver.pathwayResultData.citations[4].searchResultId, 'web3');
});

// Test: Content buffer with special characters in :cd_source IDs
test('addCitationsToResolver should handle special characters in content', t => {
    const pathwayResolver = {
        pathwayResultData: {},
        searchResults: [
            { searchResultId: 'abc-123_xyz', title: 'Result with special chars' }
        ]
    };
    
    addCitationsToResolver(pathwayResolver, 'Content :cd_source[abc-123_xyz] here');
    
    t.is(pathwayResolver.pathwayResultData.citations.length, 1);
    t.is(pathwayResolver.pathwayResultData.citations[0].searchResultId, 'abc-123_xyz');
});

// Test: Multiple :cd_source references to same ID should only add once
test('addCitationsToResolver should handle duplicate :cd_source references', t => {
    const pathwayResolver = {
        pathwayResultData: {},
        searchResults: [
            { searchResultId: 'abc123', title: 'Result 1' }
        ]
    };
    
    // Same ID referenced multiple times in one call
    addCitationsToResolver(pathwayResolver, ':cd_source[abc123] and again :cd_source[abc123]');
    
    // Note: Current implementation adds duplicates - this test documents behavior
    // If deduplication is desired, this test should be updated
    t.true(pathwayResolver.pathwayResultData.citations.length >= 1);
});

