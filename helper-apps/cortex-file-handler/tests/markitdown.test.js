import test from 'ava';
import axios from 'axios';
import { convertToMarkdown } from '../docHelper.js';

// Mock axios
test.before(() => {
    // Mock axios.get to simulate MarkItDown API responses
    axios.get = async (url) => {
        // First check if it starts with the correct base URL
        if (!url.startsWith(process.env.MARKITDOWN_CONVERT_URL)) {
            throw new Error('Invalid MarkItDown API URL');
        }

        // Extract the file URL from the request
        const fileUrl = decodeURIComponent(url.replace(process.env.MARKITDOWN_CONVERT_URL, ''));

        // Then validate the file URL
        if (!fileUrl) {
            throw new Error('File URL is required');
        }

        // Validate the file URL format
        try {
            new URL(fileUrl);
        } catch (e) {
            throw new Error('Invalid MarkItDown API URL');
        }

        // Finally check the file type
        if (!fileUrl.match(/\.(docx?|pptx?)$/i)) {
            throw new Error('Unsupported file type');
        }

        // Return a mock response based on the file type
        if (fileUrl.endsWith('.docx')) {
            return {
                data: {
                    markdown: '# Test Document\n\nThis is a test document converted to markdown.\n\n## Section 1\n\nContent for section 1.\n\n## Section 2\n\nContent for section 2.'
                }
            };
        } else if (fileUrl.endsWith('.doc')) {
            return {
                data: {
                    markdown: '# Legacy Document\n\nThis is a legacy document converted to markdown.\n\n## Legacy Section\n\nLegacy content.'
                }
            };
        } else if (fileUrl.endsWith('.ppt') || fileUrl.endsWith('.pptx')) {
            return {
                data: {
                    markdown: '# Presentation\n\n## Slide 1\n\n- Point 1\n- Point 2\n\n## Slide 2\n\n- Point 3\n- Point 4'
                }
            };
        }
    };
});

// Test successful DOCX conversion
test('converts DOCX to markdown successfully', async (t) => {
    const fileUrl = 'https://example.com/test.docx';
    const result = await convertToMarkdown(fileUrl);
    
    t.true(typeof result === 'string');
    t.true(result.includes('# Test Document'));
    t.true(result.includes('## Section 1'));
    t.true(result.includes('## Section 2'));
});

// Test successful DOC conversion
test('converts DOC to markdown successfully', async (t) => {
    const fileUrl = 'https://example.com/test.doc';
    const result = await convertToMarkdown(fileUrl);
    
    t.true(typeof result === 'string');
    t.true(result.includes('# Legacy Document'));
    t.true(result.includes('## Legacy Section'));
});

// Test successful PPT conversion
test('converts PPT to markdown successfully', async (t) => {
    const fileUrl = 'https://example.com/test.ppt';
    const result = await convertToMarkdown(fileUrl);
    
    t.true(typeof result === 'string');
    t.true(result.includes('# Presentation'));
    t.true(result.includes('## Slide 1'));
    t.true(result.includes('## Slide 2'));
});

// Test successful PPTX conversion
test('converts PPTX to markdown successfully', async (t) => {
    const fileUrl = 'https://example.com/test.pptx';
    const result = await convertToMarkdown(fileUrl);
    
    t.true(typeof result === 'string');
    t.true(result.includes('# Presentation'));
    t.true(result.includes('## Slide 1'));
    t.true(result.includes('## Slide 2'));
});

// Test error handling for missing file URL
test('handles missing file URL', async (t) => {
    await t.throwsAsync(
        async () => convertToMarkdown(''),
        { message: 'File URL is required' }
    );
});

// Test error handling for unsupported file type
test('handles unsupported file type', async (t) => {
    await t.throwsAsync(
        async () => convertToMarkdown('https://example.com/test.pdf'),
        { message: 'Unsupported file type' }
    );
});

// Test error handling for invalid API URL
test('handles invalid API URL', async (t) => {
    await t.throwsAsync(
        async () => convertToMarkdown('invalid-url'),
        { message: 'Invalid MarkItDown API URL' }
    );
}); 