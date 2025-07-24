// Description: Translate text using AppTek's translation service

import logger from '../lib/logger.js';
const { callPathway } = await import('../lib/pathwayTools.js');

export default {
    inputParameters: {
        from: 'auto', // Source language, 'auto' for automatic detection
        to: 'en',     // Target language
        glossaryId: 'none', // Optional glossary ID
        fallbackPathway: 'translate_groq', // Fallback pathway to use if AppTek fails
    },
    model: 'apptek-translate',
    timeout: 120,
    
    executePathway: async ({args, runAllPrompts, resolver}) => {
        const pathwayResolver = resolver;
        
        try {
            // Execute the primary AppTek translation
            const result = await runAllPrompts(args);
            return result;
        } catch (error) {
            // If AppTek translation fails, use the configured fallback pathway
            const fallbackPathway = args.fallbackPathway || 'translate_groq';
            logger.warn(`AppTek translation failed: ${error.message}. Falling back to ${fallbackPathway}.`);
            
            try {
                // Call the fallback pathway
                const fallbackResult = await callPathway(fallbackPathway, { 
                    text: args.text, 
                    to: args.to || pathwayResolver.pathway.inputParameters.to,
                }, pathwayResolver);
                
                logger.verbose(`Successfully used ${fallbackPathway} as fallback`);
                return fallbackResult;
            } catch (fallbackError) {
                // If even the fallback fails, log it and rethrow the original error
                logger.error(`${fallbackPathway} fallback also failed: ${fallbackError.message}`);
                throw error; // Throw the original AppTek error, not the fallback error
            }
        }
    }
}
