// sys_tool_mermaid.js
// Entity tool that provides advanced mermaid charting capabilities

import { Prompt } from '../../../../server/prompt.js';
import { validateMermaid, isValidMermaid, getDiagramType } from '@aj-archipelago/merval';
import logger from '../../../../lib/logger.js';

// Function to validate mermaid syntax using our lightweight validator
function validateMermaidSyntax(mermaidCode) {
    try {
        // Ensure mermaidCode is a string
        const codeStr = typeof mermaidCode === 'string' ? mermaidCode : String(mermaidCode);
        
        // Extract mermaid code from markdown block if present
        const mermaidMatch = codeStr.match(/```mermaid\s*([\s\S]*?)\s*```/);
        const codeToValidate = mermaidMatch ? mermaidMatch[1].trim() : codeStr.trim();
        
        if (!codeToValidate) {
            return { isValid: false, error: "Empty mermaid code", diagramType: 'unknown' };
        }
        
        // Use our lightweight validator
        const result = validateMermaid(codeToValidate);
        
        return {
            isValid: result.isValid,
            error: result.isValid ? null : result.errors,
            diagramType: result.diagramType,
            ast: result.ast
        };
    } catch (error) {
        return { 
            isValid: false, 
            error: `Validation error: ${error.message}`, 
            diagramType: 'unknown' 
        };
    }
}

// Function to extract mermaid code from response
function extractMermaidFromResponse(response) {
    // Ensure response is a string
    const responseStr = typeof response === 'string' ? response : String(response);
    const mermaidMatch = responseStr.match(/```mermaid\s*([\s\S]*?)\s*```/);
    return mermaidMatch ? mermaidMatch[1].trim() : null;
}

// Function to format validation errors for detailed feedback
function formatValidationErrors(errors) {
    if (!errors || !Array.isArray(errors)) {
        return 'Unknown validation error';
    }
    
    return errors.map(error => {
        let errorText = `Line ${error.line}, Column ${error.column}: ${error.message}`;
        if (error.code) {
            errorText += ` (Error Code: ${error.code})`;
        }
        if (error.suggestion) {
            errorText += `\nSuggestion: ${error.suggestion}`;
        }
        return errorText;
    }).join('\n\n');
}

export default {
    prompt: [], // Prompts are set dynamically in executePathway
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        aiName: "Jarvis",
        language: "English",
    },
    model: 'oai-gpt5-chat',
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 600,
    toolDefinition: [{
        type: "function",
        icon: "📊",
        function: {
            name: "CreateChart",
            description: "Creates a single chart or diagram that will render in the UI to visualize data or concepts. You can create all the standard Mermaid chart types (flowcharts, sequence diagrams, gantt charts, etc.) as well as bar charts and line and scatter plots. This tool also validates the syntax and ensures proper formatting. Call this tool any time you need to create a chart outside of your coding agent. If you need to create multiple charts, you can call this tool multiple times in parallel to create multiple charts.",
            parameters: {
                type: "object",
                properties: {
                    detailedInstructions: {
                        type: "string",
                        description: "Detailed instructions about what you need the tool to do"
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    }
                },
                required: ["detailedInstructions", "userMessage"]
            }
        }
    }],
    
    executePathway: async ({args, runAllPrompts, resolver}) => {
        if (args.detailedInstructions) {
            args.chatHistory.push({role: "user", content: args.detailedInstructions});
        }
        
        const maxRetries = 10;
        let attempts = 0;
        let lastError = null;
        let lastMermaidCode = null;
        let pathwayResolver = resolver;
        
        while (attempts < maxRetries) {
            attempts++;
            
            try {
                let result;
                
                if (attempts === 1) {
                    // First attempt: use full chat history for context
                    // Set the initial prompt with full chat history
                    pathwayResolver.pathwayPrompt = [
                        new Prompt({ messages: [
                            {"role": "system", "content":`You are the part of an AI entity named {{aiName}} that creates mermaid charts. Follow the user's detailed instructions and create a mermaid chart that meets the user's needs.

Mermaid Charts Instructions:

You are using Mermaid 11.6 with the xychart-beta extension, so you can write all standard Mermaid chart types in a markdown block (flowcharts, sequence diagrams, etc.) as well as bar charts and line charts using the xychart-beta extension.

Here is some example code of the xychart-beta extension that combines both bar and line functions:

\`\`\`mermaid
xychart-beta
    title "Sales Revenue"
    x-axis [jan, feb, mar, apr, may, jun, jul, aug, sep, oct, nov, dec]
    y-axis "Revenue (in $)" 4000 --> 11000
    bar [5000, 6000, 7500, 8200, 9500, 10500, 11000, 10200, 9200, 8500, 7000, 6000]
    line [5000, 6000, 7500, 8200, 9500, 10500, 11000, 10200, 9200, 8500, 7000, 6000]
\`\`\`

Mermaid is very sensitive to syntax error, so carefully consider your syntax before producing mermaid code.

- All [] labels must be either quoted strings OR otherwise HTML-safe (no raw \\n or other special characters - this is the most common parsing issue - wonky labels)
- No strings (e.g. null) in number series data
- Every subgraph has a matching end
- No lone arrows
- Use comments (%%) instead of stray text lines for any text that is not part of the mermaid code

Return only the mermaid chart markdown block with no other notes or comments.

{{renderTemplate AI_DATETIME}}`},
                            "{{chatHistory}}"
                        ]})
                    ];
                    
                    result = await runAllPrompts({ ...args, stream: false });
                } else {
                    // Retry attempts: use streamlined prompt with just the error and code
                    pathwayResolver.pathwayPrompt = [
                        new Prompt({ messages: [
                            {"role": "system", "content":`You are fixing a mermaid chart syntax error. The previous attempt generated invalid mermaid code. Please fix the syntax errors and regenerate the chart.

The error details below include line numbers, column positions, error codes, and suggestions. Use this information to precisely locate and fix the syntax issues.

Focus only on fixing the syntax issues mentioned in the error details. Return only the corrected mermaid chart in markdown block format with no other comments.

{{renderTemplate AI_DATETIME}}`},
                            {"role": "user", "content": `Here is the mermaid code that was generated:\n\n\`\`\`mermaid\n${lastMermaidCode || ''}\n\`\`\`\n\nAnd here are the detailed error messages:\n\n${lastError || 'Unknown error'}\n\nPlease fix the syntax errors and regenerate the chart.`}
                        ]})
                    ];
                    
                    result = await runAllPrompts({ ...args, stream: false });
                }
                
                // Extract mermaid code from the response
                const mermaidCode = extractMermaidFromResponse(result);
                
                if (mermaidCode) {
                    // Store the mermaid code for potential retry
                    lastMermaidCode = mermaidCode;
                    
                    // Validate the mermaid chart using our lightweight validator
                    const validation = validateMermaidSyntax(mermaidCode);
                    
                    if (validation.isValid) {
                        resolver.tool = JSON.stringify({ 
                            toolUsed: "CreateMermaidChart", 
                            diagramType: validation.diagramType,
                            attempts: attempts,
                            validationPassed: true
                        });
                        
                        // Return the validated mermaid chart
                        return result;
                    } else {
                        const formattedErrors = formatValidationErrors(validation.error);
                        logger.warn(`Mermaid chart has syntax errors: ${formattedErrors}`);
                        lastError = formattedErrors;
                        
                        if (attempts < maxRetries) {
                            continue; // Retry with streamlined prompt
                        }
                    }
                } else {
                    // No mermaid code found in response
                    lastError = "No mermaid chart found in response";
                    
                    if (attempts < maxRetries) {
                        // For retry, we'll use the streamlined prompt with the error message
                        continue;
                    }
                }
            } catch (error) {
                lastError = error.message;
                if (attempts < maxRetries) {
                    continue; // Retry with streamlined prompt
                }
            }
        }
        
        // If we've exhausted all retries, return the last result with error info
        resolver.tool = JSON.stringify({ 
            toolUsed: "CreateMermaidChart", 
            error: lastError,
            attempts: attempts,
            validationFailed: true
        });
        
        // Return a fallback response
        return `Failed to generate valid mermaid chart after ${maxRetries} attempts. Last error: ${lastError}`;
    }
} 