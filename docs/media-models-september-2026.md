# September media model update

This update adds GPT Image 2.5 Flare/Sunburst, Wan 3.0, P-Video-2-Pro, P-Video-2, and FLUX 3 through Replicate; Gemini 3.5 Transcribe through Google; optional Scribe v2 through Replicate; and a configurable MAI-Image-2.6-Flash route through Azure Foundry. These new Replicate routes use a Replicate key. Existing direct OpenAI routes still require `OPENAI_API_KEY`.

Provider schemas captured on September 18 are in `tests/fixtures/september-media-schemas.json`. Contract tests exercise metadata through the real resolver, request mapping, and output parsing. These are integration contract checks, not comparative quality or latency results.

## Configuration and rollout

- Replicate generation requires the existing `REPLICATE_API_KEY`.
- Gemini 3.5 Transcribe uses Cortex's `GEMINI_API_KEY`. Enable its Concierge menu and task route with `ENABLE_GEMINI_35_TRANSCRIBE=true` on web and workers after testing the deployed route.
- Scribe v2 uses the existing Replicate key. `ENABLE_SCRIBE_V2_TRANSCRIBE=true` enables the optional Concierge trial on web and workers. Neither transcription addition changes the default. Test Arabic names, code-switching, long recordings, and subtitle timing before changing the default.
- MAI requires `AZURE_MAI_IMAGE_ENDPOINT` (the `https://<resource>.services.ai.azure.com` origin), `AZURE_MAI_IMAGE_KEY`, and `AZURE_MAI_IMAGE_DEPLOYMENT`. All three are required for picker availability. Provisioning, quota approval, and live qualification are separate from this code change.
- Omni's canonical ID is `gemini-omni-1.1-flash`. Both old preview IDs retain their pathways and now select the stable upstream model on the existing Google/Vertex route. First/end frames are ordered explicitly. Extension sends `generation_config.video_config.task=extend`. Uploaded extension videos must be at most 10 seconds. No standalone audio input is supported by the GA model.
- Lyria 3.5 now carries its GA label. Lyria 3 Pro hides only when Lyria 3.5's key is configured. A configured key is an availability check, not a live-generation health check.

The deprecated picker choices retain execution IDs and metadata for saved jobs/history. Seedance 1/1.5 hide when Seedance 2.5 is configured; Gemini 2.5 Flash Image hides when Gemini 3.1 Flash Image is configured. Kling 2.5 and Seedream 4/4.5 are unchanged.

GPT Image 2 remains the default. Compare quality, cost and reliability in your deployment before changing defaults. Voice models, Veo, Lyria Clip, Qwen Image Edit 2511, covers, avatars, SVG and upscalers are retained.

## Input details

- GPT Image 2.5: up to 10 image references and 10 outputs; transparent output requires PNG/WebP. Arbitrary parameters, user IDs, and direct-vendor API keys are never forwarded. Large pixel sizes are experimental.
- Wan 3: text or one first frame, 2–30 seconds, 480p/720p/1080p. No video editing or audio-input controls.
- P-Video-2-Pro: first/end frames, speed/quality, 5–15 seconds, 480p/768p, off/turbo/max prompt expansion.
- P-Video-2: first/end frames, one audio reference, 1–20 seconds or automatic duration, 720p/1080p, 24/48 FPS, draft and output-audio controls. Audio input determines duration. Safety filtering is enabled explicitly.
- FLUX 3: up to 10 ordered storyboard images OR one continuation video. Three or more images require an explicit duration. Draft mode uses 720p. The provider limits continuation input to 15 seconds/50 MB.
- MAI: one PNG/JPEG reference, PNG output, at least 768px per dimension and at most 1,048,576 pixels. Dimensions apply to generation, not editing. Web grounding is opt-in.
- Dedicated ASR pathways support text, VTT/SRT, and JSON word records. The existing subtitle segmentation is reused. The API-only `diarize` and `vocabulary` arguments are available for evaluation; Gemini vocabulary is incompatible with timestamps/diarization. Speaker labels are scoped per chunk rather than falsely matching people across chunks. Temporary Google uploads are deleted after success or failure. Non-completed responses or missing/invalid timestamps fail explicitly.

## Sources

- https://replicate.com/openai/gpt-image-2.5-flare
- https://replicate.com/openai/gpt-image-2.5-sunburst
- https://replicate.com/alibaba/wan-3
- https://replicate.com/prunaai/p-video-2-pro
- https://replicate.com/prunaai/p-video-2
- https://replicate.com/black-forest-labs/flux-3
- https://replicate.com/elevenlabs/scribe-v2
- https://ai.google.dev/gemini-api/docs/omni
- https://ai.google.dev/gemini-api/docs/transcribe
- https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/use-foundry-models-mai-image
