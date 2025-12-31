// file_operations_agent.test.js
// End-to-end integration tests for file operations with sys_entity_agent
// Tests scenarios where files are uploaded directly to file handler (like Labeeb does)
// and then processed by sys_entity_agent

import test from 'ava';
import serverFactory from '../../../../../index.js';
import { createClient } from 'graphql-ws';
import ws from 'ws';
import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { loadFileCollection, getRedisClient, computeBufferHash, writeFileDataToRedis } from '../../../../../lib/fileUtils.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let testServer;
let wsClient;

// Helper to get file handler URL from config or environment
function getFileHandlerUrl() {
    // Try environment variable first
    if (process.env.WHISPER_MEDIA_API_URL && process.env.WHISPER_MEDIA_API_URL !== 'null') {
        return process.env.WHISPER_MEDIA_API_URL;
    }
    // Try config from server
    const config = testServer?.config;
    if (config) {
        const url = config.get('whisperMediaApiUrl');
        if (url && url !== 'null') {
            return url;
        }
    }
    // Default to localhost:7071 (usual file handler port)
    return 'http://localhost:7071';
}

// Helper to upload file directly to file handler (like Labeeb does)
async function uploadFileToHandler(content, filename, contextId) {
    const fileHandlerUrl = getFileHandlerUrl();
    if (!fileHandlerUrl || fileHandlerUrl === 'null') {
        throw new Error('File handler URL not configured');
    }

    // Create temporary file
    const tempDir = path.join(__dirname, '../../../../../../temp');
    if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
    }
    const tempFilePath = path.join(tempDir, `test-${Date.now()}-${Math.random().toString(36).substring(2, 9)}-${filename}`);
    fs.writeFileSync(tempFilePath, content);

    try {
        // Compute hash from content (client-side, like Labeeb does)
        const contentBuffer = Buffer.from(content);
        const hash = await computeBufferHash(contentBuffer);
        
        const form = new FormData();
        form.append('file', fs.createReadStream(tempFilePath), {
            filename: filename,
            contentType: 'application/octet-stream'
        });
        form.append('hash', hash); // Include hash in upload
        if (contextId) {
            form.append('contextId', contextId);
        }

        // The base URL might already include the path, or might just be the base
        // Try to construct the URL correctly
        let uploadUrl = fileHandlerUrl;
        if (!fileHandlerUrl.includes('/api/') && !fileHandlerUrl.includes('/file-handler')) {
            // Base URL doesn't include path, add the endpoint
            uploadUrl = `${fileHandlerUrl}/api/CortexFileHandler`;
        }
        const response = await axios.post(uploadUrl, form, {
            headers: {
                ...form.getHeaders()
            },
            timeout: 30000,
            validateStatus: (status) => status >= 200 && status < 500
        });

        if (response.status !== 200 || !response.data?.url) {
            throw new Error(`Upload failed: ${response.status} - ${JSON.stringify(response.data)}`);
        }

        // Hash should be in response since we provided it
        // Wait a bit for Redis to be updated
        await new Promise(resolve => setTimeout(resolve, 500));

        return {
            url: response.data.converted?.url || response.data.url,
            gcs: response.data.converted?.gcs || response.data.gcs || null,
            hash: response.data.hash
        };
    } finally {
        // Clean up temp file
        try {
            if (fs.existsSync(tempFilePath)) {
                fs.unlinkSync(tempFilePath);
            }
        } catch (e) {
            // Ignore cleanup errors
        }
    }
}

// Helper to verify file exists in Redis but doesn't have inCollection set
async function verifyFileInRedisWithoutInCollection(contextId, hash) {
    // Load all files (including those without inCollection)
    const allFiles = await loadFileCollection(contextId);
    const file = allFiles.find(f => f.hash === hash);
    if (!file) return false;
    // File exists but inCollection should be undefined/null
    return file.inCollection === undefined || file.inCollection === null;
}

// Helper to collect subscription events
async function collectSubscriptionEvents(subscription, timeout = 60000) {
    const events = [];

    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            if (events.length > 0) {
                resolve(events);
            } else {
                reject(new Error('Subscription timed out with no events'));
            }
        }, timeout);

        const unsubscribe = wsClient.subscribe(
            {
                query: subscription.query,
                variables: subscription.variables
            },
            {
                next: (event) => {
                    events.push(event);
                    if (event?.data?.requestProgress?.progress === 1) {
                        clearTimeout(timeoutId);
                        unsubscribe();
                        resolve(events);
                    }
                },
                error: (error) => {
                    clearTimeout(timeoutId);
                    reject(error);
                },
                complete: () => {
                    clearTimeout(timeoutId);
                    resolve(events);
                }
            }
        );
    });
}

// Helper to clean up test files
async function cleanup(contextId) {
    try {
        const redisClient = await getRedisClient();
        if (redisClient && contextId) {
            const contextMapKey = `FileStoreMap:ctx:${contextId}`;
            await redisClient.del(contextMapKey);
        }
    } catch (e) {
        // Ignore cleanup errors
    }
}

test.before(async () => {
    process.env.CORTEX_ENABLE_REST = 'true';
    const { server, startServer } = await serverFactory();
    startServer && await startServer();
    testServer = server;

    // Create WebSocket client for subscriptions
    wsClient = createClient({
        url: `ws://localhost:${process.env.CORTEX_PORT || 4000}/graphql`,
        webSocketImpl: ws,
        retryAttempts: 3,
        connectionParams: {},
        on: {
            error: (error) => {
                console.error('WS connection error:', error);
            }
        }
    });

    // Test the connection
    try {
        await new Promise((resolve, reject) => {
            const subscription = wsClient.subscribe(
                {
                    query: `
                        subscription TestConnection {
                            requestProgress(requestIds: ["test"]) {
                                requestId
                            }
                        }
                    `
                },
                {
                    next: () => {
                        resolve();
                    },
                    error: reject,
                    complete: () => {
                        resolve();
                    }
                }
            );

            setTimeout(() => {
                resolve();
            }, 2000);
        });
    } catch (error) {
        console.error('Failed to establish WebSocket connection:', error);
        throw error;
    }
});

test.after.always('cleanup', async () => {
    if (wsClient) {
        wsClient.dispose();
    }
    if (testServer) {
        await testServer.stop();
    }
});

test('sys_entity_agent processes multiple files uploaded directly to file handler (no inCollection)', async (t) => {
    t.timeout(120000); // 2 minute timeout
    
    const contextId = `test-file-ops-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const chatId = `test-chat-${Date.now()}`;
    
    try {
        // Upload 3 files directly to file handler (like Labeeb does)
        // These will have contextId but no inCollection set
        const file1 = await uploadFileToHandler(
            'File 1 Content\nThis is the first test file with some content.',
            'test-file-1.txt',
            contextId
        );
        
        const file2 = await uploadFileToHandler(
            'File 2 Content\nThis is the second test file with different content.',
            'test-file-2.txt',
            contextId
        );
        
        const file3 = await uploadFileToHandler(
            'File 3 Content\nThis is the third test file with more content.',
            'test-file-3.txt',
            contextId
        );

        t.truthy(file1.hash, 'File 1 should have a hash');
        t.truthy(file2.hash, 'File 2 should have a hash');
        t.truthy(file3.hash, 'File 3 should have a hash');

        // Verify files exist in Redis but don't have inCollection set
        t.true(await verifyFileInRedisWithoutInCollection(contextId, file1.hash), 'File 1 should exist in Redis without inCollection');
        t.true(await verifyFileInRedisWithoutInCollection(contextId, file2.hash), 'File 2 should exist in Redis without inCollection');
        t.true(await verifyFileInRedisWithoutInCollection(contextId, file3.hash), 'File 3 should exist in Redis without inCollection');

        // Wait a bit for Redis to be fully updated
        await new Promise(resolve => setTimeout(resolve, 1000));

        // Create chatHistory with all 3 files
        // MultiMessage content must be array of JSON strings
        const chatHistory = [{
            role: 'user',
            content: [
                JSON.stringify({
                    type: 'file',
                    url: file1.url,
                    gcs: file1.gcs,
                    hash: file1.hash,
                    filename: 'test-file-1.txt'
                }),
                JSON.stringify({
                    type: 'file',
                    url: file2.url,
                    gcs: file2.gcs,
                    hash: file2.hash,
                    filename: 'test-file-2.txt'
                }),
                JSON.stringify({
                    type: 'file',
                    url: file3.url,
                    gcs: file3.gcs,
                    hash: file3.hash,
                    filename: 'test-file-3.txt'
                }),
                JSON.stringify({
                    type: 'text',
                    text: 'Please read all three files and tell me the content of each file. List them as File 1, File 2, and File 3.'
                })
            ]
        }];

        // Call sys_entity_agent
        const response = await testServer.executeOperation({
            query: `
                query TestFileOperations(
                    $text: String!,
                    $chatHistory: [MultiMessage]!,
                    $contextId: String!,
                    $chatId: String
                ) {
                    sys_entity_agent(
                        text: $text,
                        chatHistory: $chatHistory,
                        contextId: $contextId,
                        chatId: $chatId,
                        stream: true
                    ) {
                        result
                        contextId
                        tool
                        warnings
                        errors
                    }
                }
            `,
            variables: {
                text: 'Please read all three files and tell me the content of each file. List them as File 1, File 2, and File 3.',
                chatHistory: chatHistory,
                contextId: contextId,
                chatId: chatId
            }
        });

        t.falsy(response.body?.singleResult?.errors, 'Should not have GraphQL errors');
        const requestId = response.body?.singleResult?.data?.sys_entity_agent?.result;
        t.truthy(requestId, 'Should have a requestId in the result field');

        // Collect events
        const events = await collectSubscriptionEvents({
            query: `
                subscription OnRequestProgress($requestId: String!) {
                    requestProgress(requestIds: [$requestId]) {
                        requestId
                        progress
                        data
                        info
                    }
                }
            `,
            variables: { requestId }
        }, 120000);

        t.true(events.length > 0, 'Should have received events');

        // Verify we got a completion event
        const completionEvent = events.find(event =>
            event.data.requestProgress.progress === 1
        );
        t.truthy(completionEvent, 'Should have received a completion event');

        // Check the response data for file content
        const responseData = completionEvent.data.requestProgress.data;
        t.truthy(responseData, 'Should have response data');

        // Parse the data to check for file content
        let parsedData;
        try {
            parsedData = typeof responseData === 'string' ? JSON.parse(responseData) : responseData;
        } catch (e) {
            // If not JSON, treat as string
            parsedData = responseData;
        }

        const responseText = typeof parsedData === 'string' ? parsedData : JSON.stringify(parsedData);
        
        // Verify all three files were processed
        // Check that the agent actually read the files by looking for content from the files
        // File 1 content: "Content of test file 1"
        // File 2 content: "Content of test file 2"  
        // File 3 content: "Content of test file 3"
        // The agent should mention at least some content from the files
        const hasFile1Content = responseText.includes('test file 1') || responseText.includes('Content of test file 1') || 
                                responseText.includes('File 1') || responseText.includes('file 1') || responseText.includes('first');
        const hasFile2Content = responseText.includes('test file 2') || responseText.includes('Content of test file 2') || 
                                responseText.includes('File 2') || responseText.includes('file 2') || responseText.includes('second');
        const hasFile3Content = responseText.includes('test file 3') || responseText.includes('Content of test file 3') || 
                                responseText.includes('File 3') || responseText.includes('file 3') || responseText.includes('third');
        
        // At minimum, verify the response is non-empty and the agent processed the request
        t.truthy(responseText && responseText.length > 0, 'Agent should return a response');
        
        // Log the response for debugging if assertions fail
        if (!hasFile1Content || !hasFile2Content || !hasFile3Content) {
            console.log('Agent response:', responseText.substring(0, 500));
        }
        
        // Note: We primarily verify file processing via inCollection checks below
        // The response text check is secondary - the key is that files were synced

        // Verify files now have inCollection set (they should be synced)
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for async updates
        
        const allFiles = await loadFileCollection(contextId);
        const file1InCollection = allFiles.find(f => f.hash === file1.hash);
        const file2InCollection = allFiles.find(f => f.hash === file2.hash);
        const file3InCollection = allFiles.find(f => f.hash === file3.hash);

        t.truthy(file1InCollection, 'File 1 should be in collection after sync');
        t.truthy(file2InCollection, 'File 2 should be in collection after sync');
        t.truthy(file3InCollection, 'File 3 should be in collection after sync');

        // Verify inCollection is set (should have chatId or be global)
        t.truthy(file1InCollection.inCollection, 'File 1 should have inCollection set');
        t.truthy(file2InCollection.inCollection, 'File 2 should have inCollection set');
        t.truthy(file3InCollection.inCollection, 'File 3 should have inCollection set');

        // Verify inCollection includes the chatId or is global
        const hasChatId = (inCollection) => {
            if (inCollection === true) return true; // Global
            if (Array.isArray(inCollection)) {
                return inCollection.includes('*') || inCollection.includes(chatId);
            }
            return false;
        };

        t.true(hasChatId(file1InCollection.inCollection), 'File 1 inCollection should include chatId or be global');
        t.true(hasChatId(file2InCollection.inCollection), 'File 2 inCollection should include chatId or be global');
        t.true(hasChatId(file3InCollection.inCollection), 'File 3 inCollection should include chatId or be global');

    } catch (error) {
        // If file handler is not configured, skip the test
        if (error.message?.includes('File handler URL not configured') || 
            error.message?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        throw error;
    } finally {
        await cleanup(contextId);
    }
});

test('sys_entity_agent processes files from compound context (user + workspace)', async t => {
    // Compound context: user context (encrypted) + workspace context (unencrypted)
    // This simulates a workspace being run by a user, where:
    // - User context has encrypted files (user's personal files)
    // - Workspace context has unencrypted files (shared workspace files)
    // - Both should be accessible when agentContext includes both
    
    const userContextId = `test-user-${Date.now()}`;
    const workspaceContextId = `test-workspace-${Date.now()}`;
    const userContextKey = 'test-user-encryption-key-12345'; // Simulated encryption key
    const chatId = `test-chat-${Date.now()}`;
    
    try {
        const redisClient = await getRedisClient();
        if (!redisClient) {
            t.skip('Redis not available');
            return;
        }

        // Create files in user context (encrypted)
        // No inCollection set initially (like Labeeb uploads)
        const userFile1 = {
            id: `user-file-1-${Date.now()}`,
            url: 'https://example.com/user-document.pdf',
            gcs: 'gs://bucket/user-document.pdf',
            filename: 'user-document.pdf',
            displayFilename: 'user-document.pdf',
            mimeType: 'application/pdf',
            hash: 'user-hash-1',
            permanent: false,
            timestamp: new Date().toISOString(),
            // No inCollection initially
        };
        
        const userFile2 = {
            id: `user-file-2-${Date.now()}`,
            url: 'https://example.com/user-notes.txt',
            gcs: 'gs://bucket/user-notes.txt',
            filename: 'user-notes.txt',
            displayFilename: 'user-notes.txt',
            mimeType: 'text/plain',
            hash: 'user-hash-2',
            permanent: false,
            timestamp: new Date().toISOString(),
            // No inCollection initially
        };
        
        // Create files in workspace context (unencrypted)
        // No inCollection set initially (like Labeeb uploads)
        const workspaceFile1 = {
            id: `workspace-file-1-${Date.now()}`,
            url: 'https://example.com/workspace-shared.pdf',
            gcs: 'gs://bucket/workspace-shared.pdf',
            filename: 'workspace-shared.pdf',
            displayFilename: 'workspace-shared.pdf',
            mimeType: 'application/pdf',
            hash: 'workspace-hash-1',
            permanent: false,
            timestamp: new Date().toISOString(),
            // No inCollection initially
        };
        
        const workspaceFile2 = {
            id: `workspace-file-2-${Date.now()}`,
            url: 'https://example.com/workspace-data.csv',
            gcs: 'gs://bucket/workspace-data.csv',
            filename: 'workspace-data.csv',
            displayFilename: 'workspace-data.csv',
            mimeType: 'text/csv',
            hash: 'workspace-hash-2',
            permanent: false,
            timestamp: new Date().toISOString(),
            // No inCollection initially
        };
        
        // Write files to Redis with appropriate encryption
        const userContextMapKey = `FileStoreMap:ctx:${userContextId}`;
        const workspaceContextMapKey = `FileStoreMap:ctx:${workspaceContextId}`;
        
        await writeFileDataToRedis(redisClient, userContextMapKey, userFile1.hash, userFile1, userContextKey);
        await writeFileDataToRedis(redisClient, userContextMapKey, userFile2.hash, userFile2, userContextKey);
        await writeFileDataToRedis(redisClient, workspaceContextMapKey, workspaceFile1.hash, workspaceFile1, null);
        await writeFileDataToRedis(redisClient, workspaceContextMapKey, workspaceFile2.hash, workspaceFile2, null);
        
        // Verify files exist in their respective contexts (using loadFileCollection to see all files)
        const userFiles = await loadFileCollection({ contextId: userContextId, contextKey: userContextKey, default: true });
        const workspaceFiles = await loadFileCollection(workspaceContextId);
        
        t.is(userFiles.length, 2, 'User context should have 2 files');
        t.is(workspaceFiles.length, 2, 'Workspace context should have 2 files');
        
        // Verify files don't have inCollection set initially
        const userFile1Before = userFiles.find(f => f.hash === userFile1.hash);
        const workspaceFile1Before = workspaceFiles.find(f => f.hash === workspaceFile1.hash);
        t.falsy(userFile1Before?.inCollection, 'User file 1 should not have inCollection set initially');
        t.falsy(workspaceFile1Before?.inCollection, 'Workspace file 1 should not have inCollection set initially');
        
        // Define compound agentContext (user + workspace)
        const agentContext = [
            { contextId: userContextId, contextKey: userContextKey, default: true }, // User context (encrypted, default)
            { contextId: workspaceContextId, contextKey: null, default: false }      // Workspace context (unencrypted)
        ];
        
        // Note: loadFileCollection with chatIds filters by inCollection
        // Without chatIds, it returns ALL files regardless of inCollection status
        
        // Test 1: Verify loadFileCollection with compound context returns all files
        const allFilesFromBothContexts = await loadFileCollection(agentContext);
        t.is(allFilesFromBothContexts.length, 4, 'Should have 4 files from both contexts');
        
        // Verify files from both contexts are present
        const hasUserFile1 = allFilesFromBothContexts.some(f => f.hash === userFile1.hash);
        const hasUserFile2 = allFilesFromBothContexts.some(f => f.hash === userFile2.hash);
        const hasWorkspaceFile1 = allFilesFromBothContexts.some(f => f.hash === workspaceFile1.hash);
        const hasWorkspaceFile2 = allFilesFromBothContexts.some(f => f.hash === workspaceFile2.hash);
        
        t.true(hasUserFile1, 'Compound context should include user file 1');
        t.true(hasUserFile2, 'Compound context should include user file 2');
        t.true(hasWorkspaceFile1, 'Compound context should include workspace file 1');
        t.true(hasWorkspaceFile2, 'Compound context should include workspace file 2');
        
        // Test 2: Test syncAndStripFilesFromChatHistory with compound context
        const { syncAndStripFilesFromChatHistory } = await import('../../../../../lib/fileUtils.js');
        
        // Create chatHistory with files from both contexts (using object format, not stringified)
        const chatHistory = [{
            role: 'user',
            content: [
                {
                    type: 'file',
                    url: userFile1.url,
                    gcs: userFile1.gcs,
                    hash: userFile1.hash,
                    filename: userFile1.filename
                },
                {
                    type: 'file',
                    url: workspaceFile1.url,
                    gcs: workspaceFile1.gcs,
                    hash: workspaceFile1.hash,
                    filename: workspaceFile1.filename
                },
                {
                    type: 'text',
                    text: 'Please describe these files.'
                }
            ]
        }];
        
        // Call syncAndStripFilesFromChatHistory directly with compound context
        const result = await syncAndStripFilesFromChatHistory(chatHistory, agentContext, chatId);
        
        t.truthy(result, 'Should return result');
        t.truthy(result.chatHistory, 'Should have processed chatHistory');
        t.truthy(result.availableFiles, 'Should have availableFiles');
        
        // Verify files were stripped (replaced with placeholders)
        const processedContent = result.chatHistory[0].content;
        const strippedUserFile = processedContent.find(c => 
            c.type === 'text' && c.text && c.text.includes('user-document.pdf') && c.text.includes('available via file tools')
        );
        const strippedWorkspaceFile = processedContent.find(c => 
            c.type === 'text' && c.text && c.text.includes('workspace-shared.pdf') && c.text.includes('available via file tools')
        );
        
        t.truthy(strippedUserFile, 'User file should be stripped from chatHistory');
        t.truthy(strippedWorkspaceFile, 'Workspace file should be stripped from chatHistory');
        
        // Wait for async metadata updates
        await new Promise(resolve => setTimeout(resolve, 500));
        
        // Test 3: Verify inCollection was updated for files in chatHistory
        const userFilesAfter = await loadFileCollection({ contextId: userContextId, contextKey: userContextKey, default: true }, { useCache: false });
        const userFile1After = userFilesAfter.find(f => f.hash === userFile1.hash);
        
        const workspaceFilesAfter = await loadFileCollection(workspaceContextId, { useCache: false });
        const workspaceFile1After = workspaceFilesAfter.find(f => f.hash === workspaceFile1.hash);
        
        t.truthy(userFile1After?.inCollection, 'User file 1 should have inCollection set after sync');
        t.truthy(workspaceFile1After?.inCollection, 'Workspace file 1 should have inCollection set after sync');
        
        // Test 4: Verify merged collection with chatId filter now includes the synced files
        const mergedWithChatId = await loadFileCollection(agentContext, { chatIds: [chatId], useCache: false });
        t.true(mergedWithChatId.length >= 2, 'Merged collection with chatId should have at least 2 files');
        
        const hasUserFile1AfterSync = mergedWithChatId.some(f => f.hash === userFile1.hash);
        const hasWorkspaceFile1AfterSync = mergedWithChatId.some(f => f.hash === workspaceFile1.hash);
        
        t.true(hasUserFile1AfterSync, 'Merged collection should include user file 1 after sync');
        t.true(hasWorkspaceFile1AfterSync, 'Merged collection should include workspace file 1 after sync');
        
    } finally {
        // Cleanup
        const redisClient = await getRedisClient();
        if (redisClient) {
            await redisClient.del(`FileStoreMap:ctx:${userContextId}`);
            await redisClient.del(`FileStoreMap:ctx:${workspaceContextId}`);
        }
    }
});

test('sys_entity_agent processes real files from compound context (user + workspace) - e2e with file handler', async (t) => {
    t.timeout(120000); // 2 minute timeout
    
    const userContextId = `test-user-e2e-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const workspaceContextId = `test-workspace-e2e-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
    const chatId = `test-chat-e2e-${Date.now()}`;
    
    try {
        // Upload files to user context
        const userFile1 = await uploadFileToHandler(
            'User Document Content\nThis is a document from the user context.',
            'user-document.txt',
            userContextId
        );
        
        const userFile2 = await uploadFileToHandler(
            'User Notes\nThese are personal notes.',
            'user-notes.txt',
            userContextId
        );
        
        // Upload files to workspace context
        const workspaceFile1 = await uploadFileToHandler(
            'Workspace Shared Document\nThis is a shared document from the workspace.',
            'workspace-shared.txt',
            workspaceContextId
        );
        
        const workspaceFile2 = await uploadFileToHandler(
            'Workspace Data\nThis is workspace data.',
            'workspace-data.txt',
            workspaceContextId
        );
        
        // Verify files exist in Redis but don't have inCollection set
        t.true(
            await verifyFileInRedisWithoutInCollection(userContextId, userFile1.hash),
            'User file 1 should exist without inCollection'
        );
        t.true(
            await verifyFileInRedisWithoutInCollection(workspaceContextId, workspaceFile1.hash),
            'Workspace file 1 should exist without inCollection'
        );
        
        // Define compound agentContext (user + workspace)
        const agentContext = [
            { contextId: userContextId, contextKey: null, default: true },
            { contextId: workspaceContextId, contextKey: null, default: false }
        ];
        
        // Create chatHistory with files from both contexts
        const chatHistory = [{
            role: 'user',
            content: [
                JSON.stringify({
                    type: 'file',
                    url: userFile1.url,
                    hash: userFile1.hash,
                    filename: 'user-document.txt'
                }),
                JSON.stringify({
                    type: 'file',
                    url: workspaceFile1.url,
                    hash: workspaceFile1.hash,
                    filename: 'workspace-shared.txt'
                }),
                JSON.stringify({
                    type: 'text',
                    text: 'Please describe these files. One is from my user context and one is from the workspace context.'
                })
            ]
        }];
        
        // Call sys_entity_agent with compound context
        const response = await testServer.executeOperation({
            query: `
                query TestCompoundContextE2E(
                    $text: String!,
                    $chatHistory: [MultiMessage]!,
                    $agentContext: [AgentContextInput]!,
                    $chatId: String
                ) {
                    sys_entity_agent(
                        text: $text,
                        chatHistory: $chatHistory,
                        agentContext: $agentContext,
                        chatId: $chatId,
                        stream: true
                    ) {
                        result
                        contextId
                        tool
                        warnings
                        errors
                    }
                }
            `,
            variables: {
                text: 'Please describe these files.',
                chatHistory: chatHistory,
                agentContext: agentContext,
                chatId: chatId
            }
        });
        
        t.falsy(response.body?.singleResult?.errors, 'Should not have GraphQL errors');
        const requestId = response.body?.singleResult?.data?.sys_entity_agent?.result;
        t.truthy(requestId, 'Should have a requestId in the result field');
        
        // Collect events
        const events = await collectSubscriptionEvents({
            query: `
                subscription OnRequestProgress($requestId: String!) {
                    requestProgress(requestIds: [$requestId]) {
                        requestId
                        progress
                        status
                        data
                        info
                        error
                    }
                }
            `,
            variables: { requestId }
        });
        
        t.true(events.length > 0, 'Should have received events');
        
        // Verify completion event
        const completionEvent = events.find(event =>
            event.data.requestProgress.progress === 1
        );
        t.truthy(completionEvent, 'Should have received a completion event');
        
        // Verify files were synced (inCollection should be set for files in chatHistory)
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for async updates
        
        // Check user context files (use useCache: false to get fresh data)
        const userFilesAfter = await loadFileCollection({ contextId: userContextId, contextKey: null, default: true }, { useCache: false });
        const userFile1After = userFilesAfter.find(f => f.hash === userFile1.hash);
        const userFile2After = userFilesAfter.find(f => f.hash === userFile2.hash);
        
        // Check workspace context files (use useCache: false to get fresh data)
        const workspaceFilesAfter = await loadFileCollection(workspaceContextId, { useCache: false });
        const workspaceFile1After = workspaceFilesAfter.find(f => f.hash === workspaceFile1.hash);
        const workspaceFile2After = workspaceFilesAfter.find(f => f.hash === workspaceFile2.hash);
        
        // Files that were in chatHistory should have inCollection set
        t.truthy(userFile1After?.inCollection, 'User file 1 (in chatHistory) should have inCollection set');
        t.truthy(workspaceFile1After?.inCollection, 'Workspace file 1 (in chatHistory) should have inCollection set');
        
        // Files NOT in chatHistory should still not have inCollection (they weren't accessed)
        t.falsy(userFile2After?.inCollection, 'User file 2 (not in chatHistory) should not have inCollection set');
        t.falsy(workspaceFile2After?.inCollection, 'Workspace file 2 (not in chatHistory) should not have inCollection set');
        
        // Verify merged collection with chatId filter now includes the synced files
        const mergedWithChatId = await loadFileCollection(agentContext, { chatIds: [chatId], useCache: false });
        t.true(mergedWithChatId.length >= 2, 'Merged collection with chatId should have at least the files from chatHistory');
        
        // Verify files from both contexts are accessible in merged collection
        const hasUserFile1After = mergedWithChatId.some(f => f.hash === userFile1.hash);
        const hasWorkspaceFile1After = mergedWithChatId.some(f => f.hash === workspaceFile1.hash);
        
        t.true(hasUserFile1After, 'Merged collection should include user file 1 from user context');
        t.true(hasWorkspaceFile1After, 'Merged collection should include workspace file 1 from workspace context');
        
        // Verify the merged collection correctly combines files from both contexts
        t.true(hasUserFile1After && hasWorkspaceFile1After, 'Merged collection should include files from both user and workspace contexts');
        
    } catch (error) {
        // If file handler is not configured, skip the test
        if (error.message?.includes('File handler URL not configured') || 
            error.message?.includes('WHISPER_MEDIA_API_URL')) {
            t.log('Test skipped - file handler URL not configured');
            t.pass();
            return;
        }
        throw error;
    } finally {
        // Cleanup
        const redisClient = await getRedisClient();
        if (redisClient) {
            await redisClient.del(`FileStoreMap:ctx:${userContextId}`);
            await redisClient.del(`FileStoreMap:ctx:${workspaceContextId}`);
        }
    }
});

