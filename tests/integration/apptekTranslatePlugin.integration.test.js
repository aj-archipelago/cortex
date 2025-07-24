import test from 'ava';
import ApptekTranslatePlugin from '../../server/plugins/apptekTranslatePlugin.js';
import CortexRequest from '../../lib/cortexRequest.js';
import { createLimiter } from '../../lib/requestExecutor.js';
import RequestMonitor from '../../lib/requestMonitor.js';
import { Prompt } from '../../server/prompt.js';
// Skip tests if API credentials are not available
const skipIfNoCredentials = (t) => {
    if (!process.env.APPTEK_API_ENDPOINT || !process.env.APPTEK_API_KEY) {
        t.skip('AppTek API credentials not available. Set APPTEK_API_ENDPOINT and APPTEK_API_KEY environment variables.');
        return true;
    }
    return false;
};

// Mock model configuration
const mockModel = {
    name: 'apptek-translate',
    type: 'APPTEK-TRANSLATE',
    endpoints: [{
        name: 'apptek-translate',
        type: 'APPTEK-TRANSLATE',
        apiEndpoint: process.env.APPTEK_API_ENDPOINT,
        apiKey: process.env.APPTEK_API_KEY,
    }],
};

createLimiter(mockModel.endpoints[0], 'apptek-translate', 0);
mockModel.endpoints[0].monitor = new RequestMonitor();


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
        if (skipIfNoCredentials(t)) return;

        // Create pathway configuration
        const pathway = {
            name: 'translate_apptek',
            model: 'apptek-translate',
            prompt: new Prompt('{{text}}'),
            timeout: 1000000
        };

        // Create plugin instance
        const plugin = new ApptekTranslatePlugin(pathway, mockModel);
        
        // Set up parameters
        const parameters = {
            from: testCase.from,
            to: testCase.to
        };
        
        try {

            const cortexRequest = new CortexRequest({pathwayResolver: {
                requestId: 'test-request-id', 
                pathway: pathway,
                model: mockModel
            }});
            const result = await plugin.execute(testCase.text, parameters, pathway.prompt, cortexRequest);
            
            // Verify the result is a string
            t.is(typeof result, 'string', 'Result should be a string');
            
            // Verify the result is not empty
            t.true(result.length > 0, 'Result should not be empty');
            
            // Log the translation for manual verification
            console.log(`\n${testCase.name}:`);
            console.log(`Source (${testCase.from}): ${testCase.text}`);
            console.log(`Target (${testCase.to}): ${result}`);
            
        } catch (error) {
            t.fail(`Translation failed: ${error.message}`);
        }
    });
});


// Test language detection
test.serial('AppTek Plugin: Language Detection', async (t) => {
    if (skipIfNoCredentials(t)) return;

    const pathway = { name: 'translate_apptek', model: 'apptek-translate' };
    const plugin = new ApptekTranslatePlugin(pathway, mockModel);

    const testTexts = [
        { text: 'Hello world', expectedLang: 'en' },
        { text: 'Hola mundo', expectedLang: 'es' },
        { text: 'مرحبا بالعالم', expectedLang: 'ar' }
    ];

    for (const testText of testTexts) {
        try {
            const detectedLang = await plugin.detectLanguage(testText.text);
            
            t.is(typeof detectedLang, 'string', 'Detected language should be a string');
            t.true(detectedLang.length > 0, 'Detected language should not be empty');
            
            console.log(`\nLanguage Detection:`);
            console.log(`Text: ${testText.text}`);
            console.log(`Detected: ${detectedLang}`);
            console.log(`Expected: ${testText.expectedLang}`);
            
        } catch (error) {
            t.fail(`Language detection failed: ${error.message}`);
        }
    }
});