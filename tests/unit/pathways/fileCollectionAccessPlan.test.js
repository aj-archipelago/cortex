import test from 'ava';

import readFileCollection from '../../../pathways/system/entity/files/sys_read_file_collection.js';
import updateFileMetadata from '../../../pathways/system/entity/files/sys_update_file_metadata.js';
import fileCollectionTool from '../../../pathways/system/entity/tools/sys_tool_file_collection.js';

test('file collection pathways use fileAccessPlan inputs', t => {
    t.truthy(readFileCollection.inputParameters.fileAccessPlan);
    t.truthy(updateFileMetadata.inputParameters.fileAccessPlan);
    t.falsy(readFileCollection.inputParameters.agentContext);
    t.falsy(updateFileMetadata.inputParameters.agentContext);
});

test('file collection tool exposes unified FileCollection tool', t => {
    const names = fileCollectionTool.toolDefinition.map(tool => tool.function.name);

    t.deepEqual(names, ['FileCollection']);
    t.true(fileCollectionTool.toolDefinition[0].function.parameters.required.includes('userMessage'));
    t.truthy(fileCollectionTool.toolDefinition[0].function.parameters.properties.fileRef);
    t.truthy(fileCollectionTool.toolDefinition[0].function.parameters.properties.query);
    t.truthy(fileCollectionTool.toolDefinition[0].function.parameters.properties.fileIds);
});
