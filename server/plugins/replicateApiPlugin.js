// replicateApiPlugin.js
import ModelPlugin from "./modelPlugin.js";
import CortexResponse from "../../lib/cortexResponse.js";
import logger from "../../lib/logger.js";
import axios from "axios";
import mime from "mime-types";

// Helper function to collect images from various parameter sources
const collectImages = (candidate, accumulator) => {
    if (!candidate) return;
    if (Array.isArray(candidate)) {
        candidate.forEach((item) => collectImages(item, accumulator));
        return;
    }
    accumulator.push(candidate);
};

// Helper function to normalize image entries to strings
const normalizeImageEntry = (entry) => {
    if (!entry) return null;
    if (typeof entry === "string") {
        return entry;
    }
    if (typeof entry === "object") {
        if (Array.isArray(entry)) {
            return null;
        }
        if (entry.value) {
            return entry.value;
        }
        if (entry.url) {
            return entry.url;
        }
        if (entry.path) {
            return entry.path;
        }
    }
    return null;
};

// Helper function to omit undefined/null values from an object
const omitUndefined = (obj) =>
    Object.fromEntries(
        Object.entries(obj).filter(
            ([, value]) => value !== undefined && value !== null,
        ),
    );

const clampNumber = (value, min, max, fallback) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, numeric));
};

const normalizeElevenLabsMusicOutputFormat = (format) => {
    const aliases = {
        mp3: "mp3_high_quality",
        wav: "wav_cd_quality",
    };
    const supported = new Set([
        "mp3_standard",
        "mp3_high_quality",
        "wav_16khz",
        "wav_22khz",
        "wav_24khz",
        "wav_cd_quality",
    ]);
    const normalized = aliases[format] || format || "wav_cd_quality";
    return supported.has(normalized) ? normalized : "wav_cd_quality";
};

const normalizeEnumValue = (value, supported, fallback) =>
    supported.includes(value) ? value : fallback;

const normalizeNumberEnumValue = (value, supported, fallback) => {
    const numeric = Number(value);
    return supported.includes(numeric) ? numeric : fallback;
};

const getFirstDefined = (...values) =>
    values.find(
        (value) => value !== undefined && value !== null && value !== "",
    );

const isArtifactUrl = (value) =>
    typeof value === "string" &&
    /^(https?:\/\/|data:(image|video|audio)\/)/i.test(value);

const buildMinimaxMusicAudioControls = (combinedParameters) => ({
    bitrate: normalizeNumberEnumValue(
        combinedParameters.bitrate,
        [32000, 64000, 128000, 256000],
        256000,
    ),
    sample_rate: normalizeNumberEnumValue(
        combinedParameters.sample_rate ?? combinedParameters.sampleRate,
        [16000, 24000, 32000, 44100],
        44100,
    ),
    audio_format: normalizeEnumValue(
        combinedParameters.audio_format ??
            combinedParameters.audioFormat ??
            combinedParameters.outputFormat,
        ["mp3", "wav", "pcm"],
        "wav",
    ),
});

const QWEN3_TTS_MODES = ["custom_voice", "voice_clone", "voice_design"];
const QWEN3_TTS_LANGUAGES = [
    "auto",
    "Chinese",
    "English",
    "Japanese",
    "Korean",
    "French",
    "German",
    "Italian",
    "Spanish",
    "Portuguese",
    "Russian",
];
const QWEN3_TTS_SPEAKERS = [
    "Aiden",
    "Dylan",
    "Eric",
    "Ono_anna",
    "Ryan",
    "Serena",
    "Sohee",
    "Uncle_fu",
    "Vivian",
];
const P_VIDEO_AVATAR_VOICES = [
    "Zephyr (Female)",
    "Puck (Male)",
    "Charon (Male)",
    "Kore (Female)",
    "Fenrir (Male)",
    "Leda (Female)",
    "Orus (Male)",
    "Aoede (Female)",
    "Callirrhoe (Female)",
    "Autonoe (Female)",
    "Enceladus (Male)",
    "Iapetus (Male)",
    "Umbriel (Male)",
    "Algenib (Male)",
    "Despina (Female)",
    "Erinome (Female)",
    "Laomedeia (Female)",
    "Achernar (Female)",
    "Algieba (Male)",
    "Schedar (Male)",
    "Gacrux (Female)",
    "Pulcherrima (Female)",
    "Achird (Male)",
    "Zubenelgenubi (Male)",
    "Vindemiatrix (Female)",
    "Sadachbia (Male)",
    "Sadaltager (Male)",
    "Sulafat (Female)",
    "Alnilam (Male)",
    "Rasalgethi (Male)",
];
const P_VIDEO_AVATAR_LANGUAGES = [
    "English (US)",
    "English (UK)",
    "Spanish",
    "French",
    "German",
    "Italian",
    "Portuguese (Brazil)",
    "Japanese",
    "Korean",
    "Hindi",
];
const ELEVENLABS_V3_VOICES = [
    "Rachel",
    "Drew",
    "Clyde",
    "Paul",
    "Aria",
    "Domi",
    "Dave",
    "Roger",
    "Fin",
    "Sarah",
    "James",
    "Jane",
    "Juniper",
    "Arabella",
    "Hope",
    "Bradford",
    "Reginald",
    "Gaming",
    "Austin",
    "Kuon",
    "Blondie",
    "Priyanka",
    "Alexandra",
    "Monika",
    "Mark",
    "Grimblewood",
];
const MINIMAX_TTS_EMOTIONS = [
    "auto",
    "happy",
    "sad",
    "angry",
    "fearful",
    "disgusted",
    "surprised",
    "calm",
    "fluent",
    "neutral",
];
const MINIMAX_TTS_SAMPLE_RATES = [8000, 16000, 22050, 24000, 32000, 44100];
const MINIMAX_TTS_AUDIO_FORMATS = ["mp3", "wav", "flac", "pcm"];
const MINIMAX_TTS_BITRATES = [32000, 64000, 128000, 256000];
const MINIMAX_TTS_CHANNELS = ["mono", "stereo"];
const MINIMAX_TTS_LANGUAGE_BOOSTS = [
    "None",
    "Automatic",
    "Chinese",
    "Chinese,Yue",
    "Cantonese",
    "English",
    "Arabic",
    "Russian",
    "Spanish",
    "French",
    "Portuguese",
    "German",
    "Turkish",
    "Dutch",
    "Ukrainian",
    "Vietnamese",
    "Indonesian",
    "Japanese",
    "Italian",
    "Korean",
    "Thai",
    "Polish",
    "Romanian",
    "Greek",
    "Czech",
    "Finnish",
    "Hindi",
    "Bulgarian",
    "Danish",
    "Hebrew",
    "Malay",
    "Persian",
    "Slovak",
    "Swedish",
    "Croatian",
    "Filipino",
    "Hungarian",
    "Norwegian",
    "Slovenian",
    "Catalan",
    "Nynorsk",
    "Tamil",
    "Afrikaans",
];

// Helper function to collect and normalize images from combined parameters
const collectNormalizedImages = (combinedParameters, additionalFields = []) => {
    const imageCandidates = [];
    const defaultFields = [
        "image",
        "images",
        "input_image",
        "input_images",
        "input_image_1",
        "input_image_2",
        "input_image_3",
        "image_1",
        "image_2",
    ];
    const allFields = [...defaultFields, ...additionalFields];

    allFields.forEach((field) => {
        collectImages(combinedParameters[field], imageCandidates);
    });

    return imageCandidates
        .map((candidate) => normalizeImageEntry(candidate))
        .filter((candidate) => candidate && typeof candidate === "string");
};

class ReplicateApiPlugin extends ModelPlugin {
    constructor(pathway, model) {
        super(pathway, model);
    }

    // Set up parameters specific to the Replicate API
    getRequestParameters(text, parameters, prompt) {
        const combinedParameters = { ...this.promptParameters, ...parameters };
        this.lastCombinedParameters = combinedParameters;
        const { modelPromptText } = this.getCompiledPrompt(
            text,
            parameters,
            prompt,
        );

        let requestParameters = {};

        switch (combinedParameters.model) {
            case "replicate-flux-11-pro":
                requestParameters = {
                    input: {
                        aspect_ratio: combinedParameters.aspectRatio || "1:1",
                        output_format:
                            combinedParameters.outputFormat || "webp",
                        output_quality: combinedParameters.outputQuality || 80,
                        prompt: modelPromptText,
                        prompt_upsampling:
                            combinedParameters.promptUpsampling || false,
                        safety_tolerance:
                            combinedParameters.safety_tolerance || 3,
                        go_fast: true,
                        megapixels: "1",
                        width: combinedParameters.width,
                        height: combinedParameters.height,
                        size: combinedParameters.size || "1024x1024",
                        style: combinedParameters.style || "realistic_image",
                        ...(combinedParameters.seed &&
                        Number.isInteger(combinedParameters.seed)
                            ? { seed: combinedParameters.seed }
                            : {}),
                    },
                };
                break;
            case "replicate-recraft-v3": {
                const validStyles = [
                    "any",
                    "realistic_image",
                    "digital_illustration",
                    "digital_illustration/pixel_art",
                    "digital_illustration/hand_drawn",
                    "digital_illustration/grain",
                    "digital_illustration/infantile_sketch",
                    "digital_illustration/2d_art_poster",
                    "digital_illustration/handmade_3d",
                    "digital_illustration/hand_drawn_outline",
                    "digital_illustration/engraving_color",
                    "digital_illustration/2d_art_poster_2",
                    "realistic_image/b_and_w",
                    "realistic_image/hard_flash",
                    "realistic_image/hdr",
                    "realistic_image/natural_light",
                    "realistic_image/studio_portrait",
                    "realistic_image/enterprise",
                    "realistic_image/motion_blur",
                ];

                requestParameters = {
                    input: {
                        prompt: modelPromptText,
                        size: combinedParameters.size || "1024x1024",
                        style: validStyles.includes(combinedParameters.style)
                            ? combinedParameters.style
                            : "realistic_image",
                    },
                };
                break;
            }
            case "replicate-flux-1-schnell": {
                const validRatios = [
                    "1:1",
                    "16:9",
                    "21:9",
                    "3:2",
                    "2:3",
                    "4:5",
                    "5:4",
                    "3:4",
                    "4:3",
                    "9:16",
                    "9:21",
                ];

                requestParameters = {
                    input: {
                        aspect_ratio: validRatios.includes(
                            combinedParameters.aspectRatio,
                        )
                            ? combinedParameters.aspectRatio
                            : "1:1",
                        output_format:
                            combinedParameters.outputFormat || "webp",
                        output_quality: combinedParameters.outputQuality || 80,
                        prompt: modelPromptText,
                        go_fast: true,
                        megapixels: "1",
                        num_outputs: combinedParameters.numberResults,
                        num_inference_steps: combinedParameters.steps || 4,
                        disable_safety_checker: true,
                    },
                };
                break;
            }
            case "replicate-qwen-image": {
                const aspectRatio =
                    combinedParameters.aspect_ratio ??
                    combinedParameters.aspectRatio ??
                    "16:9";
                const imageSize =
                    combinedParameters.image_size ??
                    combinedParameters.imageSize ??
                    "optimize_for_quality";
                const outputFormat =
                    combinedParameters.output_format ??
                    combinedParameters.outputFormat ??
                    "webp";
                const outputQuality =
                    combinedParameters.output_quality ??
                    combinedParameters.outputQuality ??
                    80;
                const loraScale =
                    combinedParameters.lora_scale ??
                    combinedParameters.loraScale ??
                    1;
                const enhancePrompt =
                    combinedParameters.enhance_prompt ??
                    combinedParameters.enhancePrompt ??
                    false;
                const negativePrompt =
                    combinedParameters.negative_prompt ??
                    combinedParameters.negativePrompt ??
                    " ";
                const numInferenceSteps =
                    combinedParameters.num_inference_steps ??
                    combinedParameters.steps ??
                    50;
                const goFast =
                    combinedParameters.go_fast ??
                    combinedParameters.goFast ??
                    true;
                const guidance = combinedParameters.guidance ?? 4;
                const strength = combinedParameters.strength ?? 0.9;
                const numOutputs =
                    combinedParameters.num_outputs ??
                    combinedParameters.numberResults;
                const disableSafetyChecker =
                    combinedParameters.disable_safety_checker ??
                    combinedParameters.disableSafetyChecker ??
                    false;

                requestParameters = {
                    input: {
                        prompt: modelPromptText,
                        go_fast: goFast,
                        guidance,
                        strength,
                        image_size: imageSize,
                        lora_scale: loraScale,
                        aspect_ratio: aspectRatio,
                        output_format: outputFormat,
                        enhance_prompt: enhancePrompt,
                        output_quality: outputQuality,
                        negative_prompt: negativePrompt,
                        num_inference_steps: numInferenceSteps,
                        disable_safety_checker: disableSafetyChecker,
                        ...(numOutputs ? { num_outputs: numOutputs } : {}),
                        ...(combinedParameters.seed &&
                        Number.isInteger(combinedParameters.seed)
                            ? { seed: combinedParameters.seed }
                            : {}),
                        ...(combinedParameters.image
                            ? { image: combinedParameters.image }
                            : {}),
                        ...(combinedParameters.input_image
                            ? { input_image: combinedParameters.input_image }
                            : {}),
                    },
                };
                break;
            }
            case "replicate-qwen-image-edit-plus": {
                const aspectRatio =
                    combinedParameters.aspect_ratio ??
                    combinedParameters.aspectRatio ??
                    "match_input_image";
                const outputFormat =
                    combinedParameters.output_format ??
                    combinedParameters.outputFormat ??
                    "webp";
                const outputQuality =
                    combinedParameters.output_quality ??
                    combinedParameters.outputQuality ??
                    95;
                const goFast =
                    combinedParameters.go_fast ??
                    combinedParameters.goFast ??
                    true;
                const disableSafetyChecker =
                    combinedParameters.disable_safety_checker ??
                    combinedParameters.disableSafetyChecker ??
                    false;

                const normalizedImages =
                    collectNormalizedImages(combinedParameters);

                const basePayload = omitUndefined({
                    prompt: modelPromptText,
                    go_fast: goFast,
                    aspect_ratio: aspectRatio,
                    output_format: outputFormat,
                    output_quality: outputQuality,
                    disable_safety_checker: disableSafetyChecker,
                });

                // For qwen-image-edit-plus, always include the image array if we have images
                const inputPayload = {
                    ...basePayload,
                    ...(normalizedImages.length > 0
                        ? { image: normalizedImages }
                        : {}),
                };

                requestParameters = {
                    input: inputPayload,
                };
                break;
            }
            case "replicate-qwen-image-edit-2511": {
                const validRatios = [
                    "1:1",
                    "16:9",
                    "9:16",
                    "4:3",
                    "3:4",
                    "match_input_image",
                ];
                const validOutputFormats = ["webp", "jpg", "png"];

                const aspectRatio = validRatios.includes(
                    combinedParameters.aspect_ratio ??
                        combinedParameters.aspectRatio,
                )
                    ? (combinedParameters.aspect_ratio ??
                      combinedParameters.aspectRatio)
                    : "match_input_image";
                const outputFormat = validOutputFormats.includes(
                    combinedParameters.output_format ??
                        combinedParameters.outputFormat,
                )
                    ? (combinedParameters.output_format ??
                      combinedParameters.outputFormat)
                    : "webp";
                const outputQuality =
                    combinedParameters.output_quality ??
                    combinedParameters.outputQuality ??
                    95;
                const goFast =
                    combinedParameters.go_fast ??
                    combinedParameters.goFast ??
                    true;
                const disableSafetyChecker =
                    combinedParameters.disable_safety_checker ??
                    combinedParameters.disableSafetyChecker ??
                    false;

                const normalizedImages =
                    collectNormalizedImages(combinedParameters);

                const basePayload = omitUndefined({
                    prompt: modelPromptText,
                    go_fast: goFast,
                    aspect_ratio: aspectRatio,
                    output_format: outputFormat,
                    output_quality: Math.max(0, Math.min(100, outputQuality)),
                    disable_safety_checker: disableSafetyChecker,
                    ...(Number.isInteger(combinedParameters.seed) &&
                    combinedParameters.seed > 0
                        ? { seed: combinedParameters.seed }
                        : {}),
                });

                // For qwen-image-edit-2511, format images as array of strings (not objects)
                const inputPayload = {
                    ...basePayload,
                    ...(normalizedImages.length > 0
                        ? { image: normalizedImages }
                        : {}),
                };

                requestParameters = {
                    input: inputPayload,
                };
                break;
            }
            case "replicate-flux-kontext-pro":
            case "replicate-flux-kontext-max": {
                const validRatios = [
                    "1:1",
                    "16:9",
                    "21:9",
                    "3:2",
                    "2:3",
                    "4:5",
                    "5:4",
                    "3:4",
                    "4:3",
                    "9:16",
                    "9:21",
                    "match_input_image",
                ];

                let safetyTolerance = combinedParameters.safety_tolerance || 3;
                if (combinedParameters.input_image) {
                    safetyTolerance = Math.min(safetyTolerance, 2);
                }

                requestParameters = {
                    input: {
                        prompt: modelPromptText,
                        input_image: combinedParameters.input_image,
                        aspect_ratio: validRatios.includes(
                            combinedParameters.aspectRatio,
                        )
                            ? combinedParameters.aspectRatio
                            : "1:1",
                        safety_tolerance: safetyTolerance,
                        ...(combinedParameters.seed &&
                        Number.isInteger(combinedParameters.seed) &&
                        combinedParameters.seed > 0
                            ? { seed: combinedParameters.seed }
                            : {}),
                    },
                };
                break;
            }
            case "replicate-multi-image-kontext-max": {
                const validRatios = [
                    "1:1",
                    "16:9",
                    "21:9",
                    "3:2",
                    "2:3",
                    "4:5",
                    "5:4",
                    "3:4",
                    "4:3",
                    "9:16",
                    "9:21",
                    "match_input_image",
                ];

                let safetyTolerance = combinedParameters.safety_tolerance || 3;
                if (
                    combinedParameters.input_image_1 ||
                    combinedParameters.input_image
                ) {
                    safetyTolerance = Math.min(safetyTolerance, 2);
                }

                requestParameters = {
                    input: {
                        prompt: modelPromptText,
                        input_image_1:
                            combinedParameters.input_image_1 ||
                            combinedParameters.input_image,
                        input_image_2: combinedParameters.input_image_2,
                        aspect_ratio: validRatios.includes(
                            combinedParameters.aspectRatio,
                        )
                            ? combinedParameters.aspectRatio
                            : "1:1",
                        safety_tolerance: safetyTolerance,
                        ...(combinedParameters.seed &&
                        Number.isInteger(combinedParameters.seed) &&
                        combinedParameters.seed > 0
                            ? { seed: combinedParameters.seed }
                            : {}),
                    },
                };
                break;
            }
            case "replicate-seedance-1-pro": {
                const validResolutions = ["480p", "1080p"];
                const validRatios = [
                    "16:9",
                    "4:3",
                    "9:16",
                    "1:1",
                    "3:4",
                    "21:9",
                    "9:21",
                ];
                const validFps = [24];

                requestParameters = {
                    input: {
                        prompt: modelPromptText,
                        resolution: validResolutions.includes(
                            combinedParameters.resolution,
                        )
                            ? combinedParameters.resolution
                            : "1080p",
                        aspect_ratio: validRatios.includes(
                            combinedParameters.aspectRatio,
                        )
                            ? combinedParameters.aspectRatio
                            : "16:9",
                        ...(combinedParameters.seed &&
                        Number.isInteger(combinedParameters.seed) &&
                        combinedParameters.seed > 0
                            ? { seed: combinedParameters.seed }
                            : {}),
                        fps: validFps.includes(combinedParameters.fps)
                            ? combinedParameters.fps
                            : 24,
                        camera_fixed: combinedParameters.camera_fixed || false,
                        duration: combinedParameters.duration || 5,
                        ...(combinedParameters.image
                            ? { image: combinedParameters.image }
                            : {}),
                    },
                };
                break;
            }
            case "replicate-seedance-1.5-pro": {
                const validRatios = [
                    "16:9",
                    "4:3",
                    "1:1",
                    "3:4",
                    "9:16",
                    "21:9",
                    "9:21",
                ];

                requestParameters = {
                    input: {
                        prompt: modelPromptText,
                        aspect_ratio: validRatios.includes(
                            combinedParameters.aspectRatio,
                        )
                            ? combinedParameters.aspectRatio
                            : "16:9",
                        duration: Math.min(
                            12,
                            Math.max(2, combinedParameters.duration || 5),
                        ),
                        fps: 24,
                        camera_fixed: combinedParameters.camera_fixed || false,
                        generate_audio:
                            combinedParameters.generate_audio || false,
                        ...(combinedParameters.seed &&
                        Number.isInteger(combinedParameters.seed) &&
                        combinedParameters.seed > 0
                            ? { seed: combinedParameters.seed }
                            : {}),
                        ...(combinedParameters.image
                            ? { image: combinedParameters.image }
                            : {}),
                        ...(combinedParameters.image &&
                        combinedParameters.last_frame_image
                            ? {
                                  last_frame_image:
                                      combinedParameters.last_frame_image,
                              }
                            : {}),
                    },
                };
                break;
            }
            case "replicate-seedance-2.0":
            case "replicate-seedance-2.0-fast":
            case "replicate-seedance-2.0-mini": {
                const validResolutions =
                    combinedParameters.model === "replicate-seedance-2.0"
                        ? ["480p", "720p", "1080p", "4k"]
                        : ["480p", "720p"];
                const validRatios = [
                    "16:9",
                    "4:3",
                    "1:1",
                    "3:4",
                    "9:16",
                    "21:9",
                    "9:21",
                    "adaptive",
                ];
                const duration =
                    Number.isInteger(combinedParameters.duration) &&
                    combinedParameters.duration >= -1 &&
                    combinedParameters.duration <= 15
                        ? combinedParameters.duration
                        : 5;
                const hasPromptLengthLimit =
                    combinedParameters.model !== "replicate-seedance-2.0-fast";
                const promptText =
                    hasPromptLengthLimit && typeof modelPromptText === "string"
                        ? modelPromptText.slice(0, 4000)
                        : modelPromptText;
                const hasGenerateAudioParameter =
                    Object.hasOwn(parameters, "generateAudio") ||
                    Object.hasOwn(parameters, "generate_audio");
                const generateAudio = hasGenerateAudioParameter
                    ? (parameters.generateAudio ?? parameters.generate_audio)
                    : true;
                const hasSeedParameter = Object.hasOwn(parameters, "seed");

                const firstFrameImage = normalizeImageEntry(
                    combinedParameters.image,
                );
                const lastFrameImage = normalizeImageEntry(
                    combinedParameters.last_frame_image ??
                        combinedParameters.lastFrameImage,
                );

                const referenceImageCandidates = [];
                ["reference_images", "referenceImages"].forEach((field) => {
                    collectImages(
                        combinedParameters[field],
                        referenceImageCandidates,
                    );
                });
                const referenceImages = referenceImageCandidates
                    .map((candidate) => normalizeImageEntry(candidate))
                    .filter(
                        (candidate) =>
                            candidate && typeof candidate === "string",
                    )
                    .slice(0, 9);

                const referenceVideoCandidates = [];
                ["reference_videos", "referenceVideos"].forEach((field) => {
                    collectImages(
                        combinedParameters[field],
                        referenceVideoCandidates,
                    );
                });
                const referenceVideos = referenceVideoCandidates
                    .map((candidate) => normalizeImageEntry(candidate))
                    .filter(
                        (candidate) =>
                            candidate && typeof candidate === "string",
                    )
                    .slice(0, 3);

                const referenceAudioCandidates = [];
                ["reference_audios", "referenceAudios"].forEach((field) => {
                    collectImages(
                        combinedParameters[field],
                        referenceAudioCandidates,
                    );
                });
                const referenceAudios = referenceAudioCandidates
                    .map((candidate) => normalizeImageEntry(candidate))
                    .filter(
                        (candidate) =>
                            candidate && typeof candidate === "string",
                    )
                    .slice(0, 3);

                const useReferenceMode = !firstFrameImage && !lastFrameImage;
                const hasReferenceMedia =
                    useReferenceMode &&
                    (referenceImages.length > 0 || referenceVideos.length > 0);

                requestParameters = {
                    input: omitUndefined({
                        prompt: promptText,
                        duration,
                        resolution: validResolutions.includes(
                            combinedParameters.resolution,
                        )
                            ? combinedParameters.resolution
                            : "720p",
                        aspect_ratio: validRatios.includes(
                            combinedParameters.aspectRatio,
                        )
                            ? combinedParameters.aspectRatio
                            : "16:9",
                        generate_audio: generateAudio,
                        ...(hasSeedParameter &&
                        Number.isInteger(combinedParameters.seed)
                            ? { seed: combinedParameters.seed }
                            : {}),
                        ...(firstFrameImage ? { image: firstFrameImage } : {}),
                        ...(firstFrameImage && lastFrameImage
                            ? { last_frame_image: lastFrameImage }
                            : {}),
                        ...(useReferenceMode && referenceImages.length > 0
                            ? { reference_images: referenceImages }
                            : {}),
                        ...(useReferenceMode && referenceVideos.length > 0
                            ? { reference_videos: referenceVideos }
                            : {}),
                        ...(hasReferenceMedia && referenceAudios.length > 0
                            ? { reference_audios: referenceAudios }
                            : {}),
                    }),
                };
                break;
            }
            case "replicate-kling-v2.5-turbo-pro": {
                const validRatios = ["16:9", "9:16", "1:1"];
                const validDurations = [5, 10];
                const aspectRatio =
                    combinedParameters.aspect_ratio ??
                    combinedParameters.aspectRatio;
                const startImage =
                    combinedParameters.start_image ||
                    combinedParameters.startImage ||
                    combinedParameters.image ||
                    undefined;
                const endImage =
                    combinedParameters.end_image ||
                    combinedParameters.endImage ||
                    undefined;
                const negativePrompt =
                    combinedParameters.negative_prompt ??
                    combinedParameters.negativePrompt ??
                    "";

                requestParameters = {
                    input: omitUndefined({
                        prompt: modelPromptText,
                        aspect_ratio: validRatios.includes(aspectRatio)
                            ? aspectRatio
                            : "16:9",
                        duration: validDurations.includes(
                            combinedParameters.duration,
                        )
                            ? combinedParameters.duration
                            : 5,
                        negative_prompt: negativePrompt,
                        start_image: startImage,
                        end_image: endImage,
                    }),
                };
                break;
            }
            case "replicate-grok-imagine-video": {
                const validRatios = [
                    "auto",
                    "16:9",
                    "4:3",
                    "1:1",
                    "9:16",
                    "3:4",
                    "3:2",
                    "2:3",
                ];
                const validResolutions = ["720p", "480p"];
                const video = combinedParameters.video || undefined;
                const image = combinedParameters.image || undefined;

                const basePayload = omitUndefined({
                    prompt: modelPromptText,
                    image,
                    video,
                });

                requestParameters = {
                    input: video
                        ? basePayload
                        : {
                              ...basePayload,
                              duration: Math.max(
                                  1,
                                  Math.min(
                                      15,
                                      combinedParameters.duration || 5,
                                  ),
                              ),
                              resolution: validResolutions.includes(
                                  combinedParameters.resolution,
                              )
                                  ? combinedParameters.resolution
                                  : "720p",
                              aspect_ratio: validRatios.includes(
                                  combinedParameters.aspect_ratio ??
                                      combinedParameters.aspectRatio,
                              )
                                  ? (combinedParameters.aspect_ratio ??
                                    combinedParameters.aspectRatio)
                                  : "auto",
                          },
                };
                break;
            }
            case "replicate-dreamactor-m2.0": {
                const image = normalizeImageEntry(combinedParameters.image);
                const video = normalizeImageEntry(combinedParameters.video);

                if (!image || !video) {
                    throw new Error(
                        "DreamActor M2.0 requires both image and video inputs",
                    );
                }

                requestParameters = {
                    input: {
                        image,
                        video,
                        cut_first_second:
                            combinedParameters.cutFirstSecond ??
                            combinedParameters.cut_first_second ??
                            true,
                    },
                };
                break;
            }
            case "replicate-p-video-avatar": {
                const validResolutions = ["720p", "1080p"];
                const image = normalizeImageEntry(combinedParameters.image);
                const audio = normalizeImageEntry(
                    getFirstDefined(
                        combinedParameters.audio,
                        combinedParameters.audioUrl,
                        combinedParameters.inputAudioUrl,
                    ),
                );
                const voiceScript = getFirstDefined(
                    combinedParameters.voiceScript,
                    combinedParameters.voice_script,
                    modelPromptText,
                );
                const voicePrompt = getFirstDefined(
                    combinedParameters.voicePrompt,
                    combinedParameters.voice_prompt,
                );
                const voiceLanguage = getFirstDefined(
                    combinedParameters.voiceLanguage,
                    combinedParameters.voice_language,
                );
                const videoPrompt = getFirstDefined(
                    combinedParameters.videoPrompt,
                    combinedParameters.video_prompt,
                );
                const negativePrompt = getFirstDefined(
                    combinedParameters.negativePrompt,
                    combinedParameters.negative_prompt,
                );
                const strengthNegativePrompt = getFirstDefined(
                    combinedParameters.strengthNegativePrompt,
                    combinedParameters.strength_negative_prompt,
                );
                const disableSafetyFilter = getFirstDefined(
                    combinedParameters.disableSafetyFilter,
                    combinedParameters.disable_safety_filter,
                );
                const disablePromptUpsampling = getFirstDefined(
                    combinedParameters.disablePromptUpsampling,
                    combinedParameters.disable_prompt_upsampling,
                );
                const noOp = getFirstDefined(
                    combinedParameters.noOp,
                    combinedParameters.no_op,
                );

                if (!image) {
                    throw new Error("P-Video Avatar requires an image input");
                }
                if (!audio && !voiceScript && !noOp) {
                    throw new Error(
                        "P-Video Avatar requires either audio or voice_script",
                    );
                }

                requestParameters = {
                    input: omitUndefined({
                        image,
                        ...(audio
                            ? { audio }
                            : {
                                  voice: normalizeEnumValue(
                                      combinedParameters.voice,
                                      P_VIDEO_AVATAR_VOICES,
                                      "Zephyr (Female)",
                                  ),
                                  voice_script: voiceScript,
                                  voice_language: normalizeEnumValue(
                                      voiceLanguage,
                                      P_VIDEO_AVATAR_LANGUAGES,
                                      "English (US)",
                                  ),
                                  voice_prompt:
                                      voicePrompt || "Say the following.",
                              }),
                        resolution: validResolutions.includes(
                            combinedParameters.resolution,
                        )
                            ? combinedParameters.resolution
                            : "720p",
                        video_prompt: videoPrompt || "The person is talking.",
                        negative_prompt: negativePrompt || "",
                        strength_negative_prompt: clampNumber(
                            strengthNegativePrompt,
                            0,
                            4,
                            0.5,
                        ),
                        disable_safety_filter:
                            typeof disableSafetyFilter === "boolean"
                                ? disableSafetyFilter
                                : true,
                        disable_prompt_upsampling:
                            typeof disablePromptUpsampling === "boolean"
                                ? disablePromptUpsampling
                                : false,
                        no_op: typeof noOp === "boolean" ? noOp : false,
                        ...(Number.isInteger(combinedParameters.seed)
                            ? { seed: combinedParameters.seed }
                            : {}),
                    }),
                };
                break;
            }
            case "replicate-topaz-image-upscale": {
                const validEnhanceModels = [
                    "Standard V2",
                    "Low Resolution V2",
                    "CGI",
                    "High Fidelity V2",
                    "Text Refine",
                ];
                const validUpscaleFactors = ["None", "2x", "4x", "6x"];
                const validOutputFormats = ["jpg", "png"];
                const validSubjectDetection = [
                    "None",
                    "All",
                    "Foreground",
                    "Background",
                ];
                const image = normalizeImageEntry(combinedParameters.image);
                const enhanceModel = getFirstDefined(
                    combinedParameters.enhanceModel,
                    combinedParameters.enhance_model,
                );
                const upscaleFactor = getFirstDefined(
                    combinedParameters.upscaleFactor,
                    combinedParameters.upscale_factor,
                );
                const outputFormat = getFirstDefined(
                    combinedParameters.outputFormat,
                    combinedParameters.output_format,
                );
                const subjectDetection = getFirstDefined(
                    combinedParameters.subjectDetection,
                    combinedParameters.subject_detection,
                );
                const faceEnhancement = getFirstDefined(
                    combinedParameters.faceEnhancement,
                    combinedParameters.face_enhancement,
                );
                const faceEnhancementCreativity = getFirstDefined(
                    combinedParameters.faceEnhancementCreativity,
                    combinedParameters.face_enhancement_creativity,
                );
                const faceEnhancementStrength = getFirstDefined(
                    combinedParameters.faceEnhancementStrength,
                    combinedParameters.face_enhancement_strength,
                );

                if (!image) {
                    throw new Error(
                        "Topaz Image Upscale requires an image input",
                    );
                }

                requestParameters = {
                    input: {
                        image,
                        enhance_model: validEnhanceModels.includes(enhanceModel)
                            ? enhanceModel
                            : "Standard V2",
                        upscale_factor: validUpscaleFactors.includes(
                            upscaleFactor,
                        )
                            ? upscaleFactor
                            : "None",
                        output_format: validOutputFormats.includes(outputFormat)
                            ? outputFormat
                            : "jpg",
                        subject_detection: validSubjectDetection.includes(
                            subjectDetection,
                        )
                            ? subjectDetection
                            : "None",
                        face_enhancement:
                            typeof faceEnhancement === "boolean"
                                ? faceEnhancement
                                : false,
                        face_enhancement_creativity: clampNumber(
                            faceEnhancementCreativity,
                            0,
                            1,
                            0,
                        ),
                        face_enhancement_strength: clampNumber(
                            faceEnhancementStrength,
                            0,
                            1,
                            0.8,
                        ),
                    },
                };
                break;
            }
            case "replicate-video-upscaler": {
                const validProcessingTypes = ["standard", "pro"];
                const validScenes = [
                    "aigc",
                    "short_series",
                    "ugc",
                    "old_film",
                    "common",
                ];
                const validTargetResolutions = [
                    "240p",
                    "360p",
                    "480p",
                    "540p",
                    "720p",
                    "1080p",
                    "2k",
                    "4k",
                ];
                const validTargetFps = [24, 30, 60, 120];
                const video = normalizeImageEntry(combinedParameters.video);
                const processingType = getFirstDefined(
                    combinedParameters.processingType,
                    combinedParameters.processing_type,
                );
                const targetResolution = getFirstDefined(
                    combinedParameters.targetResolution,
                    combinedParameters.target_resolution,
                );
                const targetFps = getFirstDefined(
                    combinedParameters.targetFps,
                    combinedParameters.target_fps,
                );

                if (!video) {
                    throw new Error("Video Upscaler requires a video input");
                }

                requestParameters = {
                    input: {
                        video,
                        processing_type: validProcessingTypes.includes(
                            processingType,
                        )
                            ? processingType
                            : "standard",
                        scene: validScenes.includes(combinedParameters.scene)
                            ? combinedParameters.scene
                            : "aigc",
                        target_resolution: validTargetResolutions.includes(
                            targetResolution,
                        )
                            ? targetResolution
                            : "4k",
                        target_fps: validTargetFps.includes(targetFps)
                            ? targetFps
                            : 60,
                    },
                };
                break;
            }
            case "replicate-topaz-video-upscale": {
                const validTargetResolutions = ["720p", "1080p", "4k"];
                const video = normalizeImageEntry(combinedParameters.video);
                const targetResolution = getFirstDefined(
                    parameters.targetResolution,
                    parameters.target_resolution,
                );
                const targetFps = Math.round(
                    clampNumber(
                        getFirstDefined(
                            parameters.targetFps,
                            parameters.target_fps,
                        ),
                        15,
                        60,
                        30,
                    ),
                );

                if (!video) {
                    throw new Error(
                        "Topaz Video Upscale requires a video input",
                    );
                }

                requestParameters = {
                    input: {
                        video,
                        target_resolution: validTargetResolutions.includes(
                            targetResolution,
                        )
                            ? targetResolution
                            : "1080p",
                        target_fps: targetFps,
                    },
                };
                break;
            }
            case "replicate-seedream-4": {
                const validSizes = ["1K", "2K", "4K", "custom"];
                const validRatios = [
                    "1:1",
                    "4:3",
                    "3:4",
                    "16:9",
                    "9:16",
                    "match_input_image",
                ];
                const validSequentialModes = ["disabled", "auto"];

                const normalizedImages = collectNormalizedImages(
                    combinedParameters,
                    ["imageInput"],
                );

                const basePayload = omitUndefined({
                    prompt: modelPromptText,
                    size: validSizes.includes(combinedParameters.size)
                        ? combinedParameters.size
                        : "2K",
                    width: combinedParameters.width || 2048,
                    height: combinedParameters.height || 2048,
                    max_images:
                        combinedParameters.maxImages ||
                        combinedParameters.numberResults ||
                        1,
                    aspect_ratio: validRatios.includes(
                        combinedParameters.aspectRatio,
                    )
                        ? combinedParameters.aspectRatio
                        : "4:3",
                    sequential_image_generation: validSequentialModes.includes(
                        combinedParameters.sequentialImageGeneration,
                    )
                        ? combinedParameters.sequentialImageGeneration
                        : "disabled",
                    ...(Number.isInteger(combinedParameters.seed) &&
                    combinedParameters.seed > 0
                        ? { seed: combinedParameters.seed }
                        : {}),
                });

                // For seedream-4, include the image_input array if we have images
                const inputPayload = {
                    ...basePayload,
                    ...(normalizedImages.length > 0
                        ? { image_input: normalizedImages }
                        : {}),
                };

                requestParameters = {
                    input: inputPayload,
                };
                break;
            }
            case "replicate-seedream-4.5": {
                const validSizes = ["2K", "4K"];
                const validRatios = [
                    "match_input_image",
                    "1:1",
                    "4:3",
                    "3:4",
                    "16:9",
                    "9:16",
                    "3:2",
                    "2:3",
                    "21:9",
                ];
                const validSequentialModes = ["disabled", "auto"];
                const disableSafetyChecker =
                    combinedParameters.disable_safety_checker ??
                    combinedParameters.disableSafetyChecker ??
                    false;

                const normalizedImages = collectNormalizedImages(
                    combinedParameters,
                    ["imageInput"],
                );

                const inputPayload = omitUndefined({
                    prompt: modelPromptText,
                    size: validSizes.includes(combinedParameters.size)
                        ? combinedParameters.size
                        : "2K",
                    max_images:
                        combinedParameters.numberResults ||
                        combinedParameters.maxImages ||
                        1,
                    aspect_ratio: validRatios.includes(
                        combinedParameters.aspectRatio,
                    )
                        ? combinedParameters.aspectRatio
                        : "match_input_image",
                    sequential_image_generation: validSequentialModes.includes(
                        combinedParameters.sequentialImageGeneration,
                    )
                        ? combinedParameters.sequentialImageGeneration
                        : "disabled",
                    disable_safety_checker: disableSafetyChecker,
                    ...(normalizedImages.length > 0
                        ? { image_input: normalizedImages }
                        : {}),
                });

                requestParameters = {
                    input: inputPayload,
                };
                break;
            }
            case "replicate-seedream-5-lite": {
                const validSizes = ["2K", "3K"];
                const validRatios = [
                    "match_input_image",
                    "1:1",
                    "4:3",
                    "3:4",
                    "16:9",
                    "9:16",
                    "3:2",
                    "2:3",
                    "21:9",
                ];
                const validSequentialModes = ["disabled", "auto"];
                const validOutputFormats = ["png", "jpeg"];

                const normalizedImages = collectNormalizedImages(
                    combinedParameters,
                    ["imageInput"],
                );

                const inputPayload = omitUndefined({
                    prompt: modelPromptText,
                    size: validSizes.includes(combinedParameters.size)
                        ? combinedParameters.size
                        : "2K",
                    max_images:
                        combinedParameters.numberResults ||
                        combinedParameters.maxImages ||
                        1,
                    aspect_ratio: validRatios.includes(
                        combinedParameters.aspectRatio,
                    )
                        ? combinedParameters.aspectRatio
                        : "match_input_image",
                    sequential_image_generation: validSequentialModes.includes(
                        combinedParameters.sequentialImageGeneration,
                    )
                        ? combinedParameters.sequentialImageGeneration
                        : "disabled",
                    output_format: validOutputFormats.includes(
                        combinedParameters.output_format ??
                            combinedParameters.outputFormat,
                    )
                        ? (combinedParameters.output_format ??
                          combinedParameters.outputFormat)
                        : "png",
                    ...(normalizedImages.length > 0
                        ? { image_input: normalizedImages }
                        : {}),
                });

                requestParameters = {
                    input: inputPayload,
                };
                break;
            }
            case "replicate-flux-2-pro": {
                const validResolutions = [
                    "match_input_image",
                    "0.5 MP",
                    "1 MP",
                    "2 MP",
                    "4 MP",
                ];
                const validRatios = [
                    "match_input_image",
                    "custom",
                    "1:1",
                    "16:9",
                    "3:2",
                    "2:3",
                    "4:5",
                    "5:4",
                    "9:16",
                    "3:4",
                    "4:3",
                ];
                const validOutputFormats = ["webp", "jpg", "png"];

                const normalizedImages = collectNormalizedImages(
                    combinedParameters,
                ).slice(0, 8); // Maximum 8 images

                const aspectRatio = validRatios.includes(
                    combinedParameters.aspect_ratio ??
                        combinedParameters.aspectRatio,
                )
                    ? (combinedParameters.aspect_ratio ??
                      combinedParameters.aspectRatio)
                    : "1:1";

                const resolution = validResolutions.includes(
                    combinedParameters.resolution,
                )
                    ? combinedParameters.resolution
                    : "1 MP";

                const outputFormat = validOutputFormats.includes(
                    combinedParameters.output_format ??
                        combinedParameters.outputFormat,
                )
                    ? (combinedParameters.output_format ??
                      combinedParameters.outputFormat)
                    : "webp";

                const outputQuality =
                    combinedParameters.output_quality ??
                    combinedParameters.outputQuality ??
                    80;
                const safetyTolerance =
                    combinedParameters.safety_tolerance ??
                    combinedParameters.safetyTolerance ??
                    2;

                // Validate and round width/height to multiples of 32 if provided
                let width = combinedParameters.width;
                let height = combinedParameters.height;

                if (width !== undefined && width !== null) {
                    width = Math.max(
                        256,
                        Math.min(2048, Math.round(width / 32) * 32),
                    );
                }
                if (height !== undefined && height !== null) {
                    height = Math.max(
                        256,
                        Math.min(2048, Math.round(height / 32) * 32),
                    );
                }

                const basePayload = omitUndefined({
                    prompt: modelPromptText,
                    aspect_ratio: aspectRatio,
                    resolution: resolution,
                    output_format: outputFormat,
                    output_quality: Math.max(0, Math.min(100, outputQuality)),
                    safety_tolerance: Math.max(1, Math.min(5, safetyTolerance)),
                    ...(width !== undefined && width !== null ? { width } : {}),
                    ...(height !== undefined && height !== null
                        ? { height }
                        : {}),
                    ...(Number.isInteger(combinedParameters.seed) &&
                    combinedParameters.seed > 0
                        ? { seed: combinedParameters.seed }
                        : {}),
                });

                // Include input_images array if we have images
                const inputPayload = {
                    ...basePayload,
                    ...(normalizedImages.length > 0
                        ? { input_images: normalizedImages }
                        : {}),
                };

                requestParameters = {
                    input: inputPayload,
                };
                break;
            }
            case "replicate-elevenlabs-music": {
                const musicLengthMs =
                    combinedParameters.music_length_ms ??
                    combinedParameters.musicLengthMs;
                const durationSeconds = clampNumber(
                    combinedParameters.duration ??
                        combinedParameters.durationSeconds ??
                        combinedParameters.length ??
                        (musicLengthMs
                            ? Number(musicLengthMs) / 1000
                            : undefined),
                    5,
                    300,
                    10,
                );
                const outputFormat = normalizeElevenLabsMusicOutputFormat(
                    combinedParameters.output_format ??
                        combinedParameters.outputFormat,
                );

                requestParameters = {
                    input: {
                        prompt: modelPromptText,
                        output_format: outputFormat,
                        music_length_ms: Math.round(durationSeconds * 1000),
                        force_instrumental:
                            combinedParameters.force_instrumental ??
                            combinedParameters.forceInstrumental ??
                            true,
                    },
                };
                break;
            }
            case "replicate-minimax-music-26": {
                requestParameters = {
                    input: omitUndefined({
                        lyrics: combinedParameters.lyrics,
                        prompt: modelPromptText,
                        ...buildMinimaxMusicAudioControls(combinedParameters),
                        is_instrumental:
                            combinedParameters.is_instrumental ??
                            combinedParameters.isInstrumental ??
                            false,
                        lyrics_optimizer:
                            combinedParameters.lyrics_optimizer ??
                            combinedParameters.lyricsOptimizer ??
                            false,
                    }),
                };
                break;
            }
            case "replicate-minimax-music-cover": {
                const audioUrl = getFirstDefined(
                    combinedParameters.audio_url,
                    combinedParameters.audioUrl,
                    combinedParameters.inputAudioUrl,
                );
                if (!audioUrl) {
                    throw new Error(
                        "MiniMax Music Cover requires a selected audio item or audio_url",
                    );
                }

                requestParameters = {
                    input: omitUndefined({
                        audio_url: audioUrl,
                        prompt: modelPromptText,
                        lyrics: combinedParameters.lyrics,
                    }),
                };
                break;
            }
            case "replicate-qwen3-tts": {
                const mode = normalizeEnumValue(
                    combinedParameters.mode,
                    QWEN3_TTS_MODES,
                    "custom_voice",
                );
                const language = normalizeEnumValue(
                    combinedParameters.language,
                    QWEN3_TTS_LANGUAGES,
                    "auto",
                );
                const speaker = normalizeEnumValue(
                    combinedParameters.speaker,
                    QWEN3_TTS_SPEAKERS,
                    "Serena",
                );
                const referenceAudio = getFirstDefined(
                    combinedParameters.reference_audio,
                    combinedParameters.referenceAudio,
                    combinedParameters.referenceAudioUrl,
                    combinedParameters.inputAudioUrl,
                    combinedParameters.audioUrl,
                );
                const referenceText = getFirstDefined(
                    combinedParameters.reference_text,
                    combinedParameters.referenceText,
                );
                const styleInstruction = getFirstDefined(
                    combinedParameters.style_instruction,
                    combinedParameters.styleInstruction,
                );
                const voiceDescription = getFirstDefined(
                    combinedParameters.voice_description,
                    combinedParameters.voiceDescription,
                );

                if (mode === "voice_clone" && !referenceAudio) {
                    throw new Error(
                        "Qwen3 TTS voice_clone mode requires reference_audio or a selected audio item",
                    );
                }
                if (mode === "voice_design" && !voiceDescription) {
                    throw new Error(
                        "Qwen3 TTS voice_design mode requires voice_description",
                    );
                }

                requestParameters = {
                    input: omitUndefined({
                        mode,
                        text: modelPromptText,
                        language,
                        ...(mode === "custom_voice" ? { speaker } : {}),
                        ...(mode === "voice_clone"
                            ? {
                                  reference_audio: referenceAudio,
                                  reference_text: referenceText,
                              }
                            : {}),
                        ...(mode === "voice_design"
                            ? {
                                  voice_description: voiceDescription,
                              }
                            : {}),
                        style_instruction: styleInstruction,
                    }),
                };
                break;
            }
            case "replicate-elevenlabs-v3": {
                const voice = normalizeEnumValue(
                    combinedParameters.voice,
                    ELEVENLABS_V3_VOICES,
                    "Rachel",
                );
                const stability = clampNumber(
                    combinedParameters.stability,
                    0,
                    1,
                    0.5,
                );
                const similarityBoost = clampNumber(
                    combinedParameters.similarity_boost ??
                        combinedParameters.similarityBoost,
                    0,
                    1,
                    0.75,
                );
                const style = clampNumber(combinedParameters.style, 0, 1, 0);
                const speed = clampNumber(
                    combinedParameters.speed,
                    0.7,
                    1.2,
                    1,
                );
                const previousText = getFirstDefined(
                    combinedParameters.previous_text,
                    combinedParameters.previousText,
                );
                const nextText = getFirstDefined(
                    combinedParameters.next_text,
                    combinedParameters.nextText,
                );
                const languageCode = getFirstDefined(
                    combinedParameters.language_code,
                    combinedParameters.languageCode,
                    "en",
                );

                requestParameters = {
                    input: omitUndefined({
                        prompt: modelPromptText,
                        voice,
                        stability,
                        similarity_boost: similarityBoost,
                        style,
                        speed,
                        previous_text: previousText,
                        next_text: nextText,
                        language_code: languageCode,
                    }),
                };
                break;
            }
            case "replicate-minimax-speech-2.8-turbo":
            case "replicate-minimax-speech-2.8-hd": {
                const selectedVoiceId = getFirstDefined(
                    combinedParameters.voice_id,
                    combinedParameters.voiceId,
                );
                const customVoiceId = getFirstDefined(
                    combinedParameters.custom_voice_id,
                    combinedParameters.customVoiceId,
                );
                const voiceId = getFirstDefined(
                    selectedVoiceId === "__custom"
                        ? customVoiceId
                        : selectedVoiceId,
                    "English_Wiselady",
                );

                requestParameters = {
                    input: omitUndefined({
                        text: modelPromptText,
                        voice_id: voiceId,
                        speed: clampNumber(combinedParameters.speed, 0.5, 2, 1),
                        volume: clampNumber(
                            combinedParameters.volume,
                            0,
                            10,
                            1,
                        ),
                        pitch: Math.round(
                            clampNumber(combinedParameters.pitch, -12, 12, 0),
                        ),
                        emotion: normalizeEnumValue(
                            combinedParameters.emotion,
                            MINIMAX_TTS_EMOTIONS,
                            "auto",
                        ),
                        english_normalization:
                            combinedParameters.english_normalization ??
                            combinedParameters.englishNormalization ??
                            false,
                        sample_rate: normalizeNumberEnumValue(
                            combinedParameters.sample_rate ??
                                combinedParameters.sampleRate,
                            MINIMAX_TTS_SAMPLE_RATES,
                            32000,
                        ),
                        bitrate: normalizeNumberEnumValue(
                            combinedParameters.bitrate,
                            MINIMAX_TTS_BITRATES,
                            128000,
                        ),
                        audio_format: normalizeEnumValue(
                            combinedParameters.audio_format ??
                                combinedParameters.audioFormat,
                            MINIMAX_TTS_AUDIO_FORMATS,
                            "mp3",
                        ),
                        channel: normalizeEnumValue(
                            combinedParameters.channel,
                            MINIMAX_TTS_CHANNELS,
                            "mono",
                        ),
                        subtitle_enable:
                            combinedParameters.subtitle_enable ??
                            combinedParameters.subtitleEnable ??
                            false,
                        language_boost: normalizeEnumValue(
                            combinedParameters.language_boost ??
                                combinedParameters.languageBoost,
                            MINIMAX_TTS_LANGUAGE_BOOSTS,
                            "None",
                        ),
                    }),
                };
                break;
            }
        }

        return requestParameters;
    }

    isAudioPathway() {
        const modelName = this.modelName || this.promptParameters?.model || "";
        return (
            this.model?.metadata?.category === "audio" ||
            this.model?.metadata?.category === "tts" ||
            this.pathwayName?.startsWith("music_") ||
            this.pathwayName?.startsWith("tts_") ||
            /music|tts/i.test(modelName)
        );
    }

    getFallbackAudioMimeType() {
        const format = String(
            this.lastCombinedParameters?.audio_format ??
                this.lastCombinedParameters?.audioFormat ??
                this.lastCombinedParameters?.output_format ??
                this.lastCombinedParameters?.outputFormat ??
                this.promptParameters?.audio_format ??
                this.promptParameters?.audioFormat ??
                this.promptParameters?.output_format ??
                this.promptParameters?.outputFormat ??
                "",
        ).toLowerCase();

        if (format.includes("wav")) return "audio/wav";
        if (format.includes("mp3")) return "audio/mpeg";
        if (format.includes("pcm")) return "audio/L16";
        return "audio/mpeg";
    }

    getArtifactTypeFromMime(mimeType) {
        if (mimeType.startsWith("image/")) return "image";
        if (mimeType.startsWith("video/")) return "video";
        if (mimeType.startsWith("audio/")) return "audio";
        if (mimeType === "application/octet-stream" && this.isAudioPathway()) {
            return "audio";
        }
        return null;
    }

    getPredictionFailureMessage(status, errorMessage) {
        const rawMessage = errorMessage || "Unknown error";
        const modelName =
            this.modelName || this.model?.name || this.promptParameters?.model;

        if (
            modelName === "replicate-minimax-music-cover" &&
            /dtw_result|beat_result|audio_duration/i.test(rawMessage)
        ) {
            return `Prediction ${status}: MiniMax Music Cover could not analyze the selected audio for cover generation. It requires a source song with detectable timing/beat data; this model is for full song covers, not adding a standalone instrument layer over arbitrary audio.`;
        }

        return `Prediction ${status}: ${rawMessage}`;
    }

    // Execute the request to the Replicate API
    async execute(text, parameters, prompt, cortexRequest) {
        const requestParameters = this.getRequestParameters(
            text,
            parameters,
            prompt,
        );

        cortexRequest.data = requestParameters;
        cortexRequest.params = requestParameters.params;

        // Make initial request to start prediction
        const response = await this.executeRequest(cortexRequest);

        // Parse the response to get the actual Replicate data
        const parsedResponse = JSON.parse(response.output_text);

        // If we got a completed response, return it as CortexResponse
        if (parsedResponse?.status === "succeeded") {
            return this.createCortexResponse(response);
        }

        logger.info("Replicate API returned a non-completed response.");

        if (!parsedResponse?.id) {
            throw new Error("No prediction ID returned from Replicate API");
        }

        // Get the prediction ID and polling URL
        const predictionId = parsedResponse.id;
        const pollUrl = parsedResponse.urls?.get;

        if (!pollUrl) {
            throw new Error("No polling URL returned from Replicate API");
        }

        // Poll for results — video generation needs longer than image generation
        const isLongRunningMedia = ["audio", "video", "tts"].includes(
            this.model?.metadata?.category,
        );
        const pollInterval = 5000;
        const maxAttempts = isLongRunningMedia ? 180 : 60; // 15 minutes for audio/video, 5 minutes for images

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            try {
                const pollResponse = await axios.get(pollUrl, {
                    headers: cortexRequest.headers,
                });

                logger.info("Polling Replicate API - attempt " + attempt);
                const status = pollResponse.data?.status;

                if (status === "succeeded") {
                    logger.info(
                        "Replicate API returned a completed response after polling",
                    );
                    // Parse the polled response to extract artifacts
                    const parsedResponse = this.parseResponse(
                        pollResponse.data,
                    );
                    return this.createCortexResponse(parsedResponse);
                } else if (status === "failed" || status === "canceled") {
                    throw new Error(
                        this.getPredictionFailureMessage(
                            status,
                            pollResponse.data?.error,
                        ),
                    );
                }

                // Wait before next poll
                await new Promise((resolve) =>
                    setTimeout(resolve, pollInterval),
                );
            } catch (error) {
                logger.error(
                    `Error polling prediction ${predictionId}: ${error.message}`,
                );
                throw error;
            }
        }

        throw new Error(
            `Prediction ${predictionId} timed out after ${(maxAttempts * pollInterval) / 1000} seconds`,
        );
    }

    collectOutputUrls(value, urls = [], path = []) {
        if (!value) {
            return urls;
        }
        if (typeof value === "string") {
            urls.push({
                url: value,
                key: path.filter(Boolean).join(".") || "output",
            });
            return urls;
        }
        if (Array.isArray(value)) {
            value.forEach((item, index) =>
                this.collectOutputUrls(item, urls, [...path, String(index)]),
            );
            return urls;
        }
        if (typeof value === "object") {
            for (const [key, item] of Object.entries(value)) {
                this.collectOutputUrls(item, urls, [...path, key]);
            }
        }
        return urls;
    }

    // Parse the response from the Replicate API and extract media artifacts
    parseResponse(data) {
        const responseData = data.data || data;
        const stringifiedResponse = JSON.stringify(responseData);

        const artifacts = [];
        const outputItems = this.collectOutputUrls(responseData?.output);

        for (const outputItem of outputItems) {
            if (!isArtifactUrl(outputItem?.url)) {
                continue;
            }

            let mimeType = this.getMimeTypeFromUrl(outputItem.url);
            const artifactType = this.getArtifactTypeFromMime(mimeType);
            if (!artifactType) {
                continue;
            }
            if (
                artifactType === "audio" &&
                mimeType === "application/octet-stream"
            ) {
                mimeType = this.getFallbackAudioMimeType();
            }

            artifacts.push({
                type: artifactType,
                url: outputItem.url,
                mimeType,
                ...(outputItem.key && outputItem.key !== "output"
                    ? { key: outputItem.key }
                    : {}),
            });
        }

        return {
            output_text: stringifiedResponse,
            artifacts,
        };
    }

    // Create a CortexResponse from parsed response data
    createCortexResponse(parsedResponse) {
        if (typeof parsedResponse === "string") {
            // Handle string response (backward compatibility)
            return new CortexResponse({
                output_text: parsedResponse,
                artifacts: [],
            });
        } else if (parsedResponse && typeof parsedResponse === "object") {
            // Handle object response with artifacts
            return new CortexResponse({
                output_text: parsedResponse.output_text,
                artifacts: parsedResponse.artifacts || [],
            });
        } else {
            throw new Error("Unexpected response format");
        }
    }

    // Helper method to determine MIME type from URL extension
    getMimeTypeFromUrl(url) {
        // Extract path from URL (remove query params and fragments)
        const urlPath = url.split("?")[0].split("#")[0];
        const mimeType = mime.lookup(urlPath) || "application/octet-stream";
        return mimeType === "audio/wave" || mimeType === "audio/x-wav"
            ? "audio/wav"
            : mimeType;
    }

    // Override the logging function to display the request and response
    logRequestData(data, responseData, prompt) {
        const modelInput = data?.input?.prompt ?? data?.input?.text;

        const { length, units } = this.getLength(modelInput || "");
        logger.info(`[Replicate request sent containing ${length} ${units}]`);
        const parsedResponse = this.parseResponse(responseData);
        const responseText =
            typeof parsedResponse === "string"
                ? parsedResponse
                : parsedResponse?.output_text || "";
        const responseLength = this.getLength(responseText);
        logger.info(
            `[Replicate response received containing ${responseLength.length} ${responseLength.units}]`,
        );

        prompt &&
            prompt.debugInfo &&
            (prompt.debugInfo += `\n${JSON.stringify(data)}`);
    }
}

export default ReplicateApiPlugin;
