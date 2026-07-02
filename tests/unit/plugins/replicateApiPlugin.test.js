import test from "ava";
import ReplicateApiPlugin from "../../../server/plugins/replicateApiPlugin.js";

function createPlugin({
    pathwayName = "video_kling",
    modelName = "replicate-kling-v2.5-turbo-pro",
    metadata = {},
    inputParameters = {
        model: "replicate-kling-v2.5-turbo-pro",
        aspectRatio: "16:9",
        duration: 5,
        start_image: "",
        end_image: "",
        image: "",
        negativePrompt: "",
    },
} = {}) {
    const pathway = {
        name: pathwayName,
        model: modelName,
        prompt: { prompt: "{{text}}" },
        inputParameters,
    };

    const model = {
        name: modelName,
        type: "REPLICATE-API",
        metadata,
    };

    return new ReplicateApiPlugin(pathway, model);
}

test("ReplicateApiPlugin builds Kling request payload from explicit Kling fields", (t) => {
    const plugin = createPlugin();

    const request = plugin.getRequestParameters(
        "a woman is dancing",
        {
            model: "replicate-kling-v2.5-turbo-pro",
            aspectRatio: "9:16",
            duration: 10,
            start_image: "https://example.com/start.png",
            end_image: "https://example.com/end.png",
            negativePrompt: "blurry, distorted",
        },
        { prompt: "{{{text}}}" },
    );

    t.deepEqual(request, {
        input: {
            prompt: "a woman is dancing",
            aspect_ratio: "9:16",
            duration: 10,
            negative_prompt: "blurry, distorted",
            start_image: "https://example.com/start.png",
            end_image: "https://example.com/end.png",
        },
    });
});

test("ReplicateApiPlugin falls back to Kling defaults and deprecated image alias", (t) => {
    const plugin = createPlugin();

    const request = plugin.getRequestParameters(
        "a woman is dancing",
        {
            model: "replicate-kling-v2.5-turbo-pro",
            aspectRatio: "4:3",
            duration: 7,
            image: "https://example.com/start.png",
            negative_prompt: "low quality",
        },
        { prompt: "{{{text}}}" },
    );

    t.deepEqual(request, {
        input: {
            prompt: "a woman is dancing",
            aspect_ratio: "16:9",
            duration: 5,
            negative_prompt: "low quality",
            start_image: "https://example.com/start.png",
        },
    });
});

test("ReplicateApiPlugin exposes video artifacts for direct video outputs", (t) => {
    const plugin = createPlugin();

    const parsed = plugin.parseResponse({
        status: "succeeded",
        output: "https://replicate.delivery/example/video.mp4",
    });

    t.is(
        parsed.output_text,
        JSON.stringify({
            status: "succeeded",
            output: "https://replicate.delivery/example/video.mp4",
        }),
    );
    t.deepEqual(parsed.artifacts, [
        {
            type: "video",
            url: "https://replicate.delivery/example/video.mp4",
            mimeType: "video/mp4",
        },
    ]);
});

test("ReplicateApiPlugin builds ElevenLabs Music payload from API-backed audio controls", (t) => {
    const plugin = createPlugin({
        pathwayName: "music_replicate",
        modelName: "replicate-elevenlabs-music",
        inputParameters: {
            model: "replicate-elevenlabs-music",
            duration: 17,
            outputFormat: "wav_cd_quality",
            forceInstrumental: true,
        },
    });

    const request = plugin.getRequestParameters(
        "A 17 second orchestral news sting with cello and no vocals",
        {
            model: "replicate-elevenlabs-music",
            duration: 17,
            outputFormat: "wav_cd_quality",
            forceInstrumental: false,
        },
        { prompt: "{{{text}}}" },
    );

    t.deepEqual(request, {
        input: {
            prompt: "A 17 second orchestral news sting with cello and no vocals",
            output_format: "wav_cd_quality",
            music_length_ms: 17000,
            force_instrumental: false,
        },
    });
});

test("ReplicateApiPlugin normalizes ElevenLabs Music aliases and clamps duration length", (t) => {
    const plugin = createPlugin({
        pathwayName: "music_replicate",
        modelName: "replicate-elevenlabs-music",
    });

    const request = plugin.getRequestParameters(
        "short instrumental",
        {
            model: "replicate-elevenlabs-music",
            length: 2,
            outputFormat: "wav",
        },
        { prompt: "{{{text}}}" },
    );

    t.deepEqual(request, {
        input: {
            prompt: "short instrumental",
            output_format: "wav_cd_quality",
            music_length_ms: 5000,
            force_instrumental: true,
        },
    });
});

test("ReplicateApiPlugin builds MiniMax Music 2.6 payload from schema-backed controls", (t) => {
    const plugin = createPlugin({
        pathwayName: "music_replicate",
        modelName: "replicate-minimax-music-26",
    });

    const request = plugin.getRequestParameters(
        "cinematic newsroom theme with live strings",
        {
            model: "replicate-minimax-music-26",
            audioFormat: "wav",
            sampleRate: 44100,
            bitrate: 256000,
            isInstrumental: true,
            lyricsOptimizer: false,
        },
        { prompt: "{{text}}" },
    );

    t.deepEqual(request, {
        input: {
            prompt: "cinematic newsroom theme with live strings",
            bitrate: 256000,
            sample_rate: 44100,
            audio_format: "wav",
            is_instrumental: true,
            lyrics_optimizer: false,
        },
    });
});

test("ReplicateApiPlugin builds MiniMax Music Cover payload with selected audio URL", (t) => {
    const plugin = createPlugin({
        pathwayName: "music_replicate",
        modelName: "replicate-minimax-music-cover",
    });

    const request = plugin.getRequestParameters(
        "add cello and guitar while keeping the source arrangement",
        {
            model: "replicate-minimax-music-cover",
            inputAudioUrl: "https://example.com/source-theme.wav",
            audioFormat: "wav",
            sampleRate: 44100,
            bitrate: 256000,
        },
        { prompt: "{{text}}" },
    );

    t.deepEqual(request, {
        input: {
            audio_url: "https://example.com/source-theme.wav",
            prompt: "add cello and guitar while keeping the source arrangement",
        },
    });
});

test("ReplicateApiPlugin rejects MiniMax Music Cover without audio input", (t) => {
    const plugin = createPlugin({
        pathwayName: "music_replicate",
        modelName: "replicate-minimax-music-cover",
    });

    t.throws(
        () =>
            plugin.getRequestParameters(
                "cover it with strings",
                { model: "replicate-minimax-music-cover" },
                { prompt: "{{{text}}}" },
            ),
        {
            message: /requires a selected audio item or audio_url/,
        },
    );
});

test("ReplicateApiPlugin explains MiniMax Music Cover analysis failures", (t) => {
    const plugin = createPlugin({
        pathwayName: "music_replicate",
        modelName: "replicate-minimax-music-cover",
    });

    const message = plugin.getPredictionFailureMessage(
        "failed",
        "Async prediction failed: Cover mode requires dtw_result, beat_result, and audio_duration in the request",
    );

    t.regex(message, /could not analyze the selected audio/);
    t.regex(message, /source song with detectable timing\/beat data/);
});

test("ReplicateApiPlugin exposes named audio artifacts from object outputs", (t) => {
    const plugin = createPlugin();

    const parsed = plugin.parseResponse({
        status: "succeeded",
        output: {
            drums: "https://replicate.delivery/example/drums.wav",
            piano: "https://replicate.delivery/example/piano.wav",
        },
    });

    t.deepEqual(parsed.artifacts, [
        {
            type: "audio",
            url: "https://replicate.delivery/example/drums.wav",
            mimeType: "audio/wav",
            key: "drums",
        },
        {
            type: "audio",
            url: "https://replicate.delivery/example/piano.wav",
            mimeType: "audio/wav",
            key: "piano",
        },
    ]);
});

test("ReplicateApiPlugin treats extensionless music outputs as audio artifacts", (t) => {
    const plugin = createPlugin({
        pathwayName: "music_replicate",
        modelName: "replicate-minimax-music-26",
        inputParameters: {
            model: "replicate-minimax-music-26",
            audioFormat: "wav",
        },
    });

    const parsed = plugin.parseResponse({
        status: "succeeded",
        output: "https://replicate.delivery/predictions/music-output",
    });

    t.deepEqual(parsed.artifacts, [
        {
            type: "audio",
            url: "https://replicate.delivery/predictions/music-output",
            mimeType: "audio/wav",
        },
    ]);
});

test("ReplicateApiPlugin ignores non-url strings in nested music outputs", (t) => {
    const plugin = createPlugin({
        pathwayName: "music_replicate",
        modelName: "replicate-minimax-music-26",
    });

    const parsed = plugin.parseResponse({
        status: "succeeded",
        output: {
            audio: "https://replicate.delivery/predictions/music-output",
            lyrics: "verse one and chorus",
        },
    });

    t.deepEqual(parsed.artifacts, [
        {
            type: "audio",
            url: "https://replicate.delivery/predictions/music-output",
            mimeType: "audio/mpeg",
            key: "audio",
        },
    ]);
});

test("ReplicateApiPlugin builds Qwen3 TTS custom voice payload", (t) => {
    const plugin = createPlugin({
        pathwayName: "tts_replicate",
        modelName: "replicate-qwen3-tts",
        metadata: { category: "tts" },
    });

    const request = plugin.getRequestParameters(
        "Hello, I'm Aiden and it's very nice to meet you",
        {
            model: "replicate-qwen3-tts",
            mode: "custom_voice",
            language: "English",
            speaker: "Aiden",
            styleInstruction: "speak warmly and clearly",
        },
        { prompt: "{{{text}}}" },
    );

    t.deepEqual(request, {
        input: {
            mode: "custom_voice",
            text: "Hello, I'm Aiden and it's very nice to meet you",
            language: "English",
            speaker: "Aiden",
            style_instruction: "speak warmly and clearly",
        },
    });
});

test("ReplicateApiPlugin builds Qwen3 TTS voice clone payload and requires reference audio", (t) => {
    const plugin = createPlugin({
        pathwayName: "tts_replicate",
        modelName: "replicate-qwen3-tts",
        metadata: { category: "tts" },
    });

    const request = plugin.getRequestParameters(
        "Read this in the referenced voice.",
        {
            model: "replicate-qwen3-tts",
            mode: "voice_clone",
            inputAudioUrl: "https://example.com/reference.wav",
            referenceText: "Original voice sample transcript.",
        },
        { prompt: "{{text}}" },
    );

    t.deepEqual(request, {
        input: {
            mode: "voice_clone",
            text: "Read this in the referenced voice.",
            language: "auto",
            reference_audio: "https://example.com/reference.wav",
            reference_text: "Original voice sample transcript.",
        },
    });

    t.throws(
        () =>
            plugin.getRequestParameters(
                "clone without reference",
                { model: "replicate-qwen3-tts", mode: "voice_clone" },
                { prompt: "{{{text}}}" },
            ),
        {
            message: /requires reference_audio or a selected audio item/,
        },
    );
});

test("ReplicateApiPlugin builds Qwen3 TTS voice design payload and requires description", (t) => {
    const plugin = createPlugin({
        pathwayName: "tts_replicate",
        modelName: "replicate-qwen3-tts",
        metadata: { category: "tts" },
    });

    const request = plugin.getRequestParameters(
        "Welcome to the evening bulletin.",
        {
            model: "replicate-qwen3-tts",
            mode: "voice_design",
            language: "English",
            voiceDescription: "A warm, authoritative presenter voice",
            styleInstruction: "measured newsreader delivery",
        },
        { prompt: "{{text}}" },
    );

    t.deepEqual(request, {
        input: {
            mode: "voice_design",
            text: "Welcome to the evening bulletin.",
            language: "English",
            voice_description: "A warm, authoritative presenter voice",
            style_instruction: "measured newsreader delivery",
        },
    });

    t.throws(
        () =>
            plugin.getRequestParameters(
                "design without description",
                { model: "replicate-qwen3-tts", mode: "voice_design" },
                { prompt: "{{{text}}}" },
            ),
        {
            message: /requires voice_description/,
        },
    );
});

test("ReplicateApiPlugin treats extensionless Qwen3 TTS outputs as audio artifacts", (t) => {
    const plugin = createPlugin({
        pathwayName: "tts_replicate",
        modelName: "replicate-qwen3-tts",
        metadata: { category: "tts" },
    });

    const parsed = plugin.parseResponse({
        status: "succeeded",
        output: "https://replicate.delivery/predictions/qwen3-tts-output",
    });

    t.deepEqual(parsed.artifacts, [
        {
            type: "audio",
            url: "https://replicate.delivery/predictions/qwen3-tts-output",
            mimeType: "audio/mpeg",
        },
    ]);
});

test("ReplicateApiPlugin builds ElevenLabs v3 TTS payload with voice controls", (t) => {
    const plugin = createPlugin({
        pathwayName: "tts_replicate",
        modelName: "replicate-elevenlabs-v3",
        metadata: { category: "tts" },
    });

    const request = plugin.getRequestParameters(
        "In the ancient land of Eldoria, lived a gentle dragon named Zephyros.",
        {
            model: "replicate-elevenlabs-v3",
            voice: "Grimblewood",
            stability: 0.6,
            similarityBoost: 0.8,
            style: 0.25,
            speed: 1.1,
            previousText: "A storyteller began.",
            nextText: "The forest listened.",
            languageCode: "en",
        },
        { prompt: "{{{text}}}" },
    );

    t.deepEqual(request, {
        input: {
            prompt: "In the ancient land of Eldoria, lived a gentle dragon named Zephyros.",
            voice: "Grimblewood",
            stability: 0.6,
            similarity_boost: 0.8,
            style: 0.25,
            speed: 1.1,
            previous_text: "A storyteller began.",
            next_text: "The forest listened.",
            language_code: "en",
        },
    });
});

test("ReplicateApiPlugin builds MiniMax Speech 2.8 TTS payload with audio controls", (t) => {
    const plugin = createPlugin({
        pathwayName: "tts_replicate",
        modelName: "replicate-minimax-speech-2.8-turbo",
        metadata: { category: "tts" },
    });

    const request = plugin.getRequestParameters(
        "Hello world! This is MiniMax's new text to speech model.",
        {
            model: "replicate-minimax-speech-2.8-turbo",
            voiceId: "Wise_Woman",
            speed: 1.25,
            volume: 1.5,
            pitch: -2,
            emotion: "calm",
            englishNormalization: true,
            sampleRate: 44100,
            bitrate: 256000,
            audioFormat: "wav",
            channel: "stereo",
            subtitleEnable: true,
            languageBoost: "English",
        },
        { prompt: "{{{text}}}" },
    );

    t.deepEqual(request, {
        input: {
            text: "Hello world! This is MiniMax's new text to speech model.",
            voice_id: "Wise_Woman",
            speed: 1.25,
            volume: 1.5,
            pitch: -2,
            emotion: "calm",
            english_normalization: true,
            sample_rate: 44100,
            bitrate: 256000,
            audio_format: "wav",
            channel: "stereo",
            subtitle_enable: true,
            language_boost: "English",
        },
    });
});

test("ReplicateApiPlugin uses MiniMax custom cloned voice IDs when selected", (t) => {
    const plugin = createPlugin({
        pathwayName: "tts_replicate",
        modelName: "replicate-minimax-speech-2.8-hd",
        metadata: { category: "tts" },
    });

    const request = plugin.getRequestParameters(
        "Read this in a cloned voice.",
        {
            model: "replicate-minimax-speech-2.8-hd",
            voiceId: "__custom",
            customVoiceId: "voice-clone-123",
        },
        { prompt: "{{{text}}}" },
    );

    t.is(request.input.voice_id, "voice-clone-123");
});

test("ReplicateApiPlugin logs token counts from output_text for artifact responses", (t) => {
    const plugin = createPlugin();
    const responseData = {
        status: "succeeded",
        output: "https://replicate.delivery/example/video.mp4",
    };
    const countedValues = [];

    plugin.getLength = (value) => {
        countedValues.push(value);
        t.is(typeof value, "string");
        return { length: value.length, units: "characters" };
    };

    t.notThrows(() => {
        plugin.logRequestData(
            { input: { prompt: "a woman is dancing" } },
            responseData,
            {},
        );
    });

    t.deepEqual(countedValues, [
        "a woman is dancing",
        JSON.stringify(responseData),
    ]);
});

test("ReplicateApiPlugin builds Grok Imagine video payload for text or image generation", (t) => {
    const plugin = createPlugin({
        pathwayName: "video_grok_imagine",
        modelName: "replicate-grok-imagine-video",
        inputParameters: {
            model: "replicate-grok-imagine-video",
            aspectRatio: "auto",
            duration: 5,
            resolution: "720p",
            image: "",
            video: "",
        },
    });

    const request = plugin.getRequestParameters(
        "a penguin walks away from the camera",
        {
            model: "replicate-grok-imagine-video",
            aspectRatio: "16:9",
            duration: 12,
            resolution: "480p",
            image: "https://example.com/penguin.png",
        },
        { prompt: "{{text}}" },
    );

    t.deepEqual(request, {
        input: {
            prompt: "a penguin walks away from the camera",
            image: "https://example.com/penguin.png",
            duration: 12,
            resolution: "480p",
            aspect_ratio: "16:9",
        },
    });
});

test("ReplicateApiPlugin omits Grok Imagine generation-only fields in video edit mode", (t) => {
    const plugin = createPlugin({
        pathwayName: "video_grok_imagine",
        modelName: "replicate-grok-imagine-video",
        inputParameters: {
            model: "replicate-grok-imagine-video",
            aspectRatio: "auto",
            duration: 5,
            resolution: "720p",
            image: "",
            video: "",
        },
    });

    const request = plugin.getRequestParameters(
        "make the scene more dramatic",
        {
            model: "replicate-grok-imagine-video",
            aspectRatio: "3:4",
            duration: 15,
            resolution: "480p",
            video: "https://example.com/input.mp4",
        },
        { prompt: "{{text}}" },
    );

    t.deepEqual(request, {
        input: {
            prompt: "make the scene more dramatic",
            video: "https://example.com/input.mp4",
        },
    });
});

test("ReplicateApiPlugin builds DreamActor M2.0 payload from image and video inputs", (t) => {
    const plugin = createPlugin({
        pathwayName: "video_dreamactor",
        modelName: "replicate-dreamactor-m2.0",
        inputParameters: {
            model: "replicate-dreamactor-m2.0",
            image: "",
            video: "",
            cut_first_second: true,
        },
    });

    const request = plugin.getRequestParameters(
        "",
        {
            model: "replicate-dreamactor-m2.0",
            image: "https://example.com/subject.png",
            video: "https://example.com/template.mp4",
            cutFirstSecond: false,
        },
        { prompt: "" },
    );

    t.deepEqual(request, {
        input: {
            image: "https://example.com/subject.png",
            video: "https://example.com/template.mp4",
            cut_first_second: false,
        },
    });
});

test("ReplicateApiPlugin rejects DreamActor M2.0 without required media inputs", (t) => {
    const plugin = createPlugin({
        pathwayName: "video_dreamactor",
        modelName: "replicate-dreamactor-m2.0",
        inputParameters: {
            model: "replicate-dreamactor-m2.0",
            image: "",
            video: "",
            cut_first_second: true,
        },
    });

    const error = t.throws(() =>
        plugin.getRequestParameters(
            "",
            {
                model: "replicate-dreamactor-m2.0",
                image: "https://example.com/subject.png",
            },
            { prompt: "" },
        ),
    );

    t.regex(error.message, /requires both image and video/);
});

test("ReplicateApiPlugin builds P-Video Avatar payload from generated voice controls", (t) => {
    const plugin = createPlugin({
        pathwayName: "video_avatar",
        modelName: "replicate-p-video-avatar",
        inputParameters: {
            model: "replicate-p-video-avatar",
            image: "",
            audio: "",
            voice: "Zephyr (Female)",
            voice_script: "",
            voice_language: "English (US)",
            voice_prompt: "Say the following.",
            resolution: "720p",
            video_prompt: "The person is talking.",
            negative_prompt: "",
            strength_negative_prompt: 0.5,
            disable_safety_filter: true,
            disable_prompt_upsampling: false,
            no_op: false,
        },
    });

    const request = plugin.getRequestParameters(
        "",
        {
            model: "replicate-p-video-avatar",
            image: "https://example.com/avatar.jpeg",
            voice: "Kore (Female)",
            voiceScript: "Bienvenue sur SuiteLodge.",
            voiceLanguage: "French",
            voicePrompt: "Warm and confident",
            videoPrompt: "The person speaks directly to camera.",
            resolution: "1080p",
            negativePrompt: "subtitles, watermark",
            strengthNegativePrompt: 0.75,
            disableSafetyFilter: false,
            disablePromptUpsampling: true,
            seed: 99,
        },
        { prompt: "" },
    );

    t.deepEqual(request, {
        input: {
            image: "https://example.com/avatar.jpeg",
            voice: "Kore (Female)",
            voice_script: "Bienvenue sur SuiteLodge.",
            voice_language: "French",
            voice_prompt: "Warm and confident",
            resolution: "1080p",
            video_prompt: "The person speaks directly to camera.",
            negative_prompt: "subtitles, watermark",
            strength_negative_prompt: 0.75,
            disable_safety_filter: false,
            disable_prompt_upsampling: true,
            no_op: false,
            seed: 99,
        },
    });
});

test("ReplicateApiPlugin builds P-Video Avatar payload from uploaded audio", (t) => {
    const plugin = createPlugin({
        pathwayName: "video_avatar",
        modelName: "replicate-p-video-avatar",
        inputParameters: {
            model: "replicate-p-video-avatar",
            image: "",
            audio: "",
            voice: "Zephyr (Female)",
            voice_script: "",
            voice_language: "English (US)",
            voice_prompt: "Say the following.",
            resolution: "720p",
            video_prompt: "The person is talking.",
            negative_prompt: "",
            strength_negative_prompt: 0.5,
            disable_safety_filter: true,
            disable_prompt_upsampling: false,
            no_op: false,
        },
    });

    const request = plugin.getRequestParameters(
        "",
        {
            model: "replicate-p-video-avatar",
            image: "https://example.com/avatar.png",
            inputAudioUrl: "https://example.com/voice.wav",
            voice: "Kore (Female)",
            voiceScript: "This should be ignored.",
            voiceLanguage: "French",
        },
        { prompt: "" },
    );

    t.deepEqual(request, {
        input: {
            image: "https://example.com/avatar.png",
            audio: "https://example.com/voice.wav",
            resolution: "720p",
            video_prompt: "The person is talking.",
            negative_prompt: "",
            strength_negative_prompt: 0.5,
            disable_safety_filter: true,
            disable_prompt_upsampling: false,
            no_op: false,
        },
    });
});

test("ReplicateApiPlugin validates P-Video Avatar required media and schema controls", (t) => {
    const plugin = createPlugin({
        pathwayName: "video_avatar",
        modelName: "replicate-p-video-avatar",
        inputParameters: {
            model: "replicate-p-video-avatar",
            image: "",
            audio: "",
            voice: "Zephyr (Female)",
            voice_script: "",
            voice_language: "English (US)",
            voice_prompt: "Say the following.",
            resolution: "720p",
            video_prompt: "The person is talking.",
            negative_prompt: "",
            strength_negative_prompt: 0.5,
            disable_safety_filter: true,
            disable_prompt_upsampling: false,
            no_op: false,
        },
    });

    const request = plugin.getRequestParameters(
        "",
        {
            model: "replicate-p-video-avatar",
            image: "https://example.com/avatar.png",
            voice: "Unknown",
            voiceScript: "Hello.",
            voiceLanguage: "Elvish",
            resolution: "4k",
            strengthNegativePrompt: 9,
            disableSafetyFilter: "false",
            disablePromptUpsampling: "true",
        },
        { prompt: "" },
    );

    t.deepEqual(request, {
        input: {
            image: "https://example.com/avatar.png",
            voice: "Zephyr (Female)",
            voice_script: "Hello.",
            voice_language: "English (US)",
            voice_prompt: "Say the following.",
            resolution: "720p",
            video_prompt: "The person is talking.",
            negative_prompt: "",
            strength_negative_prompt: 4,
            disable_safety_filter: true,
            disable_prompt_upsampling: false,
            no_op: false,
        },
    });

    t.regex(
        t.throws(() =>
            plugin.getRequestParameters(
                "",
                { model: "replicate-p-video-avatar" },
                { prompt: "" },
            ),
        ).message,
        /requires an image input/,
    );

    t.regex(
        t.throws(() =>
            plugin.getRequestParameters(
                "",
                {
                    model: "replicate-p-video-avatar",
                    image: "https://example.com/avatar.png",
                },
                { prompt: "" },
            ),
        ).message,
        /requires either audio or voice_script/,
    );
});

test("ReplicateApiPlugin builds Video Upscaler payload with schema controls", (t) => {
    const plugin = createPlugin({
        pathwayName: "video_upscaler",
        modelName: "replicate-video-upscaler",
        inputParameters: {
            model: "replicate-video-upscaler",
            video: "",
            processing_type: "standard",
            scene: "aigc",
            target_resolution: "4k",
            target_fps: 60,
        },
    });

    const request = plugin.getRequestParameters(
        "",
        {
            model: "replicate-video-upscaler",
            video: "https://example.com/source.mp4",
            processingType: "pro",
            scene: "ugc",
            targetResolution: "1080p",
            targetFps: 120,
        },
        { prompt: "" },
    );

    t.deepEqual(request, {
        input: {
            video: "https://example.com/source.mp4",
            processing_type: "pro",
            scene: "ugc",
            target_resolution: "1080p",
            target_fps: 120,
        },
    });
});

test("ReplicateApiPlugin falls back Video Upscaler invalid controls and requires video", (t) => {
    const plugin = createPlugin({
        pathwayName: "video_upscaler",
        modelName: "replicate-video-upscaler",
        inputParameters: {
            model: "replicate-video-upscaler",
            video: "",
            processing_type: "standard",
            scene: "aigc",
            target_resolution: "4k",
            target_fps: 60,
        },
    });

    const request = plugin.getRequestParameters(
        "",
        {
            model: "replicate-video-upscaler",
            video: "https://example.com/source.mp4",
            processingType: "ultra",
            scene: "unknown",
            targetResolution: "8k",
            targetFps: 59,
        },
        { prompt: "" },
    );

    t.deepEqual(request, {
        input: {
            video: "https://example.com/source.mp4",
            processing_type: "standard",
            scene: "aigc",
            target_resolution: "4k",
            target_fps: 60,
        },
    });

    const error = t.throws(() =>
        plugin.getRequestParameters(
            "",
            {
                model: "replicate-video-upscaler",
            },
            { prompt: "" },
        ),
    );

    t.regex(error.message, /requires a video input/);
});

test("ReplicateApiPlugin builds Topaz Image Upscale payload with schema controls", (t) => {
    const plugin = createPlugin({
        pathwayName: "image_upscaler",
        modelName: "replicate-topaz-image-upscale",
        inputParameters: {
            model: "replicate-topaz-image-upscale",
            image: "",
            enhance_model: "Standard V2",
            upscale_factor: "None",
            output_format: "jpg",
            subject_detection: "None",
            face_enhancement: false,
            face_enhancement_creativity: 0,
            face_enhancement_strength: 0.8,
        },
    });

    const request = plugin.getRequestParameters(
        "",
        {
            model: "replicate-topaz-image-upscale",
            image: "https://example.com/source.webp",
            enhanceModel: "Low Resolution V2",
            upscaleFactor: "4x",
            faceEnhancement: true,
            subjectDetection: "Foreground",
            faceEnhancementCreativity: 0.5,
        },
        { prompt: "" },
    );

    t.deepEqual(request, {
        input: {
            image: "https://example.com/source.webp",
            enhance_model: "Low Resolution V2",
            upscale_factor: "4x",
            output_format: "jpg",
            subject_detection: "Foreground",
            face_enhancement: true,
            face_enhancement_creativity: 0.5,
            face_enhancement_strength: 0.8,
        },
    });
});

test("ReplicateApiPlugin falls back Topaz Image Upscale invalid controls and requires image", (t) => {
    const plugin = createPlugin({
        pathwayName: "image_upscaler",
        modelName: "replicate-topaz-image-upscale",
        inputParameters: {
            model: "replicate-topaz-image-upscale",
            image: "",
            enhance_model: "Standard V2",
            upscale_factor: "None",
            output_format: "jpg",
            subject_detection: "None",
            face_enhancement: false,
            face_enhancement_creativity: 0,
            face_enhancement_strength: 0.8,
        },
    });

    const request = plugin.getRequestParameters(
        "",
        {
            model: "replicate-topaz-image-upscale",
            image: "https://example.com/source.webp",
            enhanceModel: "Unsupported",
            upscaleFactor: "8x",
            outputFormat: "webp",
            subjectDetection: "Person",
            faceEnhancement: "yes",
            faceEnhancementCreativity: 5,
            faceEnhancementStrength: -1,
        },
        { prompt: "" },
    );

    t.deepEqual(request, {
        input: {
            image: "https://example.com/source.webp",
            enhance_model: "Standard V2",
            upscale_factor: "None",
            output_format: "jpg",
            subject_detection: "None",
            face_enhancement: false,
            face_enhancement_creativity: 1,
            face_enhancement_strength: 0,
        },
    });

    const error = t.throws(() =>
        plugin.getRequestParameters(
            "",
            {
                model: "replicate-topaz-image-upscale",
            },
            { prompt: "" },
        ),
    );

    t.regex(error.message, /requires an image input/);
});

test("ReplicateApiPlugin builds Topaz Video Upscale payload with schema controls", (t) => {
    const plugin = createPlugin({
        pathwayName: "video_upscaler",
        modelName: "replicate-topaz-video-upscale",
        inputParameters: {
            model: "replicate-topaz-video-upscale",
            video: "",
            target_resolution: "1080p",
            target_fps: 30,
        },
    });

    const request = plugin.getRequestParameters(
        "",
        {
            model: "replicate-topaz-video-upscale",
            video: "https://example.com/source.mp4",
            targetResolution: "4k",
            targetFps: 60,
        },
        { prompt: "" },
    );

    t.deepEqual(request, {
        input: {
            video: "https://example.com/source.mp4",
            target_resolution: "4k",
            target_fps: 60,
        },
    });
});

test("ReplicateApiPlugin falls back Topaz Video Upscale invalid controls and requires video", (t) => {
    const plugin = createPlugin({
        pathwayName: "video_upscaler",
        modelName: "replicate-topaz-video-upscale",
        inputParameters: {
            model: "replicate-topaz-video-upscale",
            video: "",
            target_resolution: "1080p",
            target_fps: 30,
        },
    });

    const request = plugin.getRequestParameters(
        "",
        {
            model: "replicate-topaz-video-upscale",
            video: "https://example.com/source.mp4",
            targetResolution: "8k",
            targetFps: 120,
        },
        { prompt: "" },
    );

    t.deepEqual(request, {
        input: {
            video: "https://example.com/source.mp4",
            target_resolution: "1080p",
            target_fps: 60,
        },
    });

    const error = t.throws(() =>
        plugin.getRequestParameters(
            "",
            {
                model: "replicate-topaz-video-upscale",
            },
            { prompt: "" },
        ),
    );

    t.regex(error.message, /requires a video input/);
});

test("ReplicateApiPlugin keeps Topaz Video Upscale defaults separate from shared pathway defaults", (t) => {
    const plugin = createPlugin({
        pathwayName: "video_upscaler",
        modelName: "replicate-topaz-video-upscale",
        inputParameters: {
            model: "replicate-video-upscaler",
            video: "",
            target_resolution: "4k",
            target_fps: 60,
        },
    });

    const request = plugin.getRequestParameters(
        "",
        {
            model: "replicate-topaz-video-upscale",
            video: "https://example.com/source.mp4",
        },
        { prompt: "" },
    );

    t.deepEqual(request, {
        input: {
            video: "https://example.com/source.mp4",
            target_resolution: "1080p",
            target_fps: 30,
        },
    });
});

test("ReplicateApiPlugin builds Seedream 4.5 payload with supported fields only", (t) => {
    const plugin = createPlugin({
        pathwayName: "image_seedream45",
        modelName: "replicate-seedream-4.5",
        inputParameters: {
            model: "replicate-seedream-4.5",
            size: "2K",
            aspectRatio: "match_input_image",
            maxImages: 1,
            numberResults: 1,
            imageInput: [],
            input_image: "",
            input_image_1: "",
            input_image_2: "",
            input_image_3: "",
            sequentialImageGeneration: "disabled",
            disableSafetyChecker: false,
        },
    });

    const request = plugin.getRequestParameters(
        "A warm, nostalgic cafe interior",
        {
            model: "replicate-seedream-4.5",
            size: "4K",
            aspectRatio: "21:9",
            numberResults: 3,
            input_image: "https://example.com/reference-1.png",
            input_image_2: "https://example.com/reference-2.png",
            sequentialImageGeneration: "auto",
            disableSafetyChecker: true,
            width: 4096,
            height: 2048,
            seed: 123,
        },
        { prompt: "{{text}}" },
    );

    t.deepEqual(request, {
        input: {
            prompt: "A warm, nostalgic cafe interior",
            size: "4K",
            max_images: 3,
            aspect_ratio: "21:9",
            sequential_image_generation: "auto",
            disable_safety_checker: true,
            image_input: [
                "https://example.com/reference-1.png",
                "https://example.com/reference-2.png",
            ],
        },
    });
});

test("ReplicateApiPlugin builds Seedream 5 Lite payload with output format", (t) => {
    const plugin = createPlugin({
        pathwayName: "image_seedream5lite",
        modelName: "replicate-seedream-5-lite",
        inputParameters: {
            model: "replicate-seedream-5-lite",
            size: "2K",
            aspectRatio: "match_input_image",
            output_format: "png",
            maxImages: 1,
            numberResults: 1,
            imageInput: [],
            input_image: "",
            input_image_1: "",
            input_image_2: "",
            input_image_3: "",
            sequentialImageGeneration: "disabled",
        },
    });

    const request = plugin.getRequestParameters(
        "A floral haute couture editorial portrait",
        {
            model: "replicate-seedream-5-lite",
            size: "3K",
            aspectRatio: "2:3",
            output_format: "jpeg",
            numberResults: 2,
            input_image: "https://example.com/look-1.png",
            sequentialImageGeneration: "auto",
            disableSafetyChecker: true,
            seed: 55,
        },
        { prompt: "{{text}}" },
    );

    t.deepEqual(request, {
        input: {
            prompt: "A floral haute couture editorial portrait",
            size: "3K",
            max_images: 2,
            aspect_ratio: "2:3",
            sequential_image_generation: "auto",
            output_format: "jpeg",
            image_input: ["https://example.com/look-1.png"],
        },
    });
});

test("ReplicateApiPlugin builds Seedance 2.0 payload with reference media", (t) => {
    const plugin = createPlugin({
        pathwayName: "video_seedance",
        modelName: "replicate-seedance-2.0",
        inputParameters: {
            model: "replicate-seedance-2.0",
            aspectRatio: "16:9",
            duration: 5,
            resolution: "720p",
            generate_audio: true,
            image: "",
            last_frame_image: "",
            reference_images: [],
            reference_videos: [],
            reference_audios: [],
            seed: null,
        },
    });

    const request = plugin.getRequestParameters(
        "A cozy cabin in a snowy forest at night",
        {
            model: "replicate-seedance-2.0",
            aspectRatio: "adaptive",
            duration: 7,
            resolution: "480p",
            generateAudio: false,
            reference_images: [
                "https://example.com/character.png",
                "https://example.com/style.png",
            ],
            reference_videos: ["https://example.com/motion.mp4"],
            reference_audios: ["https://example.com/music.mp3"],
            seed: 99,
        },
        { prompt: "{{text}}" },
    );

    t.deepEqual(request, {
        input: {
            prompt: "A cozy cabin in a snowy forest at night",
            duration: 7,
            resolution: "480p",
            aspect_ratio: "adaptive",
            generate_audio: false,
            seed: 99,
            reference_images: [
                "https://example.com/character.png",
                "https://example.com/style.png",
            ],
            reference_videos: ["https://example.com/motion.mp4"],
            reference_audios: ["https://example.com/music.mp3"],
        },
    });
});

test("ReplicateApiPlugin applies Seedance 2.0 schema defaults and expanded enums", (t) => {
    const plugin = createPlugin({
        pathwayName: "video_seedance",
        modelName: "replicate-seedance-2.0",
        inputParameters: {
            model: "replicate-seedance-2.0",
            aspectRatio: "16:9",
            duration: 5,
            resolution: "720p",
            generate_audio: false,
            image: "",
            last_frame_image: "",
            reference_images: [],
            reference_videos: [],
            reference_audios: [],
            seed: null,
        },
    });

    const request = plugin.getRequestParameters(
        "A lighthouse on a stormy alien coast",
        {
            model: "replicate-seedance-2.0",
            aspectRatio: "9:21",
            duration: 3,
            resolution: "4k",
            reference_audios: ["https://example.com/dialogue.mp3"],
        },
        { prompt: "{{text}}" },
    );

    t.deepEqual(request, {
        input: {
            prompt: "A lighthouse on a stormy alien coast",
            duration: 3,
            resolution: "4k",
            aspect_ratio: "9:21",
            generate_audio: true,
        },
    });
});

test("ReplicateApiPlugin builds Seedance 2.0 Fast payload with fast schema limits", (t) => {
    const plugin = createPlugin({
        pathwayName: "video_seedance",
        modelName: "replicate-seedance-2.0-fast",
        inputParameters: {
            model: "replicate-seedance-2.0-fast",
            aspectRatio: "16:9",
            duration: 5,
            resolution: "720p",
            generate_audio: false,
            image: "",
            last_frame_image: "",
            reference_images: [],
            reference_videos: [],
            reference_audios: [],
            seed: null,
        },
    });

    const request = plugin.getRequestParameters(
        "x".repeat(4001),
        {
            model: "replicate-seedance-2.0-fast",
            aspectRatio: "9:21",
            duration: 7,
            resolution: "1080p",
            seed: 99,
        },
        { prompt: "{{text}}" },
    );

    t.is(request.input.prompt.length, 4001);
    t.is(request.input.duration, 7);
    t.is(request.input.resolution, "720p");
    t.is(request.input.aspect_ratio, "9:21");
    t.is(request.input.generate_audio, true);
    t.is(request.input.seed, 99);
});

test("ReplicateApiPlugin builds Seedance 2.0 Mini payload with mini schema limits", (t) => {
    const plugin = createPlugin({
        pathwayName: "video_seedance",
        modelName: "replicate-seedance-2.0-mini",
        inputParameters: {
            model: "replicate-seedance-2.0-mini",
            aspectRatio: "16:9",
            duration: 5,
            resolution: "720p",
            generate_audio: false,
            image: "",
            last_frame_image: "",
            reference_images: [],
            reference_videos: [],
            reference_audios: [],
            seed: null,
        },
    });

    const request = plugin.getRequestParameters(
        "x".repeat(4001),
        {
            model: "replicate-seedance-2.0-mini",
            duration: -1,
            resolution: "4k",
        },
        { prompt: "{{text}}" },
    );

    t.is(request.input.prompt.length, 4000);
    t.is(request.input.duration, -1);
    t.is(request.input.resolution, "720p");
    t.is(request.input.generate_audio, true);
});

test("ReplicateApiPlugin caps Seedance 2.0 prompt length at provider schema limit", (t) => {
    const plugin = createPlugin({
        pathwayName: "video_seedance",
        modelName: "replicate-seedance-2.0",
        inputParameters: {
            model: "replicate-seedance-2.0",
            aspectRatio: "16:9",
            duration: 5,
            resolution: "720p",
            generate_audio: true,
            image: "",
            last_frame_image: "",
            reference_images: [],
            reference_videos: [],
            reference_audios: [],
            seed: null,
        },
    });

    const request = plugin.getRequestParameters(
        "x".repeat(4001),
        {
            model: "replicate-seedance-2.0",
        },
        { prompt: "{{text}}" },
    );

    t.is(request.input.prompt.length, 4000);
});
