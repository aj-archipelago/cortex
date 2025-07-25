import test from 'ava';
import serverFactory from '../../index.js';

let testServer;

test.before(async () => {
  const { server, startServer } = await serverFactory();
  startServer && await startServer();
  testServer = server;
});

test.after.always('cleanup', async () => {
  if (testServer) {
    await testServer.stop();
  }
});

// Test data for different languages
const testCases = [
    {
        name: 'English to Spanish',
        text: 'Hello, how are you today?',
        from: 'en',
        to: 'es'
    },
    {
        name: 'Spanish to English', 
        text: 'Hola, ¿cómo estás hoy?',
        from: 'es',
        to: 'en'
    },
    {
        name: 'Arabic to English',
        text: 'مرحبا، كيف حالك اليوم؟',
        from: 'ar',
        to: 'en'
    },
    {
        name: 'English to Arabic',
        text: 'Hello, how are you today?',
        from: 'en', 
        to: 'ar'
    },
    {
        name: 'Auto-detect English to Spanish',
        text: 'Good morning, have a great day!',
        from: 'auto',
        to: 'es'
    },
    {
        name: 'Auto-detect Spanish to English',
        text: 'Buenos días, que tengas un buen día!',
        from: 'auto',
        to: 'en'
    },
    {
        name: 'Auto-detect Arabic to English',
        text: 'صباح الخير، أتمنى لك يوماً سعيداً!',
        from: 'auto',
        to: 'en'
    }
];

// Direct AppTek plugin tests
testCases.forEach((testCase) => {
    test.serial(`AppTek Plugin: ${testCase.name}`, async (t) => {
        const response = await testServer.executeOperation({
            query: 'query translate_apptek($text: String!, $from: String, $to: String) { translate_apptek(text: $text, from: $from, to: $to) { result } }',
            variables: {
                text: testCase.text,
                from: testCase.from,
                to: testCase.to
            }
        });
        
        t.is(response.body?.singleResult?.errors, undefined);
        const result = response.body?.singleResult?.data?.translate_apptek?.result;
        
        // Verify the result is a string
        t.is(typeof result, 'string', 'Result should be a string');
        
        // Verify the result is not empty
        t.true(result.length > 0, 'Result should not be empty');
        
        // Log the translation for manual verification
        console.log(`\n${testCase.name}:`);
        console.log(`Source (${testCase.from}): ${testCase.text}`);
        console.log(`Target (${testCase.to}): ${result}`);
    });
});

// Test AppTek failure with GPT-4 Omni fallback
test.serial('AppTek Plugin: Force failure and test GPT-4 Omni fallback', async (t) => {
    // Store original environment variables
    const originalEndpoint = process.env.APPTEK_API_ENDPOINT;
    const originalApiKey = process.env.APPTEK_API_KEY;
    
    try {
        // Force AppTek to fail by setting invalid endpoint
        process.env.APPTEK_API_ENDPOINT = 'https://invalid-apptek-endpoint-that-will-fail.com';
        process.env.APPTEK_API_KEY = 'invalid-api-key';
        
        const testText = 'Hello, this is a test for fallback translation.';
        
        const response = await testServer.executeOperation({
            query: `
                query translate_apptek_with_fallback($text: String!, $from: String, $to: String, $fallbackPathway: String) { 
                    translate_apptek(text: $text, from: $from, to: $to, fallbackPathway: $fallbackPathway) { 
                        result 
                    } 
                }
            `,
            variables: {
                text: testText,
                from: 'en',
                to: 'es',
                fallbackPathway: 'translate_gpt4_omni'
            }
        });
        
        // Check for errors in the response
        t.is(response.body?.singleResult?.errors, undefined, 'Should not have GraphQL errors');
        
        const result = response.body?.singleResult?.data?.translate_apptek?.result;
        
        // Verify the result is a string
        t.is(typeof result, 'string', 'Result should be a string');
        
        // Verify the result is not empty
        t.true(result.length > 0, 'Result should not be empty');
        
        // Verify it's not the original text (translation should have occurred)
        t.not(result, testText, 'Result should be translated, not the original text');
        
        // Log the fallback translation for manual verification
        console.log('\nAppTek Failure with GPT-4 Omni Fallback:');
        console.log(`Source (en): ${testText}`);
        console.log(`Target (es): ${result}`);
        console.log('✅ AppTek failed as expected and GPT-4 Omni fallback worked!');
        
    } finally {
        // Restore original environment variables
        if (originalEndpoint) {
            process.env.APPTEK_API_ENDPOINT = originalEndpoint;
        } else {
            delete process.env.APPTEK_API_ENDPOINT;
        }
        
        if (originalApiKey) {
            process.env.APPTEK_API_KEY = originalApiKey;
        } else {
            delete process.env.APPTEK_API_KEY;
        }
    }
});

// Test AppTek failure with default fallback (translate_groq)
test.skip('AppTek Plugin: Force failure and test default fallback', async (t) => {
    // Set a longer timeout for this test since Groq might be slower
    t.timeout(180000); // 3 minutes
    
    // Store original environment variables
    const originalEndpoint = process.env.APPTEK_API_ENDPOINT;
    const originalApiKey = process.env.APPTEK_API_KEY;
    
    try {
        // Force AppTek to fail by setting invalid endpoint
        process.env.APPTEK_API_ENDPOINT = 'https://invalid-apptek-endpoint-that-will-fail.com';
        process.env.APPTEK_API_KEY = 'invalid-api-key';
        
        const testText = 'Hello, this is a test for default fallback translation.';
        
        const response = await testServer.executeOperation({
            query: `
                query translate_apptek_default_fallback($text: String!, $from: String, $to: String) { 
                    translate_apptek(text: $text, from: $from, to: $to) { 
                        result 
                    } 
                }
            `,
            variables: {
                text: testText,
                from: 'en',
                to: 'fr'
            }
        });
        
        // Check for errors in the response
        t.is(response.body?.singleResult?.errors, undefined, 'Should not have GraphQL errors');
        
        const result = response.body?.singleResult?.data?.translate_apptek?.result;
        
        // Verify the result is a string
        t.is(typeof result, 'string', 'Result should be a string');
        
        // Verify the result is not empty
        t.true(result.length > 0, 'Result should not be empty');
        
        // Verify it's not the original text (translation should have occurred)
        t.not(result, testText, 'Result should be translated, not the original text');
        
        // Log the fallback translation for manual verification
        console.log('\nAppTek Failure with Default Fallback:');
        console.log(`Source (en): ${testText}`);
        console.log(`Target (fr): ${result}`);
        console.log('✅ AppTek failed as expected and default fallback worked!');
        
    } finally {
        // Restore original environment variables
        if (originalEndpoint) {
            process.env.APPTEK_API_ENDPOINT = originalEndpoint;
        } else {
            delete process.env.APPTEK_API_ENDPOINT;
        }
        
        if (originalApiKey) {
            process.env.APPTEK_API_KEY = originalApiKey;
        } else {
            delete process.env.APPTEK_API_KEY;
        }
    }
});