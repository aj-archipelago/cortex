// executeWorkspace.js
// Handles the executeWorkspace GraphQL query resolver and related functionality
//
// This module contains the implementation of the executeWorkspace resolver, which is responsible
// for executing user-defined pathways (workspaces) with various execution modes:
// - Sequential execution of all prompts (default)
// - Parallel execution of specific named prompts
// - Parallel execution of all prompts (wildcard mode)
//
// The resolver supports both legacy pathway formats and new dynamic pathways with cortexPathwayName.

import { v4 as uuidv4 } from 'uuid';
import logger from '../lib/logger.js';
import { callPathway } from '../lib/pathwayTools.js';
import { getPathwayTypeDef, userPathwayInputParameters } from './typeDef.js';

// Helper function to resolve file hashes and add them to chatHistory
const resolveAndAddFileContent = async (pathways, pathwayArgs, requestId, config) => {
    let fileContentAdded = false;
    
    // Check if any pathway has file hashes
    const pathwaysWithFiles = Array.isArray(pathways) ? pathways : [pathways];
    
    for (const pathway of pathwaysWithFiles) {
        if (pathway.fileHashes && pathway.fileHashes.length > 0) {
            try {
                const { resolveFileHashesToContent } = await import('../lib/fileUtils.js');
                const fileContent = await resolveFileHashesToContent(pathway.fileHashes, config, pathwayArgs?.contextId || null);
                
                // Add file content to chatHistory if not already present (only do this once)
                if (!fileContentAdded) {
                    // Initialize chatHistory if it doesn't exist
                    if (!pathwayArgs.chatHistory) {
                        pathwayArgs.chatHistory = [];
                    }
                    
                    // Find the last user message or create one
                    let lastUserMessage = null;
                    for (let i = pathwayArgs.chatHistory.length - 1; i >= 0; i--) {
                        if (pathwayArgs.chatHistory[i].role === 'user') {
                            lastUserMessage = pathwayArgs.chatHistory[i];
                            break;
                        }
                    }
                    
                    if (!lastUserMessage) {
                        lastUserMessage = {
                            role: 'user',
                            content: []
                        };
                        pathwayArgs.chatHistory.push(lastUserMessage);
                    }
                    
                    // Ensure content is an array
                    if (!Array.isArray(lastUserMessage.content)) {
                        lastUserMessage.content = [
                            JSON.stringify({
                                type: "text",
                                text: lastUserMessage.content || ""
                            })
                        ];
                    }
                    
                    // Add file content
                    lastUserMessage.content.push(...fileContent);
                    fileContentAdded = true;
                }
            } catch (error) {
                logger.error(`[${requestId}] Failed to resolve file hashes for pathway ${pathway.name || 'unnamed'}: ${error.message}`);
                // Continue execution without files
            }
            
            // Only process files once for multiple pathways
            if (fileContentAdded) break;
        }
    }
    
    return fileContentAdded;
};

// Helper function to execute pathway with cortex pathway name or fallback to legacy
const executePathwayWithFallback = async (pathway, pathwayArgs, contextValue, info, requestId, originalPrompt = null, config) => {
    const cortexPathwayName = (originalPrompt && typeof originalPrompt === 'object' && originalPrompt.cortexPathwayName) 
        ? originalPrompt.cortexPathwayName 
        : null;
    
    if (cortexPathwayName) {
        // Use the specific cortex pathway
        // Transform parameters for cortex pathway
        const cortexArgs = {
            model: pathway.model || pathwayArgs.model || "labeeb-agent", // Use pathway model or default
            chatHistory: [],
            systemPrompt: pathway.systemPrompt
        };
        
        // If we have existing chatHistory, use it as base
        if (pathwayArgs.chatHistory && pathwayArgs.chatHistory.length > 0) {
            cortexArgs.chatHistory = JSON.parse(JSON.stringify(pathwayArgs.chatHistory));
        }
        
        // If we have text parameter, we need to add it to the chatHistory
        if (pathwayArgs.text) {
            // Find the last user message or create a new one
            let lastUserMessage = null;
            for (let i = cortexArgs.chatHistory.length - 1; i >= 0; i--) {
                if (cortexArgs.chatHistory[i].role === 'user') {
                    lastUserMessage = cortexArgs.chatHistory[i];
                    break;
                }
            }
            
            if (lastUserMessage) {
                // Ensure content is an array
                if (!Array.isArray(lastUserMessage.content)) {
                    lastUserMessage.content = [JSON.stringify({
                        type: "text",
                        text: lastUserMessage.content || ""
                    })];
                }
                
                // Add the text parameter as a text content item
                const textFromPrompt = originalPrompt?.prompt || pathwayArgs.text;
                lastUserMessage.content.unshift(JSON.stringify({
                    type: "text",
                    text: `${pathwayArgs.text}\n\n${textFromPrompt}`
                }));
            } else {
                // Create new user message with text
                const textFromPrompt = originalPrompt?.prompt || pathwayArgs.text;
                cortexArgs.chatHistory.push({
                    role: 'user',
                    content: [JSON.stringify({
                        type: "text",
                        text: `${pathwayArgs.text}\n\n${textFromPrompt}`
                    })]
                });
            }
        }
        
        // Create a pathwayResolver to capture extended data like artifacts
        const { PathwayResolver } = await import('./pathwayResolver.js');
        const cortexPathway = config.get(`pathways.${cortexPathwayName}`);
        if (!cortexPathway) {
            throw new Error(`Cortex pathway ${cortexPathwayName} not found`);
        }
        
        const pathwayResolver = new PathwayResolver({ 
            config, 
            pathway: cortexPathway, 
            args: cortexArgs 
        });
        
        const result = await callPathway(cortexPathwayName, cortexArgs, pathwayResolver);
        
        // Extract resultData from pathwayResolver (includes artifacts and other extended data)
        const resultData = pathwayResolver.pathwayResultData 
            ? JSON.stringify(pathwayResolver.pathwayResultData) 
            : null;
        
        // Return result with extended data
        return { 
            result,
            resultData,
            warnings: pathwayResolver.warnings,
            errors: pathwayResolver.errors
        };
    } else {
        // Fallback to original pathway execution for legacy prompts
        const pathwayContext = { ...contextValue, pathway };
        return await pathway.rootResolver(null, pathwayArgs, pathwayContext, info);
    }
};

// Main executeWorkspace resolver
export const executeWorkspaceResolver = async (_, args, contextValue, info, config, pathwayManager) => {
    const startTime = Date.now();
    const requestId = uuidv4();
    const { userId, pathwayName, promptNames, ...pathwayArgs } = args;
    
    logger.info(`>>> [${requestId}] executeWorkspace started - userId: ${userId}, pathwayName: ${pathwayName}, promptNames: ${promptNames?.join(',') || 'none'}`);
    
    try {
        contextValue.config = config;
        
        // Get the base pathway from the user
        const pathways = await pathwayManager.getLatestPathways();
        
        if (!pathways[userId] || !pathways[userId][pathwayName]) {
            const error = new Error(`Pathway '${pathwayName}' not found for user '${userId}'`);
            logger.error(`!!! [${requestId}] ${error.message} - Available users: ${Object.keys(pathways).join(', ')}`);
            throw error;
        }

        const basePathway = pathways[userId][pathwayName];
        
        // If promptNames is specified, use getPathways to get individual pathways and execute in parallel
        if (promptNames && promptNames.length > 0) {
            
            // Check if the prompts are in legacy format (array of strings)
            // If so, we can't use promptNames filtering and need to ask user to republish
            if (pathwayManager.isLegacyPromptFormat(userId, pathwayName)) {
                const error = new Error(
                    `The pathway '${pathwayName}' uses legacy prompt format (array of strings) which doesn't support the promptNames parameter. ` +
                    `Please unpublish and republish your workspace to upgrade to the new format that supports named prompts.`
                );
                logger.error(`!!! [${requestId}] ${error.message}`);
                throw error;
            }
            
            // Handle wildcard case - execute all prompts in parallel
            if (promptNames.includes('*')) {
                logger.info(`[${requestId}] Executing all prompts in parallel (wildcard specified)`);
                const individualPathways = await pathwayManager.getPathways(basePathway);
                
                if (individualPathways.length === 0) {
                    const error = new Error(`No prompts found in pathway '${pathwayName}'`);
                    logger.error(`!!! [${requestId}] ${error.message}`);
                    throw error;
                }
                
                // Resolve file content for any pathways that have file hashes
                await resolveAndAddFileContent(individualPathways, pathwayArgs, requestId, config);
                
                // Execute all pathways in parallel
                const results = await Promise.all(
                    individualPathways.map(async (pathway, index) => {
                        try {
                            // Check if the prompt has a cortexPathwayName (new format)
                            const originalPrompt = basePathway.prompt[index];
                            
                            const result = await executePathwayWithFallback(pathway, pathwayArgs, contextValue, info, requestId, originalPrompt, config);
                            
                            return {
                                result: result.result,
                                resultData: result.resultData,
                                warnings: result.warnings,
                                errors: result.errors,
                                promptName: pathway.name || `prompt_${index + 1}`
                            };
                        } catch (error) {
                            logger.error(`!!! [${requestId}] Error in pathway ${index + 1}/${individualPathways.length}: ${pathway.name || 'unnamed'} - ${error.message}`);
                            throw error;
                        }
                    })
                );
                
                const duration = Date.now() - startTime;
                logger.info(`<<< [${requestId}] executeWorkspace completed successfully in ${duration}ms - returned ${results.length} results`);
                
                // Return a single result with JSON stringified array of results
                return {
                    debug: `Executed ${results.length} prompts in parallel`,
                    result: JSON.stringify(results),
                    resultData: null,
                    previousResult: null,
                    warnings: [],
                    errors: [],
                    contextId: requestId,
                    tool: 'executeWorkspace'
                };
            } else {
                // Handle specific prompt names
                logger.info(`[${requestId}] Executing specific prompts: ${promptNames.join(', ')}`);
                const individualPathways = await pathwayManager.getPathways(basePathway, promptNames);
                
                if (individualPathways.length === 0) {
                    const error = new Error(`No prompts found matching the specified names: ${promptNames.join(', ')}`);
                    logger.error(`!!! [${requestId}] ${error.message}`);
                    throw error;
                }
                
                // Resolve file content for any pathways that have file hashes
                await resolveAndAddFileContent(individualPathways, pathwayArgs, requestId, config);
                
                // Execute all pathways in parallel
                const results = await Promise.all(
                    individualPathways.map(async (pathway, index) => {
                        try {
                            // Find the original prompt by name to get the cortexPathwayName
                            const originalPrompt = basePathway.prompt.find(p => 
                                (typeof p === 'object' && p.name === pathway.name) ||
                                (typeof p === 'string' && pathway.name === `prompt_${basePathway.prompt.indexOf(p)}`)
                            );
                            
                            const result = await executePathwayWithFallback(pathway, pathwayArgs, contextValue, info, requestId, originalPrompt, config);
                            
                            return {
                                result: result.result,
                                resultData: result.resultData,
                                warnings: result.warnings,
                                errors: result.errors,
                                promptName: pathway.name || `prompt_${index + 1}`
                            };
                        } catch (error) {
                            logger.error(`!!! [${requestId}] Error in pathway ${index + 1}/${individualPathways.length}: ${pathway.name || 'unnamed'} - ${error.message}`);
                            throw error;
                        }
                    })
                );
                
                const duration = Date.now() - startTime;
                logger.info(`<<< [${requestId}] executeWorkspace completed successfully in ${duration}ms - returned ${results.length} results`);
                
                // Return a single result with JSON stringified array of results (consistent with wildcard case)
                return {
                    debug: `Executed ${results.length} specific prompts in parallel: ${promptNames.join(', ')}`,
                    result: JSON.stringify(results),
                    resultData: null,
                    previousResult: null,
                    warnings: [],
                    errors: [],
                    contextId: requestId,
                    tool: 'executeWorkspace'
                };
            }
        }
        
        // Default behavior: execute all prompts in sequence
        logger.info(`[${requestId}] Executing prompts in sequence`);
        const userPathway = await pathwayManager.getPathway(userId, pathwayName);
        contextValue.pathway = userPathway;
        
        // Handle file hashes if present in the pathway
        await resolveAndAddFileContent(userPathway, pathwayArgs, requestId, config);
        
        // Check if any prompt has cortexPathwayName (for dynamic pathways)
        let result;
        if (userPathway.prompt && Array.isArray(userPathway.prompt)) {
            const firstPrompt = userPathway.prompt[0];
            
            result = await executePathwayWithFallback(userPathway, pathwayArgs, contextValue, info, requestId, firstPrompt, config);
        } else {
            // No prompt array, use legacy execution
            result = await userPathway.rootResolver(null, pathwayArgs, contextValue, info);
        }
        const duration = Date.now() - startTime;
        logger.info(`<<< [${requestId}] executeWorkspace completed successfully in ${duration}ms - returned 1 result`);
        return result; // Return single result directly
        
    } catch (error) {
        const duration = Date.now() - startTime;
        logger.error(`!!! [${requestId}] executeWorkspace failed after ${duration}ms`);
        logger.error(`!!! [${requestId}] Error type: ${error.constructor.name}`);
        logger.error(`!!! [${requestId}] Error message: ${error.message}`);
        logger.error(`!!! [${requestId}] Error stack: ${error.stack}`);
        
        // Log additional context for debugging "memory access out of bounds" errors
        if (error.message && error.message.includes('memory')) {
            logger.error(`!!! [${requestId}] MEMORY ERROR DETECTED - Additional context:`);
            logger.error(`!!! [${requestId}] - Node.js version: ${process.version}`);
            logger.error(`!!! [${requestId}] - Memory usage: ${JSON.stringify(process.memoryUsage())}`);
            logger.error(`!!! [${requestId}] - Args size estimate: ${JSON.stringify(args).length} chars`);
            logger.error(`!!! [${requestId}] - PathwayArgs keys: ${Object.keys(pathwayArgs).join(', ')}`);
        }
        
        throw error;
    }
};

// Type definitions for executeWorkspace
export const getExecuteWorkspaceTypeDefs = () => {
    return `
    ${getPathwayTypeDef('ExecuteWorkspace', 'String')}
    
    type ExecuteWorkspaceResult {
        debug: String
        result: String
        resultData: String
        previousResult: String
        warnings: [String]
        errors: [String]
        contextId: String
        tool: String
    }
    
    extend type Query {
        executeWorkspace(userId: String!, pathwayName: String!, ${userPathwayInputParameters}): ExecuteWorkspaceResult
    }
    `;
};

