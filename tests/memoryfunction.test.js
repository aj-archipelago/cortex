import test from 'ava';
import { modifyText } from '../pathways/system/entity/memory/sys_memory_update.js';
import { enforceTokenLimit } from '../pathways/system/entity/memory/shared/sys_memory_helpers.js';
import { processMemoryContent } from '../pathways/system/entity/memory/sys_read_memory.js';

test('enforceTokenLimit preserves priority order correctly', t => {
    const input = `
1|2024-03-19T10:00:00Z|Highest priority item
2|2024-03-19T11:00:00Z|High priority item
3|2024-03-19T12:00:00Z|Medium priority item
4|2024-03-19T13:00:00Z|Low priority item
5|2024-03-19T14:00:00Z|Lowest priority item`.trim();

    // Enforce trimming
    const result = enforceTokenLimit(input, 40);
    
    // Should keep P1, P2 only
    t.true(result.includes('1|2024-03-19T10:00:00Z|Highest priority item'));
    t.true(result.includes('2|2024-03-19T11:00:00Z|High priority item'));
    t.false(result.includes('3|2024-03-19T12:00:00Z|Medium priority item'));
    t.false(result.includes('4|2024-03-19T13:00:00Z|Low priority item'));
    t.false(result.includes('5|2024-03-19T14:00:00Z|Lowest priority item'));
});

test('enforceTokenLimit handles empty input', t => {
    t.is(enforceTokenLimit(''), '');
    t.is(enforceTokenLimit(null), null);
});

test('enforceTokenLimit removes duplicates', t => {
    const input = `
3|2024-03-19T10:00:00Z|Duplicate item
3|2024-03-19T11:00:00Z|Duplicate item
2|2024-03-19T12:00:00Z|Unique item`.trim();

    const result = enforceTokenLimit(input);
    
    // Count occurrences of "Duplicate item"
    const matches = result.match(/Duplicate item/g) || [];
    t.is(matches.length, 1);
});

test('enforceTokenLimit handles topics section differently', t => {
    const input = `
3|2024-03-19T10:00:00Z|Discussed AI ethics
2|2024-03-19T11:00:00Z|Discussed programming
1|2024-03-19T12:00:00Z|Discussed testing`.trim();

    const result = enforceTokenLimit(input, 20, true);
    
    // For topics, should remove oldest entries first regardless of content
    t.false(result.includes('10:00:00Z'));
    t.false(result.includes('11:00:00Z'));
    t.true(result.includes('12:00:00Z'));
});

test('modifyText handles delete operations with escaped characters', t => {
    const input = '2|2024-03-19T10:00:00Z|Pizza Connection: Has special appreciation for Pisanello\'s';
    const modifications = [{
        type: 'delete',
        pattern: 'Pizza Connection: Has special appreciation for Pisanello\'s'
    }];
    
    const result = modifyText(input, modifications);
    t.false(result.includes('Pizza Connection'));
});

test('modifyText handles delete with partial priority match', t => {
    const input = '3|2024-03-19T10:00:00Z|Test memory item';
    const modifications = [{
        type: 'delete',
        pattern: 'Test memory item'
    }];
    
    const result = modifyText(input, modifications);
    t.false(result.includes('Test memory item'));
});

test('modifyText handles multiple modifications in sequence', t => {
    const input = '2|2024-03-19T10:00:00Z|Keep this line\n3|2024-03-19T11:00:00Z|Delete this line\n1|2024-03-19T12:00:00Z|Also keep this';
    const modifications = [
        { type: 'delete', pattern: 'Delete this line' },
        { type: 'add', newtext: 'New line added', priority: '2' }
    ];
    
    const result = modifyText(input, modifications);
    t.true(result.includes('Keep this line'));
    t.true(result.includes('Also keep this'));
    t.true(result.includes('New line added'));
    t.false(result.includes('Delete this line'));
});

test('modifyText handles delete with whitespace variations', t => {
    const input = ' 2|2024-03-19T10:00:00Z|Item with spaces  \n3|2024-03-19T11:00:00Z|Item without spaces';
    const modifications = [
        { type: 'delete', pattern: 'Item with spaces' },
        { type: 'delete', pattern: 'Item without spaces' }
    ];
    
    const result = modifyText(input, modifications);
    t.false(result.includes('Item with spaces'));
    t.false(result.includes('Item without spaces'));
});

test('modifyText handles delete with regex special characters', t => {
    const input = '2|2024-03-19T10:00:00Z|Special (chars) [test] {here} *star*';
    const modifications = [{
        type: 'delete',
        pattern: 'Special \\(chars\\) \\[test\\] \\{here\\} \\*star\\*'
    }];
    
    const result = modifyText(input, modifications);
    t.false(result.includes('Special (chars)'));
});

test('modifyText handles content with pipe characters', t => {
    const input = '2|2024-03-19T10:00:00Z|Memory about|pipes|in|content';
    const modifications = [{
        type: 'change',
        pattern: 'Memory about\\|pipes\\|in\\|content',
        newtext: 'Updated memory'
    }];
    
    const result = modifyText(input, modifications);
    t.true(result.includes('Updated memory'));
    t.false(result.includes('Memory about|pipes|in|content'));
});

test('modifyText performs case insensitive matching', t => {
    const input = '2|2024-03-19T10:00:00Z|UPPER CASE Memory\n3|2024-03-19T11:00:00Z|lower case memory';
    const modifications = [{
        type: 'delete',
        pattern: 'upper case memory'
    }];
    
    const result = modifyText(input, modifications);
    t.false(result.includes('UPPER CASE Memory'));
});

test('modifyText handles multiple overlapping patterns', t => {
    const input = `
2|2024-03-19T10:00:00Z|Memory about AI and ML
3|2024-03-19T11:00:00Z|Memory about AI and robotics
1|2024-03-19T12:00:00Z|Memory about ML and data`.trim();
    
    const modifications = [
        { type: 'delete', pattern: '.*AI.*' },
        { type: 'change', pattern: '.*ML.*', newtext: 'Updated ML memory' }
    ];
    
    const result = modifyText(input, modifications);
    t.false(result.includes('Memory about AI'));
    t.true(result.includes('Updated ML memory'));
    t.is((result.match(/Updated ML memory/g) || []).length, 1);
});

test('modifyText preserves and updates priorities correctly', t => {
    const input = '2|2024-03-19T10:00:00Z|Original priority 2 memory';
    
    const modifications = [{
        type: 'change',
        pattern: 'Original priority 2 memory',
        newtext: 'Changed memory',
        priority: '1'
    }];
    
    const result = modifyText(input, modifications);
    // Check priority was updated to 1
    t.true(result.startsWith('1|'));
    // Check content was updated
    t.true(result.endsWith('|Changed memory'));
    // Verify timestamp format
    t.regex(result, /^1\|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\|Changed memory$/);
});

test('modifyText handles empty and invalid modifications', t => {
    const input = '2|2024-03-19T10:00:00Z|Test memory';
    
    const modifications = [
        { type: 'delete' }, // Missing pattern
        { type: 'change', pattern: 'Test' }, // Missing newtext
        { type: 'invalid', pattern: 'Test', newtext: 'Invalid' }, // Invalid type
        { type: 'add' } // Missing newtext
    ];
    
    const result = modifyText(input, modifications);
    // Check that priority and content remain unchanged
    t.true(result.startsWith('2|'));
    t.true(result.includes('|Test memory'));
    // Verify timestamp format
    t.regex(result, /^2\|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\|Test memory$/);
});

test('modifyText handles regex patterns in change operations', t => {
    const input = '2|2024-03-19T10:00:00Z|Memory from 2024-03-19';
    
    const modifications = [{
        type: 'change',
        pattern: 'Memory from \\d{4}-\\d{2}-\\d{2}',
        newtext: 'Updated date memory'
    }];
    
    const result = modifyText(input, modifications);
    t.true(result.includes('Updated date memory'));
    t.false(result.includes('Memory from 2024'));
});

test('modifyText handles malformed memory lines gracefully', t => {
    const input = `
no_separators_at_all
2|missing_content
|2024-03-19T10:00:00Z|missing_priority
2||missing_timestamp|content
2|invalid|timestamp|here|content
|||| empty parts
`.trim();
    
    const modifications = [{
        type: 'add',
        newtext: 'New valid memory'
    }];
    
    const result = modifyText(input, modifications);
    // Should preserve valid parts and add new memory
    t.true(result.includes('New valid memory'));
    // Should handle malformed lines without crashing
    t.true(result.split('\n').length > 0);
    // Verify output format for the added line
    t.regex(result, /3\|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z\|New valid memory$/m);
});

test('modifyText handles memory with special regex characters', t => {
    const input = '2|2024-03-19T10:00:00Z|Memory with (parens) and [brackets] and {braces} and +*?^$\\.';
    
    // Try to modify it with a pattern containing regex special chars
    const modifications = [{
        type: 'change',
        pattern: 'Memory with \\(parens\\) and \\[brackets\\]',
        newtext: 'Updated memory'
    }];
    
    const result = modifyText(input, modifications);
    t.true(result.includes('Updated memory'));
    t.false(result.includes('Memory with (parens)'));
});

test('modifyText handles extremely long memory lines', t => {
    const longContent = 'a'.repeat(1000);
    const input = `2|2024-03-19T10:00:00Z|${longContent}`;
    
    const modifications = [{
        type: 'change',
        pattern: 'a+',
        newtext: 'Shortened memory'
    }];
    
    const result = modifyText(input, modifications);
    t.true(result.includes('Shortened memory'));
    t.false(result.includes(longContent));
});

test('modifyText handles unicode and special characters', t => {
    const input = '2|2024-03-19T10:00:00Z|Memory with 🚀 emoji and üñîçødé and "quotes" and \'apostrophes\'';
    
    const modifications = [{
        type: 'change',
        pattern: 'Memory with.*emoji',
        newtext: 'Updated with more 🎉 emoji'
    }];
    
    const result = modifyText(input, modifications);
    t.true(result.includes('Updated with more 🎉 emoji'));
    t.false(result.includes('Memory with 🚀 emoji'));
});

test('modifyText handles various regex pattern types', t => {
    const input = `
2|2024-03-19T10:00:00Z|Start of line memory
3|2024-03-19T11:00:00Z|Memory in the middle
1|2024-03-19T12:00:00Z|Memory at the end
2|2024-03-19T13:00:00Z|12345 numeric memory
3|2024-03-19T14:00:00Z|Multiple   spaces   here
2|2024-03-19T15:00:00Z|Line.with.dots
2|2024-03-19T16:00:00Z|Line_with_underscores
2|2024-03-19T17:00:00Z|This is a long memory that we want to match partially`.trim();

    const modifications = [
        { type: 'delete', pattern: '^Start.*memory$' },  // Start of line to end
        { type: 'delete', pattern: 'Memory at the end$' },    // End of line
        { type: 'delete', pattern: '\\d{5}.*memory' },    // Numbers followed by text
        { type: 'change', pattern: 'Multiple\\s+spaces\\s+here', newtext: 'Single Space', priority: '1' },  // Multiple spaces
        { type: 'delete', pattern: 'Line\\.with\\.dots' },    // Escaped dots
        { type: 'delete', pattern: 'Line_with_underscores' },      // Underscores
        { type: 'change', pattern: '^This.*partially$', newtext: 'Shortened' }  // Full line match
    ];

    const result = modifyText(input, modifications);
    t.false(result.includes('Start of line memory'));
    t.false(result.includes('Memory at the end'));
    t.false(result.includes('12345'));
    t.true(result.includes('Single Space'));
    t.false(result.includes('Line.with.dots'));
    t.false(result.includes('Line_with_underscores'));
    t.true(result.includes('Shortened'));
});

test('modifyText handles regex pattern edge cases', t => {
    const input = `
2|2024-03-19T10:00:00Z|Empty string match: 
3|2024-03-19T11:00:00Z|Zero-width match: abc
1|2024-03-19T12:00:00Z|Lookahead: testing123
2|2024-03-19T13:00:00Z|Backreference: hello hello
3|2024-03-19T14:00:00Z|Non-greedy: <tag>content</tag>`.trim();

    const modifications = [
        { type: 'change', pattern: '^Empty string match:\\s*$', newtext: 'EMPTY' },  // Empty string
        { type: 'change', pattern: 'Zero-width match: \\w{3}', newtext: 'ZERO_WIDTH' },  // Word chars
        { type: 'change', pattern: 'Lookahead: \\w+\\d+', newtext: 'LOOKAHEAD' },  // Word chars followed by numbers
        { type: 'change', pattern: 'Backreference: (\\w+)\\s\\1', newtext: 'REPEATED' },  // Same word repeated
        { type: 'change', pattern: 'Non-greedy: <[^>]+>[^<]+</[^>]+>', newtext: 'TAG' }  // XML-like tag
    ];

    const result = modifyText(input, modifications);
    t.true(result.includes('EMPTY'));
    t.true(result.includes('ZERO_WIDTH'));
    t.true(result.includes('LOOKAHEAD'));
    t.true(result.includes('REPEATED'));
    t.true(result.includes('TAG'));
});

test('modifyText handles pattern groups and alternation', t => {
    const input = `
2|2024-03-19T10:00:00Z|Group1: apple orange
3|2024-03-19T11:00:00Z|Group2: banana grape
1|2024-03-19T12:00:00Z|Either: cat
2|2024-03-19T13:00:00Z|Either: dog
3|2024-03-19T14:00:00Z|Mixed: apple dog banana`.trim();

    const modifications = [
        { type: 'change', pattern: 'Group\\d: (apple|banana) \\w+', newtext: 'Category: $1 fruit' },  // Capture and alternation
        { type: 'change', pattern: 'Either: (cat|dog)', newtext: 'Either: pet' },  // Simple alternation
        { type: 'change', pattern: 'Mixed: (\\w+) (\\w+) (\\w+)', newtext: 'Mixed: $1 and $2 with $3' }  // Multiple captures
    ];

    const result = modifyText(input, modifications);
    t.true(result.includes('Category: apple fruit'));
    t.true(result.includes('Category: banana fruit'));
    t.true(result.includes('Either: pet'));
    t.true(result.includes('Mixed: apple and dog with banana'));
});

test('enforceTokenLimit sorts topics by timestamp before trimming', t => {
    const input = `
3|2024-03-19T15:00:00Z|Newest topic
3|2024-03-19T10:00:00Z|Older topic
3|2024-03-19T12:00:00Z|Middle topic
3|2024-03-19T14:00:00Z|Recent topic
3|2024-03-19T11:00:00Z|Old topic`.trim();

    // Set a small token limit to force trimming
    const result = enforceTokenLimit(input, 40, true);
    
    // Should keep newest topics
    t.true(result.includes('Newest topic'));
    t.true(result.includes('Recent topic'));
    // Should remove oldest topics
    t.false(result.includes('Older topic'));
    t.false(result.includes('Old topic'));
    
    // Verify order
    const lines = result.split('\n');
    t.true(lines[0].includes('Newest topic')); // First line should be newest
});

test('enforceTokenLimit handles missing timestamps in topics', t => {
    const input = `
3||Current topic
3|2024-03-19T15:00:00Z|Newer topic
3|2024-03-19T10:00:00Z|Older topic`.trim();

    const result = enforceTokenLimit(input, 40, true);
    
    // Missing timestamp should be treated as oldest
    t.false(result.includes('Current topic'));
    t.true(result.includes('Newer topic'));
});

test('enforceTokenLimit handles large content with pipes', t => {
    const input = `
1|2024-03-19T15:00:00Z|Memory with|multiple|pipes|in|content
2|2024-03-19T14:00:00Z|Another|piped|memory
3|2024-03-19T13:00:00Z|Simple memory`.trim();

    const result = enforceTokenLimit(input, 50);
    
    // Should preserve pipes in content when under limit
    t.true(result.includes('Memory with|multiple|pipes|in|content'));
});

test('enforceTokenLimit removes duplicates while preserving newest timestamp', t => {
    const input = `
3|2024-03-19T10:00:00Z|Duplicate content
3|2024-03-19T15:00:00Z|Duplicate content
3|2024-03-19T12:00:00Z|Duplicate content
2|2024-03-19T14:00:00Z|Unique content`.trim();

    const result = enforceTokenLimit(input, 1000, true);
    
    // Should only have one instance of duplicate content
    t.is((result.match(/Duplicate content/g) || []).length, 1);
    // Should keep the newest timestamp version
    t.true(result.includes('2024-03-19T15:00:00Z|Duplicate content'));
});

test('enforceTokenLimit handles recursive trimming when estimation is off', t => {
    // Create content that will need multiple trim passes
    const input = Array.from({ length: 20 }, (_, i) => 
        `${i % 3 + 1}|2024-03-19T${String(i).padStart(2, '0')}:00:00Z|Memory ${i} ${'x'.repeat(50)}`
    ).join('\n');

    const result = enforceTokenLimit(input, 200);
    
    // Should have significantly fewer lines than input
    t.true(result.split('\n').length < input.split('\n').length);
    // Should still maintain priority order
    const priorities = result.split('\n').map(line => parseInt(line.split('|')[0]));
    t.deepEqual(priorities, [...priorities].sort((a, b) => b - a));
});

test('enforceTokenLimit preserves empty lines in non-topics mode', t => {
    const input = `
1|2024-03-19T15:00:00Z|First memory

2|2024-03-19T14:00:00Z|Second memory

3|2024-03-19T13:00:00Z|Third memory`.trim();

    const result = enforceTokenLimit(input, 1000);
    
    // Should preserve content but remove empty lines
    t.true(result.includes('First memory'));
    t.true(result.includes('Second memory'));
    t.true(result.includes('Third memory'));
    // Should not have empty lines
    t.false(result.includes('\n\n'));
});

test('enforceTokenLimit handles malformed input gracefully', t => {
    const input = `
invalid_line_no_separators
1|2024-03-19T15:00:00Z|Valid memory
||
2||Invalid but with separators
3|invalid_timestamp|Still valid content`.trim();

    const result = enforceTokenLimit(input, 100, true);
    
    // Should keep valid content
    t.true(result.includes('Valid memory'));
    // Should handle malformed lines without crashing
    t.true(result.length > 0);
});

// processMemoryContent tests
test('processMemoryContent handles empty and null input', t => {
    t.is(processMemoryContent('', {}), '');
    t.is(processMemoryContent(null, {}), null);
    t.is(processMemoryContent(undefined, {}), undefined);
});

test('processMemoryContent returns unmodified content when no options set', t => {
    const input = '1|2024-03-19T10:00:00Z|Test content';
    t.is(processMemoryContent(input, {}), input);
    t.is(processMemoryContent(input, { priority: 0, recentHours: 0, numResults: 0, stripMetadata: false }), input);
});

test('processMemoryContent filters by priority correctly', t => {
    const input = `
1|2024-03-19T10:00:00Z|Priority 1
2|2024-03-19T10:00:00Z|Priority 2
3|2024-03-19T10:00:00Z|Priority 3
invalid|2024-03-19T10:00:00Z|Invalid priority
|2024-03-19T10:00:00Z|Missing priority`.trim();

    const result = processMemoryContent(input, { priority: 2 });
    t.true(result.includes('Priority 1'));
    t.true(result.includes('Priority 2'));
    t.false(result.includes('Priority 3'));
    t.false(result.includes('Invalid priority'));
    t.false(result.includes('Missing priority'));
});

test('processMemoryContent filters by recency correctly', t => {
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const recentTime = new Date(now - hour).toISOString();
    const oldTime = new Date(now - 3 * hour).toISOString();
    
    const input = `
1|${recentTime}|Recent memory
2|${oldTime}|Old memory
3|invalid_time|Invalid timestamp
4||Missing timestamp`.trim();

    const result = processMemoryContent(input, { recentHours: 2 });
    t.true(result.includes('Recent memory'));
    t.false(result.includes('Old memory'));
    t.false(result.includes('Invalid timestamp'));
    t.false(result.includes('Missing timestamp'));
});

test('processMemoryContent applies numResults limit correctly', t => {
    const input = `
1|2024-03-19T10:00:00.000Z|First
2|2024-03-19T11:00:00.000Z|Second
3|2024-03-19T12:00:00.000Z|Third`.trim();

    const result = processMemoryContent(input, { numResults: 2 });
    t.true(result.includes('Third'));  // Newest
    t.true(result.includes('Second')); // Second newest
    t.false(result.includes('First')); // Oldest
    t.is(result.split('\n').length, 2);
});

test('processMemoryContent strips metadata correctly', t => {
    const input = `
1|2024-03-19T10:00:00Z|Normal content
2|2024-03-19T11:00:00Z|Content with|pipes|inside
malformed_line_no_separators
3|2024-03-19T12:00:00Z|More|content
4|invalid_timestamp|Still valid
5||No timestamp but valid
|2024-03-19T13:00:00Z|No priority
||No priority or timestamp`.trim();

    const result = processMemoryContent(input, { stripMetadata: true });
    t.true(result.includes('Normal content'));
    t.true(result.includes('Content with|pipes|inside'));
    t.true(result.includes('More|content'));
    t.true(result.includes('Still valid'));
    t.true(result.includes('No timestamp but valid'));
    t.false(result.includes('2024-03-19'));
    t.false(result.includes('|2024'));
    // Malformed lines should be preserved as-is
    t.true(result.includes('malformed_line_no_separators'));
});

test('processMemoryContent combines all filters correctly', t => {
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const recentTime = new Date(now - hour).toISOString();
    const oldTime = new Date(now - 3 * hour).toISOString();
    
    const input = `
1|${recentTime}|High priority recent
2|${recentTime}|Medium priority recent
3|${recentTime}|Low priority recent
1|${oldTime}|High priority old
2|${oldTime}|Medium priority old
3|${oldTime}|Low priority old`.trim();

    const result = processMemoryContent(input, {
        priority: 2,
        recentHours: 2,
        numResults: 2,
        stripMetadata: true
    });

    // Should only include recent memories with priority 1-2, limited to 2 results
    t.true(result.includes('High priority recent'));
    t.true(result.includes('Medium priority recent'));
    t.false(result.includes('Low priority recent'));
    t.false(result.includes('High priority old'));
    t.false(result.includes('Medium priority old'));
    t.false(result.includes('Low priority old'));
    t.false(result.includes('|')); // Metadata should be stripped
    t.is(result.split('\n').length, 2); // Should only have 2 results
});

test('processMemoryContent handles empty lines and whitespace', t => {
    const input = `

1|2024-03-19T10:00:00Z|Content 1

2|2024-03-19T11:00:00Z|Content 2

`.trim();

    const result = processMemoryContent(input, { stripMetadata: true });
    t.is(result.split('\n').filter(Boolean).length, 2);
    t.true(result.includes('Content 1'));
    t.true(result.includes('Content 2'));
});

test('processMemoryContent handles special characters in content', t => {
    const input = `
1|2024-03-19T10:00:00Z|Content with 🚀 emoji
2|2024-03-19T11:00:00Z|Content with üñîçødé
3|2024-03-19T12:00:00Z|Content with "quotes" and 'apostrophes'
4|2024-03-19T13:00:00Z|Content with \n\t\r escape chars`.trim();

    const result = processMemoryContent(input, { stripMetadata: true });
    t.true(result.includes('Content with 🚀 emoji'));
    t.true(result.includes('Content with üñîçødé'));
    t.true(result.includes('Content with "quotes" and \'apostrophes\''));
    t.true(result.includes('Content with \n\t\r escape chars'));
});

test('processMemoryContent handles extremely long content', t => {
    const longContent = 'a'.repeat(10000);
    const input = `1|2024-03-19T10:00:00Z|${longContent}`;
    
    const result = processMemoryContent(input, { stripMetadata: true });
    t.is(result, longContent);
});

test('processMemoryContent priority filtering edge cases', t => {
    const input = `
1|2024-03-19T10:00:00Z|Valid priority 1
01|2024-03-19T10:00:00Z|Leading zero priority
1.5|2024-03-19T10:00:00Z|Decimal priority
-1|2024-03-19T10:00:00Z|Negative priority
a|2024-03-19T10:00:00Z|Letter priority
9999|2024-03-19T10:00:00Z|Large priority`.trim();

    const result = processMemoryContent(input, { priority: 2 });
    t.true(result.includes('Valid priority 1'));
    t.false(result.includes('Decimal priority'));
    t.false(result.includes('Negative priority'));
    t.false(result.includes('Letter priority'));
    t.false(result.includes('Large priority'));
});

test('processMemoryContent timestamp filtering edge cases', t => {
    const now = new Date();
    const input = `
1|${now.toISOString()}|Valid ISO timestamp
1|${now.toUTCString()}|UTC timestamp
1|${now.getTime()}|Timestamp as number
1|2024-03-19|Partial date
1|Invalid Date|Invalid date string
1|9999999999999|Future timestamp`.trim();

    const result = processMemoryContent(input, { recentHours: 1 });
    t.true(result.includes('Valid ISO timestamp'));
    t.false(result.includes('UTC timestamp'));
    t.false(result.includes('Timestamp as number'));
    t.false(result.includes('Partial date'));
    t.false(result.includes('Invalid date string'));
    t.false(result.includes('Future timestamp'));
});