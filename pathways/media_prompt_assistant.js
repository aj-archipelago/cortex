import { Prompt } from '../server/prompt.js';

const MEDIA_TYPE_GUIDANCE = {
  image: `Generic image guidance:
- Write a detailed still-image prompt with subject, environment, composition, camera/lens or design style, lighting, mood, and intended use.
- Prefer positive instructions over negative lists.
- If references are present, describe how they should be used without claiming to know unseen details.`,
  video: `Generic video guidance:
- Write like a director: subject, action, environment, camera motion, visual style, pacing, and temporal change.
- Keep the prompt concise enough for video generation while specifying motion separately from camera movement.
- If references are present, make their role explicit as visual, motion, timing, or style references without inventing unseen contents.`,
  audio: `Generic audio guidance:
- Write a ready-to-submit music or sound prompt using genre/style, mood, instrumentation, tempo/rhythm, arrangement, soundscape, and production quality.
- Use musical language, not hidden model settings or JSON.
- If references are present, describe them as inspiration for mood, pacing, texture, or rhythm without claiming to know unseen contents.`,
  tts: `Generic text-to-speech guidance:
- Write a ready-to-submit speech synthesis prompt whose output is spoken audio, not music or sound design.
- Preserve the exact words the user wants spoken unless they explicitly ask for rewriting.
- Separate performance direction from the spoken transcript so the model knows what to synthesize and what not to read aloud.
- Use natural-language performance direction for style, tone, accent, pace, emotion, pronunciation, and pauses.`,
};

const MODEL_RULES = [
  {
    match: /gemini.*image|image_gemini|gemini-flash-25-image|gemini-flash-31-image|gemini-pro-3-image/i,
    guidance: `Gemini image guidance:
- Expand vague requests into highly specific professional image prompts.
- Include subject, action/expression, setting, lighting, mood, camera/composition, visual details, and output intent.
- For editing or reference-image requests, preserve the user's requested relationship to the provided image and avoid over-describing the unseen reference.
- Use positive semantic language and clear step-by-step composition when the scene is complex.`,
  },
  {
    match: /lyria|music_lyria|google-lyria/i,
    guidance: `Lyria guidance:
- Return one natural-language music prompt only.
- Use genre/style, mood, instrumentation, tempo/rhythm, arrangement, soundscape, and production quality.
- Preserve requested facts, editorial purpose, language, vocals, lyrics, and constraints.
- Do not invent artist names, copyrighted songs, hidden controls, labels, JSON, markdown, or metadata.`,
  },
  {
    match: /google-gemini-3\.1-flash-tts|gemini.*flash.*tts|gemini.*tts|tts_gemini/i,
    guidance: `Gemini TTS guidance:
- Return one ready-to-submit Gemini TTS prompt only. The prompt may include labeled sections when they help separate performance direction from transcript, but do not add explanations outside the prompt.
- Start with a clear synthesis instruction such as "Synthesize the spoken audio for the transcript below." This prevents the model from reading director's notes aloud or rejecting vague prompts.
- Clearly label the actual spoken text with "TRANSCRIPT:" or "#### TRANSCRIPT" and put only words intended to be spoken in that section.
- For simple single-speaker requests, include concise direction before the transcript for tone, style, accent, pace, emotion, and delivery.
- For richer voice work, use the Gemini TTS structure: AUDIO PROFILE, SCENE, DIRECTOR'S NOTES, SAMPLE CONTEXT if useful, and TRANSCRIPT.
- Use audio tags in square brackets where helpful, such as [whispers], [laughs], [short pause], [long pause], [excitedly], [serious], [slow], or [fast]. Use English tags even when the transcript is in another language.
- For multi-speaker prompts, keep speaker names exactly consistent between the transcript and configured speakers. Use at most two speakers.
- Keep the written tone, character profile, and selected voice compatible so the requested performance does not fight the voice.
- Avoid over-specifying every detail; prioritize the few performance directions that matter most.
- Do not include model settings, response modalities, voiceName values, JSON, file instructions, base64, sample rate, or post-processing commands in the prompt text.`,
  },
  {
    match: /replicate-qwen3-tts|qwen.*tts|tts_replicate/i,
    guidance: `Qwen3 TTS guidance:
- Return speakable transcript text for Qwen3 TTS, not JSON or API field names.
- Preserve the exact words the user wants spoken unless they explicitly ask for rewriting.
- Keep performance direction concise and compatible with the separate style_instruction, speaker, language, and voice mode controls. If the user gives style direction in the prompt, fold only essential delivery cues into natural speech-safe wording.
- For custom_voice mode, do not name a speaker inside the transcript unless the words should be spoken aloud.
- For voice_clone mode, do not describe the reference audio in the transcript; use the transcript only for the new speech content.
- For voice_design mode, keep voice-description material out of the spoken transcript unless the user explicitly wants it read aloud.
- Do not include model settings, mode, speaker, language, reference_audio, reference_text, style_instruction, voice_description, URLs, base64, sample rate, or post-processing commands in the prompt text.`,
  },
  {
    match: /seedance.*2|replicate-seedance-2/i,
    guidance: `Seedance 2.0 guidance:
- Write a concise director-style video prompt with subject, action, environment, camera movement, pacing, style, and safety-conscious constraints.
- Keep the wording neutral, consent-safe, non-graphic, and non-deceptive.
- Avoid real-person impersonation, named public figures, copyrighted character claims, sexualized framing, graphic violence, political persuasion, sensitive identity claims, and instructions that appear to bypass moderation.
- If the user's permitted intent is ambiguous, rewrite toward a generic fictional subject, staged scene, or consent-cleared actor/character.
- Avoid loaded words that could be misread as violent, adult, exploitative, or deceptive when neutral production language will do.
- Preserve the creative goal, but make the prompt safer and clearer rather than evasive.`,
  },
];

function normalizeMediaType(mediaType = '') {
  const value = String(mediaType || '').toLowerCase();
  if (value === 'image' || value === 'video' || value === 'audio' || value === 'tts') return value;
  return 'image';
}

function getModelGuidance(model = '') {
  const modelId = String(model || '');
  return MODEL_RULES.filter((rule) => rule.match.test(modelId))
    .map((rule) => rule.guidance)
    .join('\n\n');
}

function buildReferenceSummary(input) {
  const references = Array.isArray(input.references) ? input.references : [];
  const referenceRoles = Array.isArray(input.referenceRoles) ? input.referenceRoles : [];
  const count = references.length || Number(input.referenceCount || 0);
  if (count > 0) {
    const roles = [...new Set(referenceRoles.filter(Boolean))];
    const roleText = roles.length > 0 ? ` Roles: ${roles.join(', ')}.` : '';
    return `The user has selected ${count} media reference${count === 1 ? '' : 's'}.${roleText}`;
  }
  if (input.hasInputImages) {
    return 'The user has selected one or more image references.';
  }
  return 'The user has not selected media references.';
}

export default {
  prompt: [],

  executePathway: async ({ args, runAllPrompts, resolver }) => {
    const input = { ...resolver.pathway.inputParameters, ...args };
    const prompt = String(input.prompt || input.userPrompt || '').trim();
    const mediaType = normalizeMediaType(input.mediaType || input.task || input.category);
    const model = String(input.model || '').trim();
    const referenceSummary = buildReferenceSummary(input);
    const action = prompt ? 'optimize' : 'generate';
    const modelGuidance = getModelGuidance(model);

    const systemContent = `You are a media prompt assistant for image, video, audio, and text-to-speech generation.

Your job is to ${action === 'optimize' ? 'rewrite the user prompt into a stronger ready-to-submit generation prompt' : 'create one ready-to-submit prompt from scratch'}.

Return only the final prompt text. Do not return explanations, JSON, bullet points, or quotes. Do not use labels or markdown unless the model-specific guidance explicitly asks for labeled prompt sections.

General rules:
- Preserve the user's permitted intent.
- Do not add hidden settings, unsupported parameters, seed values, or UI instructions.
- Do not include policy-bypass language or instructions to evade safety systems.
- Be specific, concrete, and production-ready.
- Keep references abstract unless their content is described by the user.

${MEDIA_TYPE_GUIDANCE[mediaType]}

${modelGuidance || 'No model-specific guidance is configured for this model; use the generic media guidance.'}

Context:
- Media type: ${mediaType}
- Model: ${model || 'unknown'}
- References: ${referenceSummary}
- Current date and time: {{now}}`;

    const userContent = prompt
      ? `Optimize this ${mediaType} prompt for ${model || 'the selected model'}:\n\n${prompt}`
      : `Generate a strong starter ${mediaType} prompt for ${model || 'the selected model'}.`;

    resolver.pathwayPrompt = [
      new Prompt({
        messages: [
          { role: 'system', content: systemContent },
          { role: 'user', content: userContent },
        ],
      }),
    ];

    return await runAllPrompts({ ...args });
  },

  inputParameters: {
    prompt: '',
    userPrompt: '',
    mediaType: '',
    task: '',
    category: '',
    model: '',
    references: { type: 'array', items: { type: 'string' } },
    referenceRoles: { type: 'array', items: { type: 'string' } },
    hasInputImages: false,
    referenceCount: 0,
  },
  max_tokens: 2048,
  model: 'oai-gpt54-mini',
  useInputChunking: false,
  enableDuplicateRequests: false,
  timeout: 30,
};
