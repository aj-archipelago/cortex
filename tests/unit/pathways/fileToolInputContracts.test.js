import test from 'ava';

import analyzeFileTool from '../../../pathways/system/entity/tools/sys_tool_analyzefile.js';
import mermaidTool from '../../../pathways/system/entity/tools/sys_tool_mermaid.js';
import viewImageTool from '../../../pathways/system/entity/tools/sys_tool_view_image.js';

test('analyze file exposes unified file analysis tools', t => {
    const names = analyzeFileTool.toolDefinition.map(tool => tool.function.name);

    t.deepEqual(names, ['AnalyzePDF', 'AnalyzeVideo']);
});

test('analyze file requires fileAccessPlan for file lookup', async t => {
    const result = await analyzeFileTool.executePathway({
        args: {
            files: ['report.pdf'],
            detailedInstructions: 'summarize this file',
        },
        runAllPrompts: () => {
            throw new Error('runAllPrompts should not be called');
        },
        resolver: {},
    });

    const parsed = JSON.parse(result);
    t.true(parsed.error.includes('fileAccessPlan is required'));
});

test('view images requires fileAccessPlan for file lookup', async t => {
    await t.throwsAsync(
        viewImageTool.executePathway({
            args: {
                files: ['diagram.png'],
            },
        }),
        { message: 'fileAccessPlan is required' },
    );
});

test('view images declares tool cost and file access wording', t => {
    t.is(viewImageTool.toolDefinition.toolCost, 1);
    const filesDescription = viewImageTool.toolDefinition.function.parameters.properties.files.description;
    t.true(filesDescription.includes('blobPath'));
    t.false(filesDescription.includes('availableFiles'));
});

test('mermaid tool description is not tied to coding agent context', t => {
    t.false(mermaidTool.toolDefinition[0].function.description.includes('outside of your coding agent'));
});
