// sys_tool_video_veo.js
// Entity tool that generates videos using Google Veo 3.1 Fast for the entity to show to the user
import { callPathway } from '../../../../lib/pathwayTools.js';
import { uploadFileToCloud, addFileToCollection, resolveFileParameter } from '../../../../lib/fileUtils.js';
import { config } from '../../../../config.js';
import axios from 'axios';

/**
 * Download a file from GCS using authenticated request
 * @param {string} gcsUri - GCS URI in format gs://bucket-name/object-path
 * @returns {Promise<Buffer>} File contents as Buffer
 */
async function downloadFromGcsUri(gcsUri) {
    if (!gcsUri || !gcsUri.startsWith('gs://')) {
        throw new Error(`Invalid GCS URI: ${gcsUri}`);
    }
    
    // Parse the GCS URI
    const uriWithoutProtocol = gcsUri.replace('gs://', '');
    const [bucketName, ...objectParts] = uriWithoutProtocol.split('/');
    const objectPath = objectParts.join('/');
    
    // Construct the JSON API URL for downloading
    const httpsUrl = `https://storage.googleapis.com/storage/v1/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media`;
    
    // Get auth token from the config
    const gcpAuthTokenHelper = config.get('gcpAuthTokenHelper');
    if (!gcpAuthTokenHelper) {
        throw new Error('GCP auth token helper not available');
    }
    
    const authToken = await gcpAuthTokenHelper.getAccessToken();
    
    // Download with authentication
    const response = await axios.get(httpsUrl, {
        responseType: 'arraybuffer',
        timeout: 300000, // 5 minute timeout for video download
        headers: {
            'Authorization': `Bearer ${authToken}`
        }
    });
    
    return Buffer.from(response.data);
}

/**
 * Extract video info from Veo video response
 * @param {Object} video - Video object from Veo response
 * @returns {Object|null} Video info with type and data
 */
function extractVideoInfo(video) {
    if (video.bytesBase64Encoded) {
        return {
            type: 'base64',
            data: video.bytesBase64Encoded,
            mimeType: video.mimeType || 'video/mp4'
        };
    } else if (video.gcsUri) {
        return {
            type: 'gcsUri',
            data: video.gcsUri,
            mimeType: video.mimeType || 'video/mp4'
        };
    }
    return null;
}

export default {
    prompt: [],
    useInputChunking: false,
    enableDuplicateRequests: false,
    inputParameters: {
        model: 'oai-gpt4o',
        contextId: '',
        contextKey: '',
    },
    timeout: 600, // 10 minutes for video generation
    toolDefinition: [{
        type: "function",
        enabled: true,
        icon: "🎬",
        function: {
            name: "GenerateVideo",
            description: "Use when asked to create, generate, or produce video content. This tool generates short 8-second video clips from text descriptions and optional reference images using Google's Veo 3.1 Fast model. The videos are high quality with AI-generated audio. Perfect for creating promotional clips, visual demonstrations, animated scenes, or bringing still images to life. After you have generated the video, you must include a link to it in your response to show it to the user.",
            parameters: {
                type: "object",
                properties: {
                    prompt: {
                        type: "string",
                        description: "A detailed description of the video you want to create. Be specific about the scene, action, camera movement, lighting, style, and mood. For example: 'A golden retriever running through a field of sunflowers at sunset, camera tracking from the side, warm golden light, slow motion, cinematic style'. The more descriptive the prompt, the better the video result."
                    },
                    inputImage: {
                        type: "string",
                        description: "Optional: A reference image from your available files (from Available Files section or ListFileCollection or SearchFileCollection) to use as the starting frame or style reference for the video. The video will be generated to animate or extend from this image. Provide the hash or filename of the image."
                    },
                    filenamePrefix: {
                        type: "string",
                        description: "Optional: A descriptive prefix to use for the generated video filename (e.g., 'promo', 'demo', 'animation'). If not provided, defaults to 'generated-video'."
                    },
                    tags: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "Optional: Array of tags to categorize the video (e.g., ['promo', 'animation', 'product']). Will be merged with default tags ['video', 'generated']."
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    }
                },
                required: ["prompt", "userMessage"]
            }
        }
    }],
    executePathway: async ({args, runAllPrompts, resolver}) => {
        const pathwayResolver = resolver;

        try {   
            const model = "veo-3.1-fast-generate";
            const prompt = args.prompt || "";
            
            // Resolve input image to GCS URL if provided
            // Veo requires GCS URLs for input images
            let imageParam = undefined;
            if (args.inputImage) {
                if (!args.contextId) {
                    throw new Error("contextId is required when using the 'inputImage' parameter. Use ListFileCollection or SearchFileCollection to find available files.");
                }
                
                const resolved = await resolveFileParameter(args.inputImage, args.contextId, args.contextKey, { preferGcs: true });
                if (!resolved) {
                    throw new Error(`File not found: "${args.inputImage}". Use ListFileCollection or SearchFileCollection to find available files.`);
                }
                
                // Veo expects image as JSON object with gcsUri and mimeType
                // The resolved URL should be a GCS URL if preferGcs is true
                if (resolved.startsWith('gs://')) {
                    // Determine mime type from file extension
                    const extension = resolved.split('.').pop()?.toLowerCase();
                    const mimeTypeMap = {
                        'jpg': 'image/jpeg',
                        'jpeg': 'image/jpeg',
                        'png': 'image/png',
                        'gif': 'image/gif',
                        'webp': 'image/webp'
                    };
                    const mimeType = mimeTypeMap[extension] || 'image/jpeg';
                    imageParam = JSON.stringify({ gcsUri: resolved, mimeType });
                } else {
                    // If we got an HTTPS URL instead of GCS, we can't use it directly with Veo
                    // Log a warning but proceed - Veo may or may not accept it
                    pathwayResolver.logWarning(`Input image resolved to non-GCS URL: ${resolved}. Veo may not accept this.`);
                    // Try to use it anyway by constructing a reasonable image param
                    const extension = resolved.split('.').pop()?.split('?')[0]?.toLowerCase();
                    const mimeTypeMap = {
                        'jpg': 'image/jpeg',
                        'jpeg': 'image/jpeg',
                        'png': 'image/png',
                        'gif': 'image/gif',
                        'webp': 'image/webp'
                    };
                    const mimeType = mimeTypeMap[extension] || 'image/jpeg';
                    // For HTTPS URLs, we might need to specify differently - check Veo docs
                    // For now, skip the image if it's not GCS
                    pathwayResolver.logWarning(`Skipping input image - Veo requires GCS URLs. Please upload the image to GCS first.`);
                }
            }
            
            // Call the video generation pathway
            const veoParams = {
                ...args,
                text: prompt,
                model,
                durationSeconds: 8, // Veo 3.1 only supports 8 seconds
                generateAudio: true, // Veo 3.x supports and requires audio
                enhancePrompt: true,
            };
            
            // Add image parameter if resolved
            if (imageParam) {
                veoParams.image = imageParam;
            }
            
            let result = await callPathway('video_veo', veoParams, pathwayResolver);

            pathwayResolver.tool = JSON.stringify({ toolUsed: "video" });

            // Check if the result indicates an error before parsing
            // The pathway may return an error string or an error object
            if (!result || typeof result !== 'string') {
                throw new Error('Video generation failed: No response from Veo API');
            }
            
            // Check for common error patterns in the result
            if (result.includes('error') && result.includes('status code')) {
                throw new Error(`Video generation failed: ${result}`);
            }

            // Parse the Veo response to extract video information
            // Veo returns: { response: { videos: [{ gcsUri, mimeType }], operationName, status } }
            let parsedResult;
            try {
                parsedResult = JSON.parse(result);
            } catch (parseError) {
                throw new Error(`Video generation failed: Invalid response from Veo - ${result.substring(0, 200)}`);
            }
            
            // Check for error in parsed result
            if (parsedResult?.error) {
                throw new Error(`Video generation failed: ${parsedResult.error.message || JSON.stringify(parsedResult.error)}`);
            }
            
            const videos = parsedResult?.response?.videos;
            
            if (!videos || !Array.isArray(videos) || videos.length === 0) {
                throw new Error('Video generation failed: Veo API returned no videos');
            }
            
            // Process the videos
            const uploadedVideos = [];
            
            for (const video of videos) {
                // Extract video info - handles both base64 and GCS URI
                const videoInfo = extractVideoInfo(video);
                
                if (videoInfo) {
                    try {
                        let fileBuffer;
                        
                        // Handle different video source types
                        if (videoInfo.type === 'gcsUri') {
                            // Download from GCS with authentication
                            pathwayResolver.log(`Downloading video from GCS: ${videoInfo.data}`);
                            fileBuffer = await downloadFromGcsUri(videoInfo.data);
                            pathwayResolver.log(`Downloaded ${fileBuffer.length} bytes from GCS`);
                        } else if (videoInfo.type === 'base64') {
                            // Convert base64 to buffer
                            fileBuffer = Buffer.from(videoInfo.data, 'base64');
                        } else {
                            throw new Error(`Unknown video info type: ${videoInfo.type}`);
                        }
                        
                        // Upload the buffer to our cloud storage
                        const uploadResult = await uploadFileToCloud(
                            fileBuffer,
                            videoInfo.mimeType || 'video/mp4',
                            null, // filename will be generated
                            pathwayResolver,
                            args.contextId
                        );
                        
                        const uploadedUrl = uploadResult.url || uploadResult;
                        const uploadedGcs = uploadResult.gcs || null;
                        const uploadedHash = uploadResult.hash || null;
                        
                        // Prepare video data
                        const videoData = {
                            type: 'video',
                            url: uploadedUrl,
                            gcs: uploadedGcs,
                            hash: uploadedHash,
                            mimeType: 'video/mp4'
                        };
                        
                        // Add uploaded video to file collection if contextId is available
                        if (args.contextId && uploadedUrl) {
                            try {
                                // Use hash for uniqueness if available, otherwise use timestamp
                                const uniqueId = uploadedHash ? uploadedHash.substring(0, 8) : `${Date.now()}`;
                                
                                // Determine filename prefix
                                const hasInputImage = args.inputImage ? true : false;
                                const defaultPrefix = hasInputImage ? 'animated-video' : 'generated-video';
                                const filenamePrefix = args.filenamePrefix || defaultPrefix;
                                
                                // Sanitize the prefix to ensure it's a valid filename component
                                const sanitizedPrefix = filenamePrefix.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
                                const filename = `${sanitizedPrefix}-${uniqueId}.mp4`;
                                
                                // Merge provided tags with default tags
                                const defaultTags = ['video', 'generated', 'veo'];
                                const providedTags = Array.isArray(args.tags) ? args.tags : [];
                                const allTags = [...defaultTags, ...providedTags.filter(tag => !defaultTags.includes(tag))];
                                
                                // Use the centralized utility function to add to collection - capture returned entry
                                const fileEntry = await addFileToCollection(
                                    args.contextId,
                                    args.contextKey || '',
                                    uploadedUrl,
                                    uploadedGcs,
                                    filename,
                                    allTags,
                                    hasInputImage 
                                        ? `Generated video from image with prompt: ${args.prompt || 'video animation'}`
                                        : `Generated video from prompt: ${args.prompt || 'video generation'}`,
                                    uploadedHash,
                                    null,
                                    pathwayResolver,
                                    true // permanent => retention=permanent
                                );
                                
                                // Use the file entry data for the return message
                                videoData.fileEntry = fileEntry;
                            } catch (collectionError) {
                                // Log but don't fail - file collection is optional
                                pathwayResolver.logWarning(`Failed to add video to file collection: ${collectionError.message}`);
                            }
                        }
                        
                        uploadedVideos.push(videoData);
                    } catch (uploadError) {
                        pathwayResolver.logError(`Failed to upload video from Veo: ${uploadError.message}`);
                        // Keep original info as fallback
                        uploadedVideos.push({
                            type: 'video',
                            url: null,
                            gcsUri: videoInfo.type === 'gcsUri' ? videoInfo.data : null,
                            mimeType: videoInfo.mimeType || 'video/mp4',
                            error: `Failed to upload to cloud storage: ${uploadError.message}`
                        });
                    }
                }
            }
            
            // Return the URLs of the uploaded videos as text in the result
            if (uploadedVideos.length > 0) {
                const successfulVideos = uploadedVideos.filter(v => v.url);
                if (successfulVideos.length > 0) {
                    // Return video info in the same format as availableFiles
                    // Format: hash | filename | url | date | tags
                    const videoList = successfulVideos.map((vid) => {
                        if (vid.fileEntry) {
                            // Use the file entry data from addFileToCollection
                            const fe = vid.fileEntry;
                            const dateStr = fe.addedDate 
                                ? new Date(fe.addedDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                                : '';
                            const tagsStr = Array.isArray(fe.tags) ? fe.tags.join(',') : '';
                            return `${fe.hash || ''} | ${fe.displayFilename || ''} | ${fe.url || vid.url} | ${dateStr} | ${tagsStr}`;
                        } else {
                            // Fallback if file collection wasn't available
                            return `${vid.hash || 'unknown'} | | ${vid.url} | |`;
                        }
                    }).join('\n');
                    
                    const count = successfulVideos.length;
                    // Note: The UI supports displaying videos using markdown image syntax
                    return `Video generation successful. Generated ${count} video${count > 1 ? 's' : ''}. Videos can be displayed using markdown image syntax, e.g. ![video](url)\n${videoList}`;
                } else {
                    // All videos failed to upload
                    const errors = uploadedVideos.map(v => v.error).filter(Boolean);
                    throw new Error(`Video generation succeeded but upload failed: ${errors.join('; ')}`);
                }
            } else {
                throw new Error('Video generation failed: No videos could be processed');
            }

        } catch (e) {
            // Return a structured error that the agent can understand and act upon
            // Do NOT call sys_generator_error - let the agent see the actual error
            const errorMessage = e.message ?? String(e);
            pathwayResolver.logError(errorMessage);
            
            // Check for specific error types and provide actionable guidance
            let guidance = '';
            if (errorMessage.includes('SAFETY') || errorMessage.includes('safety') || errorMessage.includes('blocked')) {
                guidance = ' Try a different approach: use stylized/artistic content instead of photorealistic, avoid depicting real people, or simplify the prompt.';
            } else if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
                guidance = ' The video generation timed out. Try a simpler scene or try again.';
            } else if (errorMessage.includes('quota') || errorMessage.includes('rate limit')) {
                guidance = ' Rate limit reached. Please wait a moment and try again.';
            }
            
            return JSON.stringify({
                error: true,
                message: `Video generation failed: ${errorMessage}${guidance}`,
                toolName: 'GenerateVideo'
            });
        }
    }
};

