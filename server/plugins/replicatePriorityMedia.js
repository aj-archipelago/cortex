// Model-specific contracts verified against Replicate's public input schemas.
// No arbitrary provider fields are forwarded from the caller.
const MODELS = new Set([
    "replicate-gpt-image-2.5-flare", "replicate-gpt-image-2.5-sunburst",
    "replicate-wan-3", "replicate-p-video-2-pro", "replicate-p-video-2", "replicate-flux-3",
    "replicate-seedance-2.5", "replicate-minimax-h3",
    "replicate-ltx-2.5-fast", "replicate-qwen-image-3-pro",
    "replicate-seedream-5-pro", "replicate-recraft-v4-styles-pro",
    "replicate-recraft-v4-styles-pro-svg", "replicate-elevenlabs-dubbing",
]);
const DUBBING_LANGUAGES = ["af","ak","sq","am","ar","ar-EG","hy","as","az","eu","be","bs","bg","my","yue","ca","ceb","zh","zh-TW","hr","cs","da","dgo","nl","en","en-AU","en-CA","en-GB","en-US","et","fil","fi","fr","fr-CA","fr-FR","gl","ka","de","el","gu","ha","he","hi","hu","is","id","it","ja","jv","kn","kk","ki","rw","rn","ko","ky","lv","lt","lg","mk","ms","ml","cmn","mr","mn","ne","no","fa","pl","pt","pt-BR","pt-PT","pa","ro","ru","nso","st","sd","sk","sl","es","es-AR","es-CL","es-ES","es-MX","su","sw","ss","sv","tg","ta","te","th","bo","ts","tn","tr","uk","ur","ug","uz","ve","vi","war","cy","wo","yo","zu"];
const RECRAFT_SIZES = ["2048x2048","3072x1536","1536x3072","2560x1664","1664x2560","2432x1792","1792x2432","2304x1792","1792x2304","1664x2688","2560x1792","1792x2560","2688x1536","1536x2688"];

const clean = (object) => Object.fromEntries(Object.entries(object).filter(
    ([, value]) => value !== undefined && value !== null && value !== "",
));
const list = (value) => Array.isArray(value) ? value.filter(Boolean) : [];
const pick = (value, choices, fallback) => {
    if (value === undefined || value === null || value === "") return fallback;
    if (!choices.includes(value)) throw new Error(`Unsupported value '${value}'; expected ${choices.join(", ")}`);
    return value;
};
const checkCount = (items, max, label) => {
    if (items.length > max) throw new Error(`${label}: at most ${max} references are supported`);
};

export function buildPriorityMediaInput(modelId, prompt, parameters) {
    if (!MODELS.has(modelId)) return null;
    prompt = prompt || "";
    const p = parameters;
    const images = list(p.inputImages);
    const videos = list(p.inputVideos);
    const audios = list(p.inputAudio);
    const roles = Array.isArray(p.inputImageRoles) ? p.inputImageRoles : [];
    const explicitRoles = roles.some(Boolean);
    if (roles.length > images.length) throw new Error("Image roles require matching image references");
    for (const role of ["start_frame", "end_frame"]) {
        if (roles.filter(value => value === role).length > 1) throw new Error("Only one " + role + " is supported");
    }
    const first = explicitRoles ? images[roles.indexOf("start_frame")] : images[0];
    const last = explicitRoles ? images[roles.indexOf("end_frame")] : images[1];
    const references = explicitRoles ? images.filter((_, i) => !["start_frame", "end_frame"].includes(roles[i])) : images;
    const requirePrompt = () => {
        if (!prompt?.trim()) throw new Error(`${modelId} requires a text prompt`);
    };
    const noOtherMedia = () => {
        if (videos.length || audios.length) throw new Error(`${modelId} accepts image references only`);
    };
    const seed = Number.isInteger(p.seed) && p.seed >= 0 ? p.seed : undefined;

    const integer = (value, min, max, fallback) => {
        const n = value ?? fallback;
        if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Expected an integer from ${min} to ${max}`);
        return n;
    };
    const requireFrames = () => {
        checkCount(images, 2, modelId);
        if (roles.some(role => role && !["start_frame", "end_frame"].includes(role))) throw new Error("Use start/end frames for this model");
        if (last && !first) throw new Error("An end frame requires a start frame");
    };
    switch (modelId) {
        case "replicate-gpt-image-2.5-flare":
        case "replicate-gpt-image-2.5-sunburst": {
            requirePrompt(); noOtherMedia(); checkCount(images, 10, "GPT Image 2.5");
            const background = pick(p.background, ["auto", "transparent", "opaque"], "auto");
            const format = pick(p.outputFormat, ["png", "webp", "jpeg"], "png");
            if (background === "transparent" && format === "jpeg") throw new Error("Transparent backgrounds require PNG or WebP");
            return clean({ prompt, input_images: images.length ? images : undefined,
                aspect_ratio: pick(p.aspectRatio, ["1:1","3:2","2:3","4:3","3:4","16:9","9:16","auto","1024x1024","1536x1024","1024x1536","1536x1152","1152x1536","2048x2048","2048x1152","1152x2048","3840x2160","2160x3840"], "1:1"),
                quality: pick(p.quality, ["auto", "low", "medium", "high", "xhigh", "max"], "auto"),
                background, output_format: format,
                number_of_images: integer(p.numberResults, 1, 10, 1),
                ...(format !== "png" ? { output_compression: integer(p.outputCompression, 0, 100, 90) } : {}),
            });
        }
        case "replicate-wan-3":
            requirePrompt(); noOtherMedia(); checkCount(images, 1, "Wan 3");
            if (roles.some(role => role && role !== "start_frame")) throw new Error("Wan 3 accepts a start frame only");
            if (seed > 2147483647) throw new Error("Wan seed must not exceed 2147483647");
            return clean({ prompt, image: images[0], seed,
                duration: integer(p.duration, 2, 30, 5),
                resolution: pick(p.resolution, ["480p", "720p", "1080p"], "1080p"),
                aspect_ratio: pick(p.aspectRatio, ["adaptive","16:9","9:16","1:1","4:3","3:4"], "adaptive"),
                negative_prompt: p.negativePrompt, enable_prompt_expansion: p.enablePromptExpansion ?? true });
        case "replicate-p-video-2-pro":
            requirePrompt(); noOtherMedia(); requireFrames();
            return clean({ prompt, image: first, last_frame_image: last, seed,
                mode: pick(p.generationMode, ["speed", "quality"], "speed"),
                prompt_upsampler: pick(p.promptUpsampler, ["off", "turbo", "max"], "turbo"),
                duration: integer(p.duration, 5, 15, 5),
                resolution: pick(p.resolution, ["480p", "768p"], "768p"),
                aspect_ratio: pick(p.aspectRatio, ["16:9","9:16","4:3","3:4","3:2","2:3","1:1"], "16:9") });
        case "replicate-p-video-2":
            requirePrompt(); requireFrames(); checkCount(audios, 1, "P-Video-2 audio");
            if (videos.length) throw new Error("P-Video-2 does not accept video input");
            return clean({ prompt, image: first, last_frame_image: last, audio: audios[0], seed,
                duration: audios.length || p.duration === -1 ? undefined : integer(p.duration, 1, 20, 5),
                resolution: pick(p.resolution, ["720p", "1080p"], "720p"),
                aspect_ratio: pick(p.aspectRatio, ["16:9","9:16","4:3","3:4","3:2","2:3","1:1"], "16:9"),
                fps: pick(p.fps, [24, 48], 24), draft: p.draft ?? false,
                save_audio: p.generateAudio ?? true, prompt_upsampling: p.enablePromptExpansion ?? true,
                disable_safety_filter: false });
        case "replicate-flux-3": {
            requirePrompt(); checkCount(images, 10, "FLUX storyboard"); checkCount(videos, 1, "FLUX continuation");
            if (audios.length) throw new Error("FLUX 3 does not accept audio input");
            if (images.length && videos.length) throw new Error("FLUX storyboard images cannot be combined with a continuation video");
            if (explicitRoles) throw new Error("FLUX storyboard frames use their attachment order");
            const duration = p.duration == null || p.duration === -1 ? "auto" : String(integer(p.duration, 5, 20));
            if (images.length >= 3 && duration === "auto") throw new Error("A storyboard of three or more images requires an explicit duration");
            return clean({ prompt, images, start_video: videos[0], duration,
                resolution: p.draft ? "720p" : pick(p.resolution, ["720p", "1080p"], "720p"),
                aspect_ratio: pick(p.aspectRatio, ["auto","21:9","2:1","16:9","4:3","1:1","3:4","9:16"], "auto"),
                draft: p.draft ?? false, generate_audio: p.generateAudio ?? true, safety_tolerance: 2 });
        }

        case "replicate-qwen-image-3-pro":
            requirePrompt(); noOtherMedia(); checkCount(images, 1, "Qwen Image 3 Pro");
            if (seed > 2147483647) throw new Error("Qwen seed must not exceed 2147483647");
            return clean({ prompt, image: images[0], seed,
                aspect_ratio: pick(p.aspectRatio, ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2"], "1:1"),
                negative_prompt: p.negativePrompt,
                match_input_image: p.matchInputImage ?? false,
                enable_prompt_expansion: p.enablePromptExpansion ?? true,
            });
        case "replicate-seedream-5-pro": {
            noOtherMedia(); checkCount(images, 10, "Seedream 5 Pro");
            const layers = p.layerDecomposition ?? false;
            if (layers && images.length !== 1) throw new Error("Layer decomposition requires exactly one image");
            if (!layers) requirePrompt();
            if (prompt.length > 4000) throw new Error("Seedream 5 Pro prompts must be at most 4000 characters");
            return { prompt, image_input: images, layer_decomposition: layers,
                size: pick(p.size, layers ? ["1K", "1.5K", "2K", "auto"] : ["1K", "2K"], "2K"),
                aspect_ratio: pick(p.aspectRatio, ["match_input_image", "1:1", "4:3", "3:4", "16:9", "9:16", "3:2", "2:3", "21:9"], "match_input_image"),
                output_format: pick(p.outputFormat, ["png", "jpeg"], "png"),
            };
        }
        case "replicate-recraft-v4-styles-pro":
        case "replicate-recraft-v4-styles-pro-svg": {
            requirePrompt(); noOtherMedia(); checkCount(images, 10, "Recraft Styles");
            if (prompt.length > 10000) throw new Error("Recraft prompts must be at most 10000 characters");
            const styleId = p.styleId?.trim();
            if (Boolean(styleId) === Boolean(images.length)) throw new Error("Provide style reference images or a reusable style ID, but not both");
            return clean({ prompt, style_id: styleId,
                // Replicate's schema requires the array even when reusing a style ID.
                style_reference_images: images,
                style_match: pick(p.styleMatch, ["precise", "flexible"], "precise"),
                size: pick(p.size, RECRAFT_SIZES, "2048x2048"),
                aspect_ratio: pick(p.aspectRatio, ["Not set", "1:1", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "1:2", "2:1", "4:5", "5:4", "6:10", "14:10", "10:14"], "1:1"),
            });
        }
        case "replicate-ltx-2.5-fast": {
            requirePrompt(); noOtherMedia(); checkCount(images, 2, "LTX 2.5");
            if (roles.some(role => role && !["start_frame", "end_frame"].includes(role))) throw new Error("LTX accepts start/end frames only");
            if (last && !first) throw new Error("An end frame requires a start frame");
            const duration = pick(p.duration, [2, 3, 4, 5, 6, 8, 10, 12, 14, 16, 18, 20], 6);
            const resolution = pick(p.resolution, ["720p", "1080p", "2k", "4k"], "1080p");
            const fps = pick(p.fps, [24, 25, 48, 50], 25);
            if (duration > 10 && (["2k", "4k"].includes(resolution) || fps > 25)) throw new Error("LTX clips longer than 10 seconds require 720p/1080p and 24/25 FPS");
            return clean({ prompt, image: first, last_frame_image: last, duration, resolution, fps,
                aspect_ratio: pick(p.aspectRatio, ["16:9", "9:16"], "16:9"), generate_audio: p.generateAudio ?? true });
        }
        case "replicate-seedance-2.5": {
            checkCount(images, 30, "Seedance images"); checkCount(videos, 10, "Seedance videos"); checkCount(audios, 10, "Seedance audio");
            const mode = pick(p.generationMode, ["generate", "edit", "extend"], "generate");
            const frameMode = explicitRoles && Boolean(first || last);
            if (last && !first && explicitRoles) throw new Error("An end frame requires a start frame");
            if (frameMode && (references.length || videos.length || audios.length)) throw new Error("Seedance first/last frames cannot be combined with reference media");
            if (!prompt?.trim() && !images.length && !videos.length) throw new Error("Seedance requires a prompt or visual reference");
            if (audios.length && !images.length && !videos.length) throw new Error("Reference audio requires a reference image or video");
            if (mode !== "generate" && !videos.length) throw new Error("Video editing and extension require a reference video");
            const duration = mode === "edit" ? -1 : pick(p.duration, [-1, ...Array.from({ length: 27 }, (_, i) => i + 4)], 5);
            const ratio = frameMode || mode !== "generate" ? "adaptive" : pick(p.aspectRatio, ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"], "16:9");
            return clean({ prompt: prompt || undefined, duration, aspect_ratio: ratio,
                resolution: pick(p.resolution, ["480p", "720p"], "720p"),
                output_format: pick(p.outputFormat, ["mp4", "mov"], "mp4"),
                generate_audio: p.generateAudio ?? true, watermark: p.watermark ?? false, seed,
                ...(frameMode ? { image: first, last_frame_image: last } : {
                    reference_images: references, reference_videos: videos, reference_audios: audios,
                }),
            });
        }
        case "replicate-minimax-h3":
            // The authenticated model API currently returns latest_version:null.
            // Do not guess a request schema or submit paid predictions.
            throw new Error("MiniMax H3 is awaiting a published Replicate API schema");
        case "replicate-elevenlabs-dubbing": {
            checkCount(videos, 1, "Dubbing video"); checkCount(audios, 1, "Dubbing audio");
            if (images.length || videos.length + audios.length + Number(Boolean(p.sourceUrl)) !== 1) throw new Error("Dubbing requires exactly one audio/video reference or source URL");
            if (!p.targetLanguage?.trim()) throw new Error("Dubbing requires a target language");
            if (p.sourceUrl && !/^https?:\/\//i.test(p.sourceUrl)) throw new Error("Dubbing source URL must use HTTP or HTTPS");
            const strength = p.cloningStrength ?? 7;
            if (!Number.isInteger(strength) || strength < 0 || strength > 10) throw new Error("Cloning strength must be an integer from 0 to 10");
            return clean({ audio_or_video_file: videos[0] || audios[0], source_url: p.sourceUrl,
                source_language: pick(p.sourceLanguage, ["auto", ...DUBBING_LANGUAGES], "auto"),
                target_language: pick(p.targetLanguage, DUBBING_LANGUAGES), cloning_strength: strength });
        }
    }
}
