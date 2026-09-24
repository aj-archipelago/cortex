// media_generate.js
// Router pathway that accepts standardized parameters and delegates to
// the correct sub-pathway based on model metadata. Normalizes responses
// so callers always get HTTPS URLs (or provider URLs), never raw API JSON
// and never large data: URIs on Redis requestProgress.

import { callPathway } from "../lib/pathwayTools.js";
import { config } from "../config.js";
import logger from "../lib/logger.js";
import { priorityMediaParameters } from "../lib/priorityMediaParameters.js";
import {
    uploadImageToCloud,
    promptToFilename,
    buildFileLocation,
} from "../lib/fileUtils.js";

/**
 * Remove base64 payloads from artifacts so Redis progress `info` stays small.
 * Mutates resolver.pathwayResultData.artifacts in place.
 */
export function stripArtifactBinaryData(resolver) {
    const artifacts = resolver?.pathwayResultData?.artifacts;
    if (!Array.isArray(artifacts)) return;
    for (const artifact of artifacts) {
        if (artifact && typeof artifact === "object" && "data" in artifact) {
            delete artifact.data;
        }
    }
}

async function uploadBase64ImageToCloud(
    base64Data,
    mimeType,
    resolver,
    args = {},
    uploadFn = uploadImageToCloud,
) {
    const extension = (mimeType || "image/png").split("/")[1] || "png";
    const uploadFilename = promptToFilename(
        args.text || "generated-image",
        extension,
    );
    const fileLocation = args.contextId
        ? buildFileLocation(args.contextId)
        : null;
    const uploadResult = await uploadFn(
        base64Data,
        mimeType || "image/png",
        resolver,
        fileLocation,
        uploadFilename,
    );
    const url = uploadResult?.url || uploadResult;
    if (!url || typeof url !== "string") {
        throw new Error("media_generate: image upload returned no URL");
    }
    return { url, uploadResult };
}

const omitUndefined = (obj) =>
    Object.fromEntries(
        Object.entries(obj).filter(
            ([, value]) => value !== undefined && value !== null,
        ),
    );

const SEEDANCE_2_MODELS = new Set([
    "replicate-seedance-2.0",
    "replicate-seedance-2.0-fast",
    "replicate-seedance-2.0-mini",
]);

const REFERENCE_ROLE_ALIASES = {
    reference: "reference",
    general: "reference",
    general_reference: "reference",
    asset: "reference",
    start: "start_frame",
    start_frame: "start_frame",
    startFrame: "start_frame",
    first_frame: "start_frame",
    firstFrame: "start_frame",
    start_image: "start_frame",
    startImage: "start_frame",
    end: "end_frame",
    end_frame: "end_frame",
    endFrame: "end_frame",
    last_frame: "end_frame",
    lastFrame: "end_frame",
    end_image: "end_frame",
    endImage: "end_frame",
};

const REFERENCE_ROLE_LABELS = {
    reference: "Reference",
    start_frame: "Start Frame",
    end_frame: "End Frame",
};

function normalizeReferenceRole(role) {
    if (typeof role !== "string" || !role.trim()) return "";
    return REFERENCE_ROLE_ALIASES[role.trim()] || "";
}

function getRoleLabel(role) {
    return REFERENCE_ROLE_LABELS[role] || role;
}

function buildImageReferences(args, images) {
    const roles = Array.isArray(args.inputImageRoles)
        ? args.inputImageRoles
        : [];
    return images.map((url, index) => ({
        url,
        role: normalizeReferenceRole(roles[index]),
    }));
}

function splitImageReferences(args, images) {
    const refs = buildImageReferences(args, images);
    const hasExplicitRoles = refs.some((ref) => ref.role);

    if (!hasExplicitRoles) {
        return {
            hasExplicitRoles: false,
            startFrames: [],
            endFrames: [],
            references: [],
        };
    }

    return {
        hasExplicitRoles: true,
        startFrames: refs
            .filter((ref) => ref.role === "start_frame")
            .map((ref) => ref.url),
        endFrames: refs
            .filter((ref) => ref.role === "end_frame")
            .map((ref) => ref.url),
        references: refs
            .filter((ref) => ref.role === "reference" || !ref.role)
            .map((ref) => ref.url),
    };
}

function validateReferenceRoles(args, modelId, metadata = {}) {
    const roles = Array.isArray(args.inputImageRoles)
        ? args.inputImageRoles
        : [];
    const normalizedRoles = roles
        .filter((role) => typeof role === "string" && role.trim())
        .map((role) => ({
            raw: role,
            normalized: normalizeReferenceRole(role),
        }));

    if (normalizedRoles.length === 0) return;

    const invalidRole = normalizedRoles.find((role) => !role.normalized);
    if (invalidRole) {
        throw new Error(
            `Unsupported reference image role '${invalidRole.raw}'`,
        );
    }

    const supportedRoles = metadata.referenceImageRoles || [];
    const unsupportedRole = normalizedRoles.find(
        (role) => !supportedRoles.includes(role.normalized),
    );
    if (unsupportedRole) {
        const supportedText =
            supportedRoles.length > 0
                ? supportedRoles.map(getRoleLabel).join(", ")
                : "none";
        throw new Error(
            `Model '${modelId}' does not support ${getRoleLabel(unsupportedRole.normalized)} image references. Supported roles: ${supportedText}.`,
        );
    }

    const roleLimits = metadata.referenceImageRoleLimits;
    if (!roleLimits || typeof roleLimits !== "object") return;

    const counts = new Map();
    for (const role of normalizedRoles) {
        const nextCount = (counts.get(role.normalized) || 0) + 1;
        counts.set(role.normalized, nextCount);
    }

    for (const [role, count] of counts.entries()) {
        const range = roleLimits[role] || roleLimits.default;
        if (range === undefined) continue;
        const max = Array.isArray(range)
            ? Number(range[1] ?? range[0])
            : Number(range);
        if (Number.isFinite(max) && count > max) {
            throw new Error(
                `Model '${modelId}' supports at most ${max} ${getRoleLabel(role)} image reference${max === 1 ? "" : "s"}.`,
            );
        }
    }
}

// Convert an HTTPS storage.googleapis.com URL (or gs:// URI) into
// the JSON {gcsUri, mimeType} format that the Veo pathway expects.
const VEO_IMAGE_MIME_TYPES = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
};

const VEO_VIDEO_MIME_TYPES = {
    mp4: "video/mp4",
};

function getMediaExtension(mediaUrl, mediaType) {
    if (typeof mediaUrl !== "string") return "";

    const dataUriMatch = mediaUrl.match(
        new RegExp(`^data:${mediaType}/([^;,]+)`, "i"),
    );
    if (dataUriMatch) return dataUriMatch[1].toLowerCase();

    const extensionFromPath = (value) => {
        const path = value.split("?")[0].split("#")[0];
        const filename = path.split("/").pop() || "";
        if (!filename.includes(".")) return "";
        return filename.split(".").pop().toLowerCase();
    };

    if (mediaUrl.startsWith("gs://")) {
        return extensionFromPath(mediaUrl);
    }

    try {
        const url = new URL(mediaUrl);
        return extensionFromPath(url.pathname);
    } catch {
        return extensionFromPath(mediaUrl);
    }
}

function getVeoImageMimeType(imageUrl) {
    const ext = getMediaExtension(imageUrl, "image");
    if (!ext) return "image/jpeg";

    const mimeType = VEO_IMAGE_MIME_TYPES[ext];
    if (!mimeType) {
        throw new Error(
            `Veo image references must be JPEG or PNG. Unsupported file extension: ${ext}.`,
        );
    }

    return mimeType;
}

function getVeoVideoMimeType(videoUrl) {
    const ext = getMediaExtension(videoUrl, "video");
    if (!ext) return "video/mp4";

    const mimeType = VEO_VIDEO_MIME_TYPES[ext];
    if (!mimeType) {
        throw new Error(
            `Veo video extension requires MP4 input. Unsupported file extension: ${ext}.`,
        );
    }

    return mimeType;
}

function formatImageForVeo(imageUrl) {
    if (!imageUrl) return "";

    const mimeType = getVeoImageMimeType(imageUrl);

    if (imageUrl.startsWith("gs://")) {
        return JSON.stringify({ gcsUri: imageUrl, mimeType });
    }

    try {
        const url = new URL(imageUrl);
        if (url.hostname === "storage.googleapis.com") {
            const gcsUri = `gs://${url.pathname.substring(1)}`;
            return JSON.stringify({ gcsUri, mimeType });
        }
    } catch {
        // Not a URL we can convert; pass through as-is
    }

    return imageUrl;
}

export function formatVideoForVeo(videoUrl) {
    if (!videoUrl) return "";
    if (typeof videoUrl !== "string") return JSON.stringify(videoUrl);

    const dataUriMatch = videoUrl.match(/^data:(video\/[^;,]+);base64,(.+)$/i);
    if (dataUriMatch) {
        return JSON.stringify({
            inlineData: {
                mimeType: dataUriMatch[1],
                data: dataUriMatch[2],
            },
        });
    }

    const mimeType = getVeoVideoMimeType(videoUrl);

    if (videoUrl.startsWith("gs://")) {
        return JSON.stringify({ gcsUri: videoUrl, mimeType });
    }

    try {
        const url = new URL(videoUrl);
        if (url.hostname === "storage.googleapis.com") {
            const gcsUri = `gs://${url.pathname.substring(1)}`;
            return JSON.stringify({ gcsUri, mimeType });
        }
    } catch {
        // Not a URL we can convert; pass through as-is
    }

    return videoUrl;
}

function formatReferenceImageForVeo(imageUrl) {
    if (!imageUrl) return null;
    const formatted = formatImageForVeo(imageUrl);
    let image;
    try {
        image =
            typeof formatted === "string" ? JSON.parse(formatted) : formatted;
    } catch {
        throw new Error(
            "Veo reference images must use gs:// or storage.googleapis.com URLs",
        );
    }
    return {
        image,
        referenceType: "asset",
    };
}

// gpt-image-2 size matrix. Azure /images/generations `size` constraints:
// both edges multiple of 16, max edge < 3840, total pixels in
// [655_360, 8_294_400], aspect ratio long:short ≤ 3:1. Outputs above
// 2560x1440 (3,686,400 px) are flagged "experimental" by the OpenAI image
// prompting cookbook, so 2K stays at or below that envelope; 4K pushes
// toward the hard limits (≤ 3824 edge, ≤ ~8.2M pixels).
const GPT_IMAGE_2_SIZES = {
    "1:1": { "1K": "1024x1024", "2K": "1920x1920", "4K": "2864x2864" },
    "16:9": { "1K": "1792x1008", "2K": "2560x1440", "4K": "3824x2144" },
    "9:16": { "1K": "1008x1792", "2K": "1440x2560", "4K": "2144x3824" },
    "4:3": { "1K": "1408x1056", "2K": "2048x1536", "4K": "3264x2448" },
    "3:4": { "1K": "1056x1408", "2K": "1536x2048", "4K": "2448x3264" },
};

// Map standardized inputImages / inputVideos arrays → pathway-specific parameters
export const PARAM_MAPPERS = {
    media_replicate(args, images, videos, audios = []) {
        return omitUndefined({
            text: args.text, model: args.model,
            inputImages: images, inputImageRoles: args.inputImageRoles?.map(normalizeReferenceRole),
            inputVideos: videos,
            inputAudio: audios.length ? audios : args.inputAudioUrl ? [args.inputAudioUrl] : [],
            aspectRatio: args.aspectRatio, duration: args.duration || undefined,
            resolution: args.resolution, size: args.imageSize || args.size,
            outputFormat: args.outputFormat, negativePrompt: args.negativePrompt,
            generateAudio: args.generateAudio, seed: args.seed,
            quality: args.quality, numberResults: args.numberResults,
            ...Object.fromEntries(Object.keys(priorityMediaParameters).map(key => [key, args[key]])),
        });
    },
    image_mai(args, images, videos = [], audios = []) {
        if (images.length > 1 || videos.length || audios.length) throw new Error("MAI accepts at most one image reference and no video or audio input");
        return omitUndefined({ text: args.text, model: args.model,
            input_image: images[0], size: args.imageSize || args.size,
            autoAspectRatio: args.autoAspectRatio, webGrounding: args.webGrounding });
    },
    image_gemini_25(args, images) {
        const mapped = {
            text: args.text,
            model: args.model,
            optimizePrompt: args.optimizePrompt,
        };
        for (let i = 0; i < Math.min(images.length, 3); i++) {
            mapped[i === 0 ? "input_image" : `input_image_${i + 1}`] =
                images[i];
        }
        return mapped;
    },

    image_gemini_31(args, images) {
        const mapped = {
            text: args.text,
            model: args.model,
            optimizePrompt: args.optimizePrompt,
            aspectRatio: args.aspectRatio,
            image_size: args.imageSize,
        };
        for (let i = 0; i < Math.min(images.length, 14); i++) {
            mapped[i === 0 ? "input_image" : `input_image_${i + 1}`] =
                images[i];
        }
        return mapped;
    },

    image_gemini_31_lite(args, images) {
        return PARAM_MAPPERS.image_gemini_31(args, images);
    },

    image_gemini_3(args, images) {
        // Same structure as gemini_31
        return PARAM_MAPPERS.image_gemini_31(args, images);
    },

    video_gemini_omni(args, images, videos, audios = []) {
        return omitUndefined({
            generationMode: args.generationMode,
            inputImageRoles: args.inputImageRoles?.map(normalizeReferenceRole),
            text: args.text,
            model: args.model,
            input_images: images,
            input_videos: videos,
            input_audios: audios,
            aspectRatio: args.aspectRatio,
            resolution: args.resolution,
            contextId: args.contextId,
        });
    },

    image_flux(args, images) {
        const mapped = {
            text: args.text,
            model: args.model,
            aspectRatio: args.aspectRatio || "1:1",
            resolution: args.resolution,
            output_format: args.outputFormat,
            output_quality: args.outputQuality,
            seed: args.seed,
        };
        // flux-2-pro uses input_images array; others use individual fields
        if (args.model === "replicate-flux-2-pro") {
            if (images.length > 0) mapped.input_images = images.slice(0, 8);
        } else {
            for (let i = 0; i < Math.min(images.length, 3); i++) {
                mapped[i === 0 ? "input_image" : `input_image_${i + 1}`] =
                    images[i];
            }
        }
        return mapped;
    },

    image_gpt_image_2(args, images) {
        const size =
            GPT_IMAGE_2_SIZES[args.aspectRatio || "1:1"]?.[
                args.imageSize || "1K"
            ] || GPT_IMAGE_2_SIZES["1:1"]["1K"];
        // Up to 10 input images route to the /images/edits endpoint.
        const inputImages = Object.fromEntries(
            images
                .slice(0, 10)
                .map((src, i) => [
                    i === 0 ? "input_image" : `input_image_${i + 1}`,
                    src,
                ]),
        );
        return {
            text: args.text,
            size,
            quality: args.quality || undefined,
            output_format: args.outputFormat || undefined,
            n: args.numberResults || undefined,
            ...inputImages,
        };
    },

    image_qwen(args, images) {
        const mapped = {
            text: args.text,
            model: args.model,
            aspectRatio: args.aspectRatio,
            output_format: args.outputFormat,
            output_quality: args.outputQuality,
            image_size: args.imageSize,
            numberResults: args.numberResults,
        };
        // Base model (replicate-qwen-image) is text-only; edit models accept images
        if (args.model !== "replicate-qwen-image") {
            for (let i = 0; i < Math.min(images.length, 3); i++) {
                mapped[i === 0 ? "input_image" : `input_image_${i + 1}`] =
                    images[i];
            }
        }
        return mapped;
    },

    image_seedream4(args, images) {
        return {
            text: args.text,
            model: args.model,
            size: args.size,
            width: args.width,
            height: args.height,
            aspectRatio: args.aspectRatio,
            maxImages: args.numberResults || 1,
            numberResults: args.numberResults || 1,
            input_image: images[0] || "",
            input_image_1: images[0] || "",
            input_image_2: images[1] || "",
            input_image_3: images[2] || "",
            seed: args.seed,
        };
    },

    image_seedream45(args, images) {
        return {
            text: args.text,
            model: args.model,
            size: args.size,
            aspectRatio: args.aspectRatio,
            maxImages: args.numberResults || 1,
            numberResults: args.numberResults || 1,
            input_image: images[0] || "",
            input_image_1: images[0] || "",
            input_image_2: images[1] || "",
            input_image_3: images[2] || "",
            disableSafetyChecker: args.disableSafetyChecker ?? false,
        };
    },

    image_seedream5lite(args, images) {
        return {
            text: args.text,
            model: args.model,
            size: args.size,
            aspectRatio: args.aspectRatio,
            maxImages: args.numberResults || 1,
            numberResults: args.numberResults || 1,
            input_image: images[0] || "",
            input_image_1: images[0] || "",
            input_image_2: images[1] || "",
            input_image_3: images[2] || "",
            outputFormat: args.outputFormat,
        };
    },

    video_veo(args, images, videos = []) {
        const roles = splitImageReferences(args, images);
        const startImage = roles.hasExplicitRoles
            ? roles.startFrames[0]
            : images[0];
        const endImage = roles.hasExplicitRoles ? roles.endFrames[0] : "";
        const referenceImages = roles.hasExplicitRoles
            ? roles.references
                  .slice(0, 3)
                  .map(formatReferenceImageForVeo)
                  .filter(Boolean)
            : [];

        return {
            text: args.text,
            model: args.model,
            image: formatImageForVeo(startImage),
            video: formatVideoForVeo(videos[0]),
            lastFrame: endImage ? formatImageForVeo(endImage) : "",
            referenceImages,
            aspectRatio: args.aspectRatio || "16:9",
            durationSeconds: args.duration || 8,
            enhancePrompt: args.enhancePrompt !== false,
            generateAudio: args.generateAudio ?? true,
            resolution: args.resolution || (videos[0] ? "720p" : undefined),
            negativePrompt: args.negativePrompt || "",
            personGeneration: "allow_all",
            sampleCount: 1,
            storageUri: "",
            location: "us-central1",
            seed: args.seed ?? -1,
        };
    },

    video_seedance(args, images, videos, audios = []) {
        const roles = splitImageReferences(args, images);
        if (SEEDANCE_2_MODELS.has(args.model)) {
            const mapped = {
                text: args.text,
                model: args.model,
                aspectRatio: args.aspectRatio || "16:9",
                duration: args.duration ?? 5,
                generate_audio: args.generateAudio ?? true,
                resolution: args.resolution,
                ...(Number.isInteger(args.seed) ? { seed: args.seed } : {}),
            };

            if (roles.hasExplicitRoles) {
                if (roles.startFrames[0]) mapped.image = roles.startFrames[0];
                if (roles.endFrames[0])
                    mapped.last_frame_image = roles.endFrames[0];
                if (roles.references.length > 0)
                    mapped.reference_images = roles.references.slice(0, 9);
                if (videos.length > 0)
                    mapped.reference_videos = videos.slice(0, 3);
            } else if (videos.length > 0 || images.length > 2) {
                if (images.length > 0)
                    mapped.reference_images = images.slice(0, 9);
                if (videos.length > 0)
                    mapped.reference_videos = videos.slice(0, 3);
            } else {
                mapped.image = images[0] || "";
                mapped.last_frame_image = images[1] || "";
            }

            if (audios.length > 0) {
                mapped.reference_audios = audios.slice(0, 3);
            }

            return mapped;
        }

        return {
            text: args.text,
            model: args.model,
            aspectRatio: args.aspectRatio || "16:9",
            duration: args.duration || 5,
            camera_fixed: args.cameraFixed ?? false,
            generate_audio: args.generateAudio ?? false,
            resolution: args.resolution,
            image: images[0] || "",
            seed: args.seed ?? -1,
        };
    },

    video_kling(args, images) {
        const roles = splitImageReferences(args, images);
        const startImage = roles.hasExplicitRoles
            ? roles.startFrames[0]
            : images[0];
        const endImage = roles.hasExplicitRoles
            ? roles.endFrames[0]
            : images[1];

        return {
            text: args.text,
            model: args.model,
            aspectRatio: args.aspectRatio || "16:9",
            duration: args.duration || 5,
            start_image: startImage || "",
            end_image: endImage || "",
            image: startImage || "",
            negativePrompt: args.negativePrompt || "",
        };
    },

    video_grok_imagine(args, images, videos) {
        const video = videos[0] || "";
        return {
            text: args.text,
            model: args.model,
            aspectRatio: args.aspectRatio || "auto",
            duration: args.duration || 5,
            resolution: args.resolution || "720p",
            image: images[0] || "",
            video,
        };
    },

    video_dreamactor(args, images, videos) {
        return {
            model: args.model,
            image: images[0] || "",
            video: videos[0] || "",
            cut_first_second: args.cutFirstSecond ?? true,
        };
    },

    video_avatar(args, images, videos, audios = []) {
        const audio =
            audios[0] || args.inputAudioUrl || args.audioUrl || args.audio;
        return {
            model: args.model,
            image: images[0] || "",
            audio: audio || "",
            ...(audio
                ? {}
                : {
                      voice: args.voice || "Zephyr (Female)",
                      voice_script:
                          args.voiceScript ||
                          args.voice_script ||
                          args.text ||
                          "",
                      voice_language:
                          args.voiceLanguage ||
                          args.voice_language ||
                          "English (US)",
                      voice_prompt:
                          args.voicePrompt ||
                          args.voice_prompt ||
                          "Say the following.",
                  }),
            resolution: args.resolution || "720p",
            video_prompt:
                args.videoPrompt ||
                args.video_prompt ||
                "The person is talking.",
            negative_prompt: args.negativePrompt || args.negative_prompt || "",
            strength_negative_prompt:
                args.strengthNegativePrompt ??
                args.strength_negative_prompt ??
                0.5,
            disable_safety_filter:
                args.disableSafetyFilter ?? args.disable_safety_filter ?? true,
            disable_prompt_upsampling:
                args.disablePromptUpsampling ??
                args.disable_prompt_upsampling ??
                false,
            no_op: args.noOp ?? args.no_op ?? false,
            ...(Number.isInteger(args.seed) ? { seed: args.seed } : {}),
        };
    },

    video_upscaler(args, images, videos) {
        const isTopazVideo = args.model === "replicate-topaz-video-upscale";
        return {
            model: args.model,
            video: videos[0] || "",
            ...(isTopazVideo
                ? {}
                : {
                      processing_type: args.processingType || "standard",
                      scene: args.scene || "aigc",
                  }),
            target_resolution:
                args.targetResolution || (isTopazVideo ? "1080p" : "4k"),
            target_fps: args.targetFps || (isTopazVideo ? 30 : 60),
        };
    },

    image_upscaler(args, images) {
        return {
            model: args.model,
            image: images[0] || "",
            enhance_model: args.enhanceModel || "Standard V2",
            upscale_factor: args.upscaleFactor || "None",
            output_format: args.outputFormat || "jpg",
            subject_detection: args.subjectDetection || "None",
            face_enhancement: args.faceEnhancement ?? false,
            face_enhancement_creativity: args.faceEnhancementCreativity ?? 0,
            face_enhancement_strength: args.faceEnhancementStrength ?? 0.8,
        };
    },

    music_lyria(args, images = []) {
        return {
            text: args.text,
            input_images: images.slice(0, 10),
            input_image: images[0] || "",
            contextId: args.contextId,
        };
    },

    music_lyria_pro(args, images = []) {
        return PARAM_MAPPERS.music_lyria(args, images);
    },

    music_lyria35(args, images = []) {
        if (images.length > 10) throw new Error("Lyria 3.5 supports at most 10 image inputs");
        return { ...PARAM_MAPPERS.music_lyria(args, images), audioFormat: args.audioFormat };
    },

    music_replicate(args) {
        const isElevenLabsMusic =
            !args.model || args.model === "replicate-elevenlabs-music";
        const isMiniMaxCover = args.model === "replicate-minimax-music-cover";
        const mapped = {
            text: args.text,
            model: args.model,
            inputAudioUrl: args.inputAudioUrl || args.audioUrl,
            lyrics: args.lyrics,
        };

        if (isElevenLabsMusic) {
            mapped.duration = args.duration || 10;
            mapped.outputFormat = args.outputFormat || "wav_cd_quality";
            mapped.forceInstrumental = args.forceInstrumental ?? true;
        }

        if (!isElevenLabsMusic && !isMiniMaxCover) {
            mapped.audioFormat = args.audioFormat;
            mapped.sampleRate = args.sampleRate;
            mapped.bitrate = args.bitrate;
            mapped.isInstrumental = args.isInstrumental;
            mapped.lyricsOptimizer = args.lyricsOptimizer;
        }

        return omitUndefined(mapped);
    },

    tts_gemini(args) {
        return omitUndefined({
            text: args.text,
            voiceName: args.voiceName,
            speaker1Name: args.speaker1Name,
            speaker1VoiceName: args.speaker1VoiceName,
            speaker2Name: args.speaker2Name,
            speaker2VoiceName: args.speaker2VoiceName,
        });
    },

    tts_replicate(args) {
        return omitUndefined({
            text: args.text,
            model: args.model,
            mode: args.mode,
            language: args.language,
            speaker: args.speaker,
            referenceAudio: args.referenceAudio,
            referenceAudioUrl: args.referenceAudioUrl,
            inputAudioUrl: args.inputAudioUrl || args.audioUrl,
            referenceText: args.referenceText,
            styleInstruction: args.styleInstruction,
            voiceDescription: args.voiceDescription,
            voice: args.voice,
            stability: args.stability,
            similarityBoost: args.similarityBoost,
            style: args.style,
            speed: args.speed,
            previousText: args.previousText,
            nextText: args.nextText,
            languageCode: args.languageCode,
            voiceId: args.voiceId,
            customVoiceId: args.customVoiceId,
            volume: args.volume,
            pitch: args.pitch,
            emotion: args.emotion,
            channel: args.channel,
            languageBoost: args.languageBoost,
            subtitleEnable: args.subtitleEnable,
            englishNormalization: args.englishNormalization,
            audioFormat: args.audioFormat,
            sampleRate: args.sampleRate,
            bitrate: args.bitrate,
        });
    },
};

// Convert gs:// URI to HTTPS URL
function convertGcsToHttp(gcsUri) {
    return gcsUri.replace("gs://", "https://storage.googleapis.com/");
}

// Extract video URL from Veo response structures
function extractVideoUrl(video) {
    if (video.bytesBase64Encoded) {
        return `data:video/mp4;base64,${video.bytesBase64Encoded}`;
    }
    if (video.gcsUri) {
        return convertGcsToHttp(video.gcsUri);
    }
    return null;
}

// Normalize Veo video response → clean URL
function normalizeVeoResponse(rawResult) {
    let parsed;
    try {
        parsed =
            typeof rawResult === "string" ? JSON.parse(rawResult) : rawResult;
    } catch {
        return rawResult; // Not JSON — return as-is
    }

    // Try multiple known response shapes
    const candidates = [
        parsed?.response?.videos?.[0],
        parsed?.result?.response?.videos?.[0],
        parsed?.videos?.[0],
    ].filter(Boolean);

    for (const video of candidates) {
        const url = extractVideoUrl(video);
        if (url) return url;
    }

    // Check for direct gcsUri or url
    if (parsed?.gcsUri) return convertGcsToHttp(parsed.gcsUri);
    if (parsed?.url) return parsed.url;

    return rawResult; // Can't normalize — pass through
}

// Normalize Gemini image response → cloud URL (never a data: URI).
// Publishing multi-MB data URIs on Redis requestProgress correlates with
// fleet-wide pub/sub reconnects and Media-page idle timeouts (ARC-2892).
export async function normalizeGeminiResponse(
    rawResult,
    resolver,
    args = {},
    uploadFn = uploadImageToCloud,
) {
    const artifacts = resolver?.pathwayResultData?.artifacts;
    if (!Array.isArray(artifacts)) {
        return rawResult;
    }
    const imageArtifact = artifacts.find((a) => a.type === "image");
    if (!imageArtifact?.data) {
        return rawResult;
    }

    const mimeType = imageArtifact.mimeType || "image/png";
    const { url, uploadResult } = await uploadBase64ImageToCloud(
        imageArtifact.data,
        mimeType,
        resolver,
        args,
        uploadFn,
    );

    imageArtifact.url = url;
    if (uploadResult?.gcs) imageArtifact.gcs = uploadResult.gcs;
    if (uploadResult?.hash) imageArtifact.hash = uploadResult.hash;
    delete imageArtifact.data;
    stripArtifactBinaryData(resolver);

    return url;
}

export async function normalizeMediaArtifactResponse(rawResult, resolver, type, fallbackMimeType, args = {}, uploadFn = uploadImageToCloud) {
    const artifacts = resolver?.pathwayResultData?.artifacts;
    if (Array.isArray(artifacts)) {
        const output = [];
        for (const [index, artifact] of artifacts.filter(a => a.type === type).entries()) {
            if (artifact.data) {
                const mimeType = artifact.mimeType || fallbackMimeType;
                const filename = promptToFilename(args.text || "generated-media", mimeType.split("/")[1], { index });
                const uploaded = await uploadFn(artifact.data, mimeType, resolver,
                    args.contextId ? buildFileLocation(args.contextId) : null, filename);
                artifact.url = uploaded?.url || uploaded;
                if (typeof artifact.url !== "string" || !artifact.url) throw new Error("Generated media upload returned no URL");
                delete artifact.data;
            }
            if (artifact.url) output.push({ url: artifact.url, type, mimeType: artifact.mimeType || fallbackMimeType });
        }
        stripArtifactBinaryData(resolver);
        if (output.length === 1) return output[0].url;
        if (output.length > 1) return JSON.stringify({ output });
    }
    return rawResult;
}

// Normalize Azure OpenAI image responses ({data:[{url|b64_json}]}) → URL.
// Upload b64 payloads so Redis progress never carries multi-MB data URIs.
export async function normalizeOpenAIImageResponse(
    rawResult,
    resolver = null,
    args = {},
    uploadFn = uploadImageToCloud,
) {
    let parsed;
    try {
        parsed =
            typeof rawResult === "string" ? JSON.parse(rawResult) : rawResult;
    } catch {
        return rawResult; // Not JSON — pass through
    }

    const first = Array.isArray(parsed?.data) ? parsed.data[0] : null;
    if (!first) return rawResult;

    if (first.url) return first.url;
    if (first.b64_json) {
        const mime = `image/${parsed.output_format || "png"}`;
        const { url } = await uploadBase64ImageToCloud(
            first.b64_json,
            mime,
            resolver,
            args,
            uploadFn,
        );
        stripArtifactBinaryData(resolver);
        return url;
    }
    return rawResult;
}

function normalizeAudioResponse(rawResult, resolver) {
    const artifacts = resolver?.pathwayResultData?.artifacts;
    if (Array.isArray(artifacts)) {
        const audioArtifact = artifacts.find((a) => a.type === "audio");
        if (audioArtifact?.data) {
            return `data:${audioArtifact.mimeType || "audio/mpeg"};base64,${audioArtifact.data}`;
        }
        if (audioArtifact?.url) {
            return audioArtifact.url;
        }
    }

    return rawResult;
}

// Lyria 3.5 may interleave several audio and lyric blocks. Keep every audio
// block, upload binary data before publishing progress, and retain the lyrics.
export async function normalizeLyria35Response(rawResult, resolver, args = {}, uploadFn = uploadImageToCloud) {
    const artifacts = resolver?.pathwayResultData?.artifacts || [];
    const output = [];
    for (const [index, artifact] of artifacts.filter(item => item.type === "audio").entries()) {
        if (artifact.data) {
            const filename = promptToFilename(args.text || "generated-music", artifact.mimeType === "audio/wav" ? "wav" : "mp3", { index });
            const uploaded = await uploadFn(artifact.data, artifact.mimeType || "audio/mpeg", resolver,
                args.contextId ? buildFileLocation(args.contextId) : null, filename);
            artifact.url = uploaded?.url || uploaded;
            if (typeof artifact.url !== "string" || !artifact.url) throw new Error("Lyria audio upload returned no URL");
            delete artifact.data;
        }
        if (artifact.url) output.push({ url: artifact.url, type: "audio", mimeType: artifact.mimeType });
    }
    if (!output.length) throw new Error("Lyria 3.5 returned no audio");
    stripArtifactBinaryData(resolver);
    return JSON.stringify({ output, lyrics: typeof rawResult === "string" ? rawResult : "" });
}

export default {
    prompt: [],
    inputParameters: {
        ...priorityMediaParameters,
        model: "",
        text: "",
        inputImages: { type: "array", items: { type: "string" } },
        inputImageRoles: { type: "array", items: { type: "string" } },
        inputVideos: { type: "array", items: { type: "string" } },
        inputAudio: { type: "array", items: { type: "string" } },
        processingType: "",
        scene: "",
        targetResolution: "",
        targetFps: 0,
        enhanceModel: "",
        upscaleFactor: "",
        subjectDetection: "",
        faceEnhancement: false,
        faceEnhancementCreativity: 0,
        faceEnhancementStrength: 0.8,
        aspectRatio: "",
        duration: 0,
        outputFormat: "",
        outputQuality: 0,
        forceInstrumental: true,
        inputAudioUrl: "",
        audioUrl: "",
        audio: "",
        audioFormat: "",
        sampleRate: 0,
        bitrate: 0,
        lyrics: "",
        isInstrumental: false,
        lyricsOptimizer: false,
        voiceName: "",
        speaker1Name: "",
        speaker1VoiceName: "",
        speaker2Name: "",
        speaker2VoiceName: "",
        mode: "",
        language: "",
        speaker: "",
        referenceAudio: "",
        referenceAudioUrl: "",
        referenceText: "",
        styleInstruction: "",
        voiceDescription: "",
        voice: { type: "string" },
        voiceScript: { type: "string" },
        voiceLanguage: { type: "string" },
        voicePrompt: { type: "string" },
        videoPrompt: { type: "string" },
        stability: { type: "number" },
        similarityBoost: { type: "number" },
        style: { type: "number" },
        speed: { type: "number" },
        previousText: { type: "string" },
        nextText: { type: "string" },
        languageCode: { type: "string" },
        voiceId: { type: "string" },
        customVoiceId: { type: "string" },
        volume: { type: "number" },
        pitch: { type: "integer" },
        emotion: { type: "string" },
        channel: { type: "string" },
        languageBoost: { type: "string" },
        subtitleEnable: { type: "boolean" },
        englishNormalization: { type: "boolean" },
        quality: "",
        negativePrompt: "",
        numberResults: 1,
        seed: -1,
        disableSafetyChecker: false,
        optimizePrompt: false,
        generateAudio: { type: "boolean" },
        cutFirstSecond: true,
        noOp: false,
        strengthNegativePrompt: 0.5,
        disableSafetyFilter: true,
        disablePromptUpsampling: false,
        resolution: "",
        cameraFixed: false,
        enhancePrompt: true,
        imageSize: "",
        width: 0,
        height: 0,
        size: "",
        contextId: "",
        async: false,
    },
    model: "oai-gpt4o", // placeholder — executePathway delegates to sub-pathways
    timeout: 60 * 35,

    executePathway: async ({ args, resolver }) => {
        const modelId = args.model;
        if (!modelId) {
            throw new Error("media_generate requires a model parameter");
        }

        // Look up model config to find the target pathway
        const allModels = config.get("models");
        const modelConfig = allModels[modelId];
        if (!modelConfig?.metadata?.pathwayName) {
            throw new Error(
                `Model '${modelId}' not found or has no pathwayName in metadata`,
            );
        }

        const pathwayName = modelConfig.metadata.pathwayName;
        if (modelConfig.metadata.isAvailable === false) {
            throw new Error(modelConfig.metadata.unavailableReason || `Model '${modelId}' is not available`);
        }
        const mapper = PARAM_MAPPERS[pathwayName];
        if (!mapper) {
            throw new Error(`No parameter mapper for pathway '${pathwayName}'`);
        }
        validateReferenceRoles(args, modelId, modelConfig.metadata);

        // Build pathway-specific parameters from standardized inputs
        const inputImages = (args.inputImages || []).filter(Boolean);
        const inputVideos = (args.inputVideos || []).filter(Boolean);
        const inputAudio = (args.inputAudio || args.inputAudios || []).filter(
            Boolean,
        );
        const mappedArgs = mapper(args, inputImages, inputVideos, inputAudio);

        const uploadsGeneratedArtifact = pathwayName.startsWith("image_gemini") ||
            ["image_gpt_image_2", "video_gemini_omni", "music_lyria35"].includes(pathwayName);
        if (uploadsGeneratedArtifact && !args.contextId) {
            const error = new Error("media_generate requires a storage contextId for this model");
            error.code = "MEDIA_STORAGE_CONTEXT_REQUIRED";
            error.status = 400;
            throw error;
        }

        // Note: do NOT propagate async to sub-pathways. The parent
        // media_generate is already async (callers subscribe to its requestId).
        // Sub-pathways must run synchronously here so their results can be
        // normalized (e.g. Veo JSON → data: URI) before being published.

        // Call the sub-pathway
        const maxRetries = pathwayName.startsWith("image_gemini") ? 3 : 0;
        let result = null;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            let generationCompleted = false;
            try {
                result = await callPathway(pathwayName, mappedArgs, resolver);
                generationCompleted = true;

                // For Gemini pathways: upload artifacts and return a cloud URL
                if (pathwayName.startsWith("image_gemini")) {
                    const normalized = await normalizeGeminiResponse(
                        result,
                        resolver,
                        args,
                    );
                    if (normalized !== result) {
                        return normalized; // Got a cloud URL
                    }
                    // No artifacts — retry if we have attempts left
                    if (attempt < maxRetries) {
                        const delay = Math.pow(2, attempt) * 1000;
                        logger.warn(
                            `Gemini returned no artifacts, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`,
                        );
                        await new Promise((r) => setTimeout(r, delay));
                        continue;
                    }
                    return result; // No artifacts after all retries
                }

                // Normalize Veo responses
                if (pathwayName === "video_veo") {
                    return normalizeVeoResponse(result);
                }

                if (pathwayName === "video_gemini_omni") {
                    return normalizeMediaArtifactResponse(
                        result,
                        resolver,
                        "video",
                        "video/mp4",
                        args,
                    );
                }

                // Normalize Azure OpenAI image responses (gpt-image-2, DALL-E 3, …)
                if (["image_gpt_image_2", "image_mai"].includes(pathwayName)) {
                    return await normalizeOpenAIImageResponse(
                        result,
                        resolver,
                        args,
                    );
                }

                if (pathwayName === "music_lyria35") {
                    return normalizeLyria35Response(result, resolver, args);
                }

                if (
                    pathwayName.startsWith("music_") ||
                    pathwayName.startsWith("tts_") ||
                    (pathwayName === "media_replicate" && modelConfig.metadata.category === "audio")
                ) {
                    return normalizeAudioResponse(result, resolver);
                }

                // Standard pathways (Flux, Qwen, Seedream4, Seedance) return URLs directly
                return result;
            } catch (error) {
                // Generation already succeeded. Retrying an upload failure by
                // regenerating the artifact wastes provider calls and charges.
                if (generationCompleted) throw error;
                if (attempt < maxRetries) {
                    const delay = Math.pow(2, attempt) * 1000;
                    logger.warn(
                        `media_generate attempt ${attempt + 1} failed, retrying: ${error.message}`,
                    );
                    await new Promise((r) => setTimeout(r, delay));
                    continue;
                }
                throw error;
            }
        }

        return result;
    },
};
