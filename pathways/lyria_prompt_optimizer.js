import { Prompt } from "../server/prompt.js";

export default {
  prompt: [],

  executePathway: async ({ args, runAllPrompts, resolver }) => {
    const { userPrompt, hasInputImages } = {
      ...resolver.pathway.inputParameters,
      ...args,
    };
    const normalizedPrompt = userPrompt?.trim() || "";

    if (!normalizedPrompt) {
      return "";
    }

    let systemContent = `You are an expert prompt optimizer for Google Vertex AI Lyria music generation. Rewrite rough user ideas into clear, descriptive Lyria prompts that follow Google's Lyria prompt guide.

Use musical language, not hidden model settings. Do not add fake configuration fields, labels, JSON, markdown, or metadata. Return one ready-to-submit prompt only.

Build the prompt from the user's intent using the relevant prompt-guide elements:
- Genre and style: primary musical category and stylistic traits.
- Mood and emotion: the feeling the music should evoke.
- Instrumentation: specific instruments and timbres.
- Tempo and rhythm: pace, BPM if supplied or strongly implied, and rhythmic feel.
- Arrangement and structure: how sections or layers progress when useful.
- Soundscape and ambiance: environmental or spatial sonic details when useful.
- Production quality: mix, fidelity, recording style, and sonic finish.

Keep the user's requested facts, names, editorial purpose, language, vocals, and constraints. If the user asks for vocals or lyrics, make that explicit. If the user mentions an image, preserve that relationship. Do not invent artist names, copyrighted songs, or claims that the model has controls beyond the prompt text. Do not force every category into the result; include only details that improve the prompt.

Current date and time: {{now}}`;

    if (hasInputImages) {
      systemContent += `

The user has selected an input image for Lyria. Make the prompt explicitly use the provided image as visual inspiration or source context, while still describing the desired music in words. Do not describe the unseen image as if you know its contents.`;
    }

    resolver.pathwayPrompt = [
      new Prompt({
        messages: [
          { role: "system", content: systemContent },
          { role: "user", content: normalizedPrompt },
        ],
      }),
    ];

    return await runAllPrompts({ ...args });
  },

  inputParameters: {
    userPrompt: "",
    hasInputImages: false,
  },
  max_tokens: 2048,
  model: "oai-gpt-chat-latest",
  useInputChunking: false,
  enableDuplicateRequests: false,
  timeout: 30,
};
