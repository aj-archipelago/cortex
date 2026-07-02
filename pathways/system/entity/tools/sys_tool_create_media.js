// sys_tool_create_media.js
// Unified entity tool for creating and modifying images and videos
import { callPathway } from '../../../../lib/pathwayTools.js';
import {
    uploadImageToCloud,
    uploadFileToCloud,
    addFileToCollection,
    resolveFileParameter,
    buildFileCreationResponse,
    buildFileLocation,
    promptToFilename,
    getWriteFileAccessTarget,
} from '../../../../lib/fileUtils.js';
import { config } from '../../../../config.js';
import axios from 'axios';

export const DEFAULT_AGENT_IMAGE_MODEL = 'gemini-flash-lite-31-image';
export const DEFAULT_AGENT_IMAGE_PATHWAY = 'image_gemini_31_lite';

/**
 * Download a file from GCS using authenticated request
 * @param {string} gcsUri - GCS URI in format gs://bucket-name/object-path
 * @returns {Promise<Buffer>} File contents as Buffer
 */
async function downloadFromGcsUri(gcsUri) {
    if (!gcsUri || !gcsUri.startsWith('gs://')) {
        throw new Error(`Invalid GCS URI: ${gcsUri}`);
    }

    const uriWithoutProtocol = gcsUri.replace('gs://', '');
    const [bucketName, ...objectParts] = uriWithoutProtocol.split('/');
    const objectPath = objectParts.join('/');

    const httpsUrl = `https://storage.googleapis.com/storage/v1/b/${bucketName}/o/${encodeURIComponent(objectPath)}?alt=media`;

    const gcpAuthTokenHelper = config.get('gcpAuthTokenHelper');
    if (!gcpAuthTokenHelper) {
        throw new Error('GCP auth token helper not available');
    }

    const authToken = await gcpAuthTokenHelper.getAccessToken();

    const response = await axios.get(httpsUrl, {
        responseType: 'arraybuffer',
        timeout: 300000,
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

function formatVeoVideoInput(videoUrl) {
    if (!videoUrl || typeof videoUrl !== 'string') return '';

    if (videoUrl.startsWith('gs://')) {
        return JSON.stringify({ gcsUri: videoUrl, mimeType: 'video/mp4' });
    }

    try {
        const url = new URL(videoUrl);
        if (url.hostname === 'storage.googleapis.com') {
            return JSON.stringify({
                gcsUri: `gs://${url.pathname.substring(1)}`,
                mimeType: 'video/mp4',
            });
        }
    } catch {
        // Fall through to the clearer error below.
    }

    throw new Error('Veo video extension requires a GCS video URL. Use FileCollection to select an uploaded video file.');
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
    timeout: 600,
    toolDefinition: [{
        type: "function",
        enabled: true,
        icon: "🎨",
        function: {
            name: "CreateMedia",
            description: "Generate or modify images and videos.\n- To CREATE an image from scratch: set type=\"image\" and provide a prompt\n- To MODIFY/TRANSFORM an image: set type=\"image\" and attach referenceImages from your file collection\n- To CREATE a video: set type=\"video\" and provide a prompt\n- To EXTEND a video: set type=\"video\" and attach one referenceVideos item from your file collection\nVideos are slow and expensive. Use sparingly.",
            parameters: {
                type: "object",
                properties: {
                    type: {
                        type: "string",
                        enum: ["image", "video"],
                        description: "The type of media to create: \"image\" or \"video\""
                    },
                    prompt: {
                        type: "string",
                        description: "A detailed description of what to create or how to modify. Be specific about subject matter, style, camera angles, lighting, mood, etc. The more detailed, the better the result."
                    },
                    referenceImages: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "Files from your file collection to use as reference (hash, filename, URL, or a workspace path like /workspace/files/...). For images: up to 3 references for modification/transformation. For video: 1 reference as starting frame."
                    },
                    referenceVideos: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "Video files from your file collection to extend (hash, filename, URL, or a workspace path like /workspace/files/...). For video extension, provide exactly one MP4 video."
                    },
                    filenamePrefix: {
                        type: "string",
                        description: "Optional: A descriptive prefix for the output filename (e.g., 'portrait', 'promo'). Defaults based on operation."
                    },
                    tags: {
                        type: "array",
                        items: {
                            type: "string"
                        },
                        description: "Optional: Array of tags to categorize the output."
                    },
                    userMessage: {
                        type: "string",
                        description: "A user-friendly message that describes what you're doing with this tool"
                    }
                },
                required: ["type", "prompt", "userMessage"]
            }
        }
    }],

    executePathway: async ({args, runAllPrompts, resolver}) => {
        const pathwayResolver = resolver;
        const chatId = args.chatId || null;
        const mediaType = args.type || 'image';

        try {
            if (mediaType === 'video') {
                return await generateVideo(args, pathwayResolver, chatId);
            } else {
                return await generateImage(args, pathwayResolver, chatId);
            }
        } catch (e) {
            const errorMessage = e.message ?? String(e);
            pathwayResolver.logError(errorMessage);

            let guidance = '';
            if (errorMessage.includes('IMAGE_SAFETY') || errorMessage.includes('safety') || errorMessage.includes('SAFETY') || errorMessage.includes('blocked')) {
                guidance = ' Try a different approach: use stylized/artistic depictions instead of photorealistic, avoid human faces, or simplify the prompt.';
            } else if (errorMessage.includes('RECITATION')) {
                guidance = ' The request may be too similar to copyrighted content. Try making the prompt more original.';
            } else if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
                guidance = ` The ${mediaType} generation timed out. Try a simpler prompt or try again.`;
            } else if (errorMessage.includes('quota') || errorMessage.includes('rate limit')) {
                guidance = ' Rate limit reached. Please wait a moment and try again.';
            }

            return JSON.stringify({
                error: true,
                message: `${mediaType === 'video' ? 'Video' : 'Image'} generation failed: ${errorMessage}${guidance}`,
                toolName: 'CreateMedia'
            });
        }
    }
};

/**
 * Generate or modify an image
 */
async function generateImage(args, pathwayResolver, chatId) {
    const prompt = args.prompt || args.detailedInstructions || "";
    const hasReferenceImages = args.referenceImages && Array.isArray(args.referenceImages) && args.referenceImages.length > 0;
    const fileAccessPlan = Array.isArray(args.fileAccessPlan) ? args.fileAccessPlan : [];

    // Resolve reference images
    const resolvedImages = [];
    if (hasReferenceImages) {
        if (fileAccessPlan.length === 0) {
            throw new Error("fileAccessPlan is required when using referenceImages. Use FileCollection to find available files.");
        }

        const imagesToProcess = args.referenceImages.slice(0, 3);
        for (const imageRef of imagesToProcess) {
            const resolved = await resolveFileParameter(imageRef, fileAccessPlan, { preferGcs: !hasReferenceImages || false });
            if (!resolved) {
                throw new Error(`File not found: "${imageRef}". Use FileCollection to find available files.`);
            }
            resolvedImages.push(resolved);
        }
    }

    return await generateImageWithGemini(args, prompt, resolvedImages, pathwayResolver, chatId);
}

/**
 * Generate image with Gemini (no reference images, or reference images with GCS preference)
 */
async function generateImageWithGemini(args, prompt, resolvedImages, pathwayResolver, chatId) {
    const fileAccessPlan = Array.isArray(args.fileAccessPlan) ? args.fileAccessPlan : [];
    const writeTarget = getWriteFileAccessTarget(fileAccessPlan);

    // Re-resolve with preferGcs for Gemini
    const resolvedGcsImages = [];
    if (resolvedImages.length > 0 && args.referenceImages) {
        for (const imageRef of args.referenceImages.slice(0, 3)) {
            const resolved = await resolveFileParameter(imageRef, fileAccessPlan, { preferGcs: true });
            if (resolved) resolvedGcsImages.push(resolved);
        }
    }
    const images = resolvedGcsImages.length > 0 ? resolvedGcsImages : resolvedImages;

    const result = await callPathway(DEFAULT_AGENT_IMAGE_PATHWAY, {
        ...args,
        text: prompt,
        model: DEFAULT_AGENT_IMAGE_MODEL,
        stream: false,
        input_image: images.length > 0 ? images[0] : undefined,
        input_image_2: images.length > 1 ? images[1] : undefined,
        input_image_3: images.length > 2 ? images[2] : undefined,
        optimizePrompt: true,
    }, pathwayResolver);

    pathwayResolver.tool = JSON.stringify({ toolUsed: "image" });

    const hasArtifacts = pathwayResolver.pathwayResultData?.artifacts &&
                         Array.isArray(pathwayResolver.pathwayResultData.artifacts) &&
                         pathwayResolver.pathwayResultData.artifacts.length > 0;

    if (!hasArtifacts && (result === null || result === undefined || result === '')) {
        throw new Error('Image generation failed: No response from image generation API. Try a different prompt.');
    }

    if (hasArtifacts) {
        const uploadedImages = [];

        for (const artifact of pathwayResolver.pathwayResultData.artifacts) {
            if (artifact.type === 'image' && artifact.data && artifact.mimeType) {
                try {
                    const extension = artifact.mimeType.split('/')[1] || 'png';
                    const uploadFilename = promptToFilename(prompt, extension, {
                        prefix: args.filenamePrefix,
                        index: uploadedImages.length,
                    });

                    const fileLocation = writeTarget
                        ? buildFileLocation(writeTarget.contextId, {
                            userId: writeTarget.userContextId || null,
                            chatId: writeTarget.chatId || null,
                            workspaceId: writeTarget.workspaceId || null,
                            appletId: writeTarget.appletId || null,
                            fileScope: writeTarget.writeFileScope || null,
                        })
                        : null;
                    const uploadResult = await uploadImageToCloud(artifact.data, artifact.mimeType, pathwayResolver, fileLocation, uploadFilename);

                    const imageUrl = uploadResult.url || uploadResult;
                    const imageGcs = uploadResult.gcs || null;
                    const imageHash = uploadResult.hash || null;

                    const imageData = {
                        type: 'image',
                        url: imageUrl,
                        gcs: imageGcs,
                        hash: imageHash,
                        mimeType: artifact.mimeType
                    };

                    if (writeTarget?.contextId && imageUrl) {
                        try {
                            const fileEntry = await addFileToCollection(
                                writeTarget.contextId,
                                writeTarget.contextKey || '',
                                imageUrl,
                                uploadFilename,
                                imageHash,
                                null,
                                pathwayResolver,
                                writeTarget.chatId || null,
                                {
                                    workspaceId: writeTarget.workspaceId || null,
                                    appletId: writeTarget.appletId || null,
                                    fileScope: writeTarget.writeFileScope || null,
                                }
                            );

                            imageData.fileEntry = fileEntry;
                        } catch (collectionError) {
                            pathwayResolver.logWarning(`Failed to add image to file collection: ${collectionError.message}`);
                        }
                    }

                    uploadedImages.push(imageData);
                } catch (uploadError) {
                    pathwayResolver.logError(`Failed to upload artifact: ${uploadError.message}`);
                    uploadedImages.push(artifact);
                }
            } else {
                uploadedImages.push(artifact);
            }
        }

        const successfulImages = uploadedImages.filter(img => img.url);
        if (successfulImages.length > 0) {
            const isModification = resolvedImages.length > 0;
            return buildFileCreationResponse(successfulImages, {
                mediaType: 'image',
                action: isModification ? 'Image modification' : 'Image generation',
            });
        } else {
            throw new Error('Image generation failed: Images were generated but could not be uploaded to storage');
        }
    } else {
        throw new Error('Image generation failed: No images were generated. This may be due to content safety filters blocking the request. Try using a different, less detailed prompt or avoiding photorealistic depictions of people/faces.');
    }
}

/**
 * Generate a video with Veo
 */
async function generateVideo(args, pathwayResolver, chatId) {
    const prompt = args.prompt || "";
    const hasReferenceImage = args.referenceImages && Array.isArray(args.referenceImages) && args.referenceImages.length > 0;
    const hasReferenceVideo = args.referenceVideos && Array.isArray(args.referenceVideos) && args.referenceVideos.length > 0;
    const model = hasReferenceVideo ? "veo-3.1-generate" : "veo-3.1-lite-generate";
    const fileAccessPlan = Array.isArray(args.fileAccessPlan) ? args.fileAccessPlan : [];
    const writeTarget = getWriteFileAccessTarget(fileAccessPlan);

    // Resolve input image if provided (only first one for video)
    let imageParam = undefined;
    if (hasReferenceImage) {
        if (fileAccessPlan.length === 0) {
            throw new Error("fileAccessPlan is required when using referenceImages. Use FileCollection to find available files.");
        }

        const resolved = await resolveFileParameter(args.referenceImages[0], fileAccessPlan, { preferGcs: true });
        if (!resolved) {
            throw new Error(`File not found: "${args.referenceImages[0]}". Use FileCollection to find available files.`);
        }

        if (resolved.startsWith('gs://')) {
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
            pathwayResolver.logWarning(`Input image resolved to non-GCS URL: ${resolved}. Veo may not accept this.`);
            pathwayResolver.logWarning(`Skipping input image - Veo requires GCS URLs. Please upload the image to GCS first.`);
        }
    }

    let videoParam = undefined;
    if (hasReferenceVideo) {
        if (fileAccessPlan.length === 0) {
            throw new Error("fileAccessPlan is required when using referenceVideos. Use FileCollection to find available files.");
        }

        const resolved = await resolveFileParameter(args.referenceVideos[0], fileAccessPlan, { preferGcs: true });
        if (!resolved) {
            throw new Error(`File not found: "${args.referenceVideos[0]}". Use FileCollection to find available files.`);
        }

        videoParam = formatVeoVideoInput(resolved);
    }

    const veoParams = {
        ...args,
        text: prompt,
        model,
        durationSeconds: 8,
        generateAudio: true,
        enhancePrompt: true,
    };

    if (imageParam) {
        veoParams.image = imageParam;
    }
    if (videoParam) {
        veoParams.video = videoParam;
        veoParams.resolution = args.resolution || '720p';
    }

    let result = await callPathway('video_veo', veoParams, pathwayResolver);

    pathwayResolver.tool = JSON.stringify({ toolUsed: "video" });

    if (!result || typeof result !== 'string') {
        throw new Error('Video generation failed: No response from Veo API');
    }

    if (result.includes('error') && result.includes('status code')) {
        throw new Error(`Video generation failed: ${result}`);
    }

    let parsedResult;
    try {
        parsedResult = JSON.parse(result);
    } catch (parseError) {
        throw new Error(`Video generation failed: Invalid response from Veo - ${result.substring(0, 200)}`);
    }

    if (parsedResult?.error) {
        throw new Error(`Video generation failed: ${parsedResult.error.message || JSON.stringify(parsedResult.error)}`);
    }

    const videos = parsedResult?.response?.videos;

    if (!videos || !Array.isArray(videos) || videos.length === 0) {
        throw new Error('Video generation failed: Veo API returned no videos');
    }

    const uploadedVideos = [];

    for (const video of videos) {
        const videoInfo = extractVideoInfo(video);

        if (videoInfo) {
            try {
                let fileBuffer;

                if (videoInfo.type === 'gcsUri') {
                    pathwayResolver.log(`Downloading video from GCS: ${videoInfo.data}`);
                    fileBuffer = await downloadFromGcsUri(videoInfo.data);
                    pathwayResolver.log(`Downloaded ${fileBuffer.length} bytes from GCS`);
                } else if (videoInfo.type === 'base64') {
                    fileBuffer = Buffer.from(videoInfo.data, 'base64');
                } else {
                    throw new Error(`Unknown video info type: ${videoInfo.type}`);
                }

                const uploadFilename = promptToFilename(prompt, 'mp4', {
                    prefix: args.filenamePrefix,
                    index: uploadedVideos.length,
                });

                const fileLocation = writeTarget
                    ? buildFileLocation(writeTarget.contextId, {
                        userId: writeTarget.userContextId || null,
                        chatId: writeTarget.chatId || null,
                        workspaceId: writeTarget.workspaceId || null,
                        appletId: writeTarget.appletId || null,
                        fileScope: writeTarget.writeFileScope || null,
                    })
                    : null;
                const uploadResult = await uploadFileToCloud(
                    fileBuffer,
                    videoInfo.mimeType || 'video/mp4',
                    uploadFilename,
                    pathwayResolver,
                    fileLocation
                );

                const uploadedUrl = uploadResult.url || uploadResult;
                const uploadedGcs = uploadResult.gcs || null;
                const uploadedHash = uploadResult.hash || null;

                const videoData = {
                    type: 'video',
                    url: uploadedUrl,
                    gcs: uploadedGcs,
                    hash: uploadedHash,
                    mimeType: 'video/mp4'
                };

                if (writeTarget?.contextId && uploadedUrl) {
                    try {
                        const fileEntry = await addFileToCollection(
                            writeTarget.contextId,
                            writeTarget.contextKey || '',
                            uploadedUrl,
                            uploadFilename,
                            uploadedHash,
                            null,
                            pathwayResolver,
                            writeTarget.chatId || null,
                            {
                                workspaceId: writeTarget.workspaceId || null,
                                appletId: writeTarget.appletId || null,
                                fileScope: writeTarget.writeFileScope || null,
                            }
                        );

                        videoData.fileEntry = fileEntry;
                    } catch (collectionError) {
                        pathwayResolver.logWarning(`Failed to add video to file collection: ${collectionError.message}`);
                    }
                }

                uploadedVideos.push(videoData);
            } catch (uploadError) {
                pathwayResolver.logError(`Failed to upload video from Veo: ${uploadError.message}`);
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

    if (uploadedVideos.length > 0) {
        const successfulVideos = uploadedVideos.filter(v => v.url);
        if (successfulVideos.length > 0) {
            return buildFileCreationResponse(successfulVideos, {
                mediaType: 'video',
                action: hasReferenceVideo ? 'Video extension' : 'Video generation',
            });
        } else {
            const errors = uploadedVideos.map(v => v.error).filter(Boolean);
            throw new Error(`Video generation succeeded but upload failed: ${errors.join('; ')}`);
        }
    } else {
        throw new Error('Video generation failed: No videos could be processed');
    }
}
