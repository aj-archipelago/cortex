import test from 'ava';
import tool from '../../../pathways/system/entity/tools/sys_tool_view_image.js';

test('ViewImages rejects local paths outside the cloud mount with an actionable error', async t => {
    const resolver = {};
    const result = JSON.parse(await tool.executePathway({ resolver, args: {
        files: ['/workspace/review_jb/sheet1.jpg', 'file:///workspace/review_jb/sheet2.jpg'],
        fileAccessPlan: [{ kind: 'chat', userContextId: 'user', chatId: 'current', write: true }],
    } }));
    t.regex(result.error, /Local workspace image is not in the file collection/);
    t.regex(result.error, /Copy this exact file/);
    t.is(result.imageUrls, undefined);
    t.is(resolver.tool, undefined);
});
