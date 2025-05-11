import { callPathway } from '../../../../../lib/pathwayTools.js';
import { encode } from '../../../../../lib/encodeCache.js';
import { getUniqueId } from '../../../../../lib/util.js';
import logger from '../../../../../lib/logger.js';

const normalizeMemoryFormat = async (args, content) => {
    if (!content) return '';

    const lines = content.split('\n').map(line => line.trim()).filter(line => line);
    const validLines = [];
    const invalidLines = [];

    // Check each line for proper format (priority|timestamp|content)
    for (const line of lines) {
        const parts = line.split('|');
        const isValid = parts.length >= 3 && 
                       /^\d+$/.test(parts[0]) && 
                       /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(parts[1]);

        if (isValid) {
            validLines.push(line);
        } else {
            invalidLines.push(line);
        }
    }

    // If we have invalid lines, format them
    let formattedContent = validLines;
    if (invalidLines.length > 0) {
        const invalidBlock = invalidLines.join('\n');
        try {
            const formattedBlock = await callPathway("sys_memory_format", { ...args, text: invalidBlock });
            if (formattedBlock) {
                formattedContent = [...validLines, ...formattedBlock.split('\n')];
            }
        } catch (error) {
            logger.warn('Error formatting invalid memory lines:', error);
        }
    }

    // Sort all lines by date descending
    return formattedContent
        .filter(line => line.trim())
        .sort((a, b) => {
            const [, timestampA] = a.split('|');
            const [, timestampB] = b.split('|');
            return new Date(timestampB) - new Date(timestampA);
        })
        .join('\n');
};

const enforceTokenLimit = (text, maxTokens = 1000, isTopicsSection = false) => {
    if (!text) return text;
    
    // Parse lines and remove duplicates
    const seen = new Map();
    const lines = text.split('\n')
        .map(line => line.trim())
        .filter(line => line)
        .map(line => {
            const [priority, timestamp, ...contentParts] = line.split('|');
            return {
                line,
                priority: parseInt(priority || '3'),
                timestamp: timestamp || new Date(0).toISOString(),
                content: contentParts.join('|')
            };
        });

    // Filter duplicates first
    const uniqueLines = lines.reduce((acc, item) => {
        const existing = seen.get(item.content);
        if (!existing) {
            seen.set(item.content, item);
            acc.push(item);
        } else if (isTopicsSection && item.timestamp > existing.timestamp) {
            // For topics, keep newest timestamp
            const index = acc.findIndex(x => x.content === item.content);
            acc[index] = item;
            seen.set(item.content, item);
        } else if (!isTopicsSection && item.priority < existing.priority) {
            // For non-topics, keep highest priority
            const index = acc.findIndex(x => x.content === item.content);
            acc[index] = item;
            seen.set(item.content, item);
        }
        return acc;
    }, []);

    // Sort by timestamp (topics) or priority
    uniqueLines.sort((a, b) => isTopicsSection ? 
        b.timestamp.localeCompare(a.timestamp) : 
        a.priority - b.priority
    );

    // First trim by character estimation (4 chars ≈ 1 token)
    let result = uniqueLines;
    let estimatedTokens = result.reduce((sum, item) => sum + Math.ceil(item.content.length / 4), 0);
    
    while (estimatedTokens > maxTokens && result.length > 0) {
        result = result.slice(0, -1);
        estimatedTokens = result.reduce((sum, item) => sum + Math.ceil(item.content.length / 4), 0);
    }

    // Final trim using actual token count
    let finalText = result.map(x => x.line).join('\n');
    while (encode(finalText).length > maxTokens && result.length > 0) {
        result = result.slice(0, -1);
        finalText = result.map(x => x.line).join('\n');
    }

    return finalText;
};

const addToolCalls = (chatHistory, toolArgs, toolName, toolCallId = getUniqueId()) => {
    const toolCall = {
        "role": "assistant",
        "tool_calls": [
            {
                "id": toolCallId,
                "type": "function",
                "function": {
                    "arguments": JSON.stringify(toolArgs),
                    "name": toolName
                }
            }
        ]
    };
    chatHistory.push(toolCall);
    return { chatHistory, toolCallId };
};

const addToolResults = (chatHistory, result, toolCallId) => {
    const toolResult = {
        "role": "tool",
        "content": typeof result === 'string' ? result : JSON.stringify(result),
        "tool_call_id": toolCallId
    };
    chatHistory.push(toolResult);
    return { chatHistory, toolCallId };
};

const insertToolCallAndResults = (chatHistory, toolArgs, toolName, result = null, toolCallId = getUniqueId()) => {
    const lastMessage = chatHistory.length > 0 ? chatHistory.pop() : null;
    addToolCalls(chatHistory, toolArgs, toolName, toolCallId);
    addToolResults(chatHistory, result, toolCallId);
    chatHistory.push(lastMessage);
    return { chatHistory, toolCallId };
};

const modifyText = (text, modifications) => {
    let modifiedText = text || '';
  
    modifications.forEach((mod, index) => {
        logger.debug(`Processing modification ${index + 1}: ${JSON.stringify(mod)}`);
        
        // Skip invalid modifications
        if (!mod.type) {
            logger.warn('Modification missing type');
            return;
        }
        if ((mod.type === 'delete' || mod.type === 'change') && !mod.pattern) {
            logger.warn(`${mod.type} modification missing pattern`);
            return;
        }
        if ((mod.type === 'add' || mod.type === 'change') && !mod.newtext) {
            logger.warn(`${mod.type} modification missing newtext`);
            return;
        }

        // Create timestamp in GMT
        const timestamp = new Date().toISOString();
        
        switch (mod.type) {
            case 'add':
                const priority = mod.priority || '3';
                const newLine = `${priority}|${timestamp}|${mod.newtext}`;
                logger.debug(`Adding new line: ${newLine}`);
                modifiedText = modifiedText + (modifiedText ? '\n' : '') + newLine;
                break;
            case 'change':
                // Split into lines
                const lines = modifiedText.split('\n');
                modifiedText = lines.map(line => {
                    const parts = line.split('|');
                    const priority = parts[0];
                    const content = parts.slice(2).join('|');
                    
                    if (content) {
                        try {
                            const trimmedContent = content.trim();
                            const regex = new RegExp(mod.pattern, 'i');
                            
                            // Try exact match first
                            if (regex.test(trimmedContent)) {
                                const newPriority = mod.priority || priority || '3';
                                // Try to extract capture groups if they exist
                                const match = trimmedContent.match(regex);
                                let newContent = mod.newtext;
                                if (match && match.length > 1) {
                                    // Replace $1, $2, etc with capture group values
                                    newContent = mod.newtext.replace(/\$(\d+)/g, (_, n) => match[n] || '');
                                }
                                const newLine = `${newPriority}|${timestamp}|${newContent}`;
                                logger.debug(`Changing line: ${line} to ${newLine}`);
                                return newLine;
                            }
                        } catch (e) {
                            logger.warn(`Invalid regex pattern: ${mod.pattern}`);
                        }
                    }
                    return line;
                }).join('\n');
                break;
            case 'delete':
                // Split into lines, filter out matching lines, and rejoin
                const beforeDelete = modifiedText;
                modifiedText = modifiedText
                    .split('\n')
                    .filter(line => {
                        const parts = line.split('|');
                        const content = parts.slice(2).join('|');
                        if (!content) return true;
                        try {
                            const regex = new RegExp(mod.pattern, 'i');
                            const shouldKeep = !regex.test(content.trim());
                            if (!shouldKeep) {
                                logger.debug(`Deleting line: ${line}`);
                            }
                            return shouldKeep;
                        } catch (e) {
                            logger.warn(`Invalid regex pattern: ${mod.pattern}`);
                            return true;
                        }
                    })
                    .filter(line => line.trim())
                    .join('\n');
                if (beforeDelete !== modifiedText) {
                    logger.debug(`Text after deletion: ${modifiedText}`);
                }
                break;
            default:
                logger.warn(`Unknown modification type: ${mod.type}`);
        }
    });
  
    return modifiedText;
};

export { normalizeMemoryFormat, enforceTokenLimit, addToolCalls, addToolResults, modifyText, insertToolCallAndResults };
