// sys_tool_validate_url.js
// Tool pathway that validates URLs by performing HEAD requests to check if they are accessible
import logger from '../../../../lib/logger.js';

export default {
    prompt: [],
    timeout: 30,
    toolDefinition: { 
        type: "function",
        icon: "🔗",
        function: {
            name: "ValidateUrl",
            description: "This tool validates URLs by performing a HEAD request to check if they are accessible and return valid responses. Use this to verify that links and image URLs are valid before including them in responses.",
            parameters: {
                type: "object",
                properties: {
                    url: {
                        type: "string",
                        description: "The URL to validate (can be a link or image URL)"
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    }
                },
                required: ["url", "userMessage"]
            }
        }
    },

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const { url } = args;
        
        if (!url || typeof url !== 'string') {
            throw new Error("URL parameter is required and must be a string");
        }

        // Basic URL format validation
        try {
            new URL(url);
        } catch (e) {
            return JSON.stringify({
                valid: false,
                error: "Invalid URL format",
                url: url,
                statusCode: null,
                contentType: null
            });
        }

        try {
            // Perform HEAD request to validate the URL
            // Use a timeout to avoid hanging on slow/unresponsive servers
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 2000); // 2 second timeout for HEAD

            let response;
            try {
                response = await fetch(url, {
                    method: 'HEAD',
                    signal: controller.signal,
                    redirect: 'follow',
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (compatible; Cortex/1.0)'
                    }
                });
                clearTimeout(timeoutId);
            } catch (fetchError) {
                clearTimeout(timeoutId);
                
                // If HEAD fails, try GET with range request (more compatible)
                if (fetchError.name === 'AbortError') {
                    throw new Error("Request timeout - URL did not respond in time");
                }
                
                // Some servers don't support HEAD, try GET with range
                try {
                    const getController = new AbortController();
                    const getTimeoutId = setTimeout(() => getController.abort(), 25000);
                    
                    response = await fetch(url, {
                        method: 'GET',
                        signal: getController.signal,
                        redirect: 'follow',
                        headers: {
                            'User-Agent': 'Mozilla/5.0 (compatible; Cortex/1.0)',
                            'Range': 'bytes=0-0' // Only request first byte to minimize data transfer
                        }
                    });
                    clearTimeout(getTimeoutId);
                } catch (getError) {
                    if (getError.name === 'AbortError') {
                        throw new Error("Request timeout - URL did not respond in time");
                    }
                    throw getError;
                }
            }

            const statusCode = response.status;
            const contentType = response.headers.get('content-type') || '';
            const contentLength = response.headers.get('content-length');
            const finalUrl = response.url || url; // Get final URL after redirects

            // Consider 2xx and 3xx status codes as valid
            const isValid = statusCode >= 200 && statusCode < 400;

            const result = {
                valid: isValid,
                url: finalUrl,
                statusCode: statusCode,
                contentType: contentType,
                contentLength: contentLength ? parseInt(contentLength, 10) : null,
                message: isValid 
                    ? `URL is valid and accessible (HTTP ${statusCode})`
                    : `URL returned error status (HTTP ${statusCode})`
            };

            resolver.tool = JSON.stringify({ toolUsed: "ValidateUrl" });
            return JSON.stringify(result);

        } catch (e) {
            logger.error(`Error validating URL ${url}: ${e.message}`);
            
            const errorResult = {
                valid: false,
                url: url,
                statusCode: null,
                contentType: null,
                error: e.message || "Unknown error occurred while validating URL"
            };

            resolver.tool = JSON.stringify({ toolUsed: "ValidateUrl" });
            return JSON.stringify(errorResult);
        }
    }
};

