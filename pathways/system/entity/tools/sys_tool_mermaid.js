// sys_tool_mermaid.js
// Entity tool that provides advanced mermaid charting capabilities

import { Prompt } from '../../../../server/prompt.js';

export default {
    prompt:
        [
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

Mermaid is very sensitive to syntax errors, so make sure you check your chart definitions before finalizing your response.  Some things to check for:

- All [] labels must be either quoted strings OR HTML-safe (no raw \\n or other special characters)
- No strings (e.g. null) in number series data
- Every subgraph has a matching end
- No lone arrows
- Use comments (%%) instead of stray text lines

Return only the mermaid chart markdown block and separate markdown for the chart key if necessary, with no other notes or comments.

{{renderTemplate AI_DATETIME}}`},
                "{{chatHistory}}"
            ]}),
        ],
    inputParameters: {
        chatHistory: [{role: '', content: []}],
        contextId: ``,
        aiName: "Jarvis",
        language: "English",
    },
    model: 'oai-gpt41',
    useInputChunking: false,
    enableDuplicateRequests: false,
    timeout: 600,
    toolDefinition: [{
        type: "function",
        icon: "📊",
        function: {
            name: "CreateMermaidChart",
            description: "Creates a Mermaid chart in markdown format to visualize data or concepts. Call this tool any time you need to create a Mermaid chart as it will ensure that the chart is properly formatted and syntax-checked.",
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
        let result = await runAllPrompts({ ...args, stream: false });        
        resolver.tool = JSON.stringify({ toolUsed: "coding" });          
        return result;
    }
} 