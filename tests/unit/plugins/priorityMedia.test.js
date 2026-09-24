import test from "ava";
import fs from "node:fs";
import ReplicateApiPlugin from "../../../server/plugins/replicateApiPlugin.js";
import { buildPriorityMediaInput } from "../../../server/plugins/replicatePriorityMedia.js";
import GeminiInteractionsPlugin from "../../../server/plugins/geminiInteractionsPlugin.js";
import GeminiMusicPlugin from "../../../server/plugins/geminiMusicPlugin.js";
import Gemini3ReasoningVisionPlugin from "../../../server/plugins/gemini3ReasoningVisionPlugin.js";
import mediaReplicate from "../../../pathways/media_replicate.js";
import { PARAM_MAPPERS, normalizeLyria35Response } from "../../../pathways/media_generate.js";

const config = JSON.parse(fs.readFileSync(new URL("../../../config/default.example.json", import.meta.url), "utf8"));
const refs = (n, ext = "png") => Array.from({ length: n }, (_, i) => `https://example.com/${i}.${ext}`);
const build = (id, parameters = {}, prompt = "Editorial scene") => buildPriorityMediaInput(`replicate-${id}`, prompt, parameters);
const create = (Plugin, id) => new Plugin({ ...mediaReplicate, name: "test", model: id }, { ...config.models[id], name: id });

test("priority Replicate adapter is used by the configured shared pathway", t => {
    const id = "replicate-qwen-image-3-pro";
    const plugin = create(ReplicateApiPlugin, id);
    const request = plugin.getRequestParameters("An illustration", { model: id, matchInputImage: true }, { prompt: "{{{text}}}" });
    t.is(request.input.prompt, "An illustration");
    t.true(request.input.match_input_image);
    t.true(request.input.enable_prompt_expansion);
    t.false("model" in request.input);
});

test("Seedance preserves all 30 images, 10 videos and 10 audio references", t => {
    const input = build("seedance-2.5", { inputImages: refs(30), inputVideos: refs(10,"mp4"), inputAudio: refs(10,"wav"), generateAudio: false, watermark: true });
    t.is(input.reference_images.length, 30);
    t.is(input.reference_videos.length, 10);
    t.is(input.reference_audios.length, 10);
    t.false(input.generate_audio);
    t.true(input.watermark);
    t.false("image" in input);
    t.throws(() => build("seedance-2.5", { inputImages: refs(31) }), {message:/at most 30/});
    t.throws(() => build("seedance-2.5", {inputAudio: refs(1,"wav")}), {message:/requires a reference image or video/});
});

test("Seedance frame mode and editing enforce provider constraints", t => {
    const frames = {inputImages:refs(2),inputImageRoles:["start_frame","end_frame"]};
    const input=build("seedance-2.5",frames);
    t.is(input.image,refs(2)[0]); t.is(input.last_frame_image,refs(2)[1]); t.is(input.aspect_ratio,"adaptive");
    t.throws(()=>build("seedance-2.5",{...frames,inputVideos:refs(1,"mp4")}),{message:/cannot be combined/});
    t.throws(()=>build("seedance-2.5",{resolution:"1080p"}),{message:/Unsupported value/});
    t.throws(()=>build("seedance-2.5",{duration:1}),{message:/Unsupported value/});
    const edit=build("seedance-2.5",{inputVideos:refs(1,"mp4"),generationMode:"edit",duration:20});
    t.is(edit.duration,-1); t.is(edit.aspect_ratio,"adaptive");
});

test("LTX validates long clip constraints and ordered frames",t=>{
    t.is(build("ltx-2.5-fast",{duration:20,resolution:"1080p",fps:24}).duration,20);
    for(const parameters of [{duration:12,resolution:"4k"},{duration:12,fps:50},{inputImages:refs(1),inputImageRoles:["end_frame"]}]) t.throws(()=>build("ltx-2.5-fast",parameters));
    t.is(build("ltx-2.5-fast",{inputImages:refs(2)}).last_frame_image,refs(2)[1]);
});

test("Qwen allows one image and validates seed",t=>{
    t.is(build("qwen-image-3-pro",{inputImages:refs(1),enablePromptExpansion:false}).image,refs(1)[0]);
    t.throws(()=>build("qwen-image-3-pro",{inputImages:refs(2)}));
    t.throws(()=>build("qwen-image-3-pro",{seed:2147483648}));
});

test("Seedream standard and promptless layer decomposition contracts",t=>{
    t.is(build("seedream-5-pro",{inputImages:refs(10),size:"2K"}).image_input.length,10);
    t.is(build("seedream-5-pro",{inputImages:refs(1),layerDecomposition:true,size:"auto"},"").size,"auto");
    t.throws(()=>build("seedream-5-pro",{size:"auto"}));
    t.throws(()=>build("seedream-5-pro",{inputImages:refs(2),layerDecomposition:true}));
});

for(const suffix of ["","-svg"]) test(`Recraft${suffix} supports style images or reusable style IDs`,t=>{
    const id=`recraft-v4-styles-pro${suffix}`;
    const input=build(id,{styleId:"style-1",size:"3072x1536",styleMatch:"flexible"});
    t.deepEqual(input.style_reference_images,[]); t.is(input.style_id,"style-1"); t.is(input.size,"3072x1536");
    t.is(build(id,{inputImages:refs(10)}).style_reference_images.length,10);
    t.throws(()=>build(id));
    t.throws(()=>build(id,{styleId:"x",inputImages:refs(1)}));
});

test("Dubbing accepts one source and regional target languages, returns FLAC",t=>{
    const input=build("elevenlabs-dubbing",{inputAudio:refs(1,"wav"),targetLanguage:"ar-EG",cloningStrength:0},"");
    t.is(input.target_language,"ar-EG");t.is(input.cloning_strength,0);t.is(input.source_language,"auto");
    t.throws(()=>build("elevenlabs-dubbing",{targetLanguage:"ar"}));
    t.throws(()=>build("elevenlabs-dubbing",{sourceUrl:"https://example.com/a",targetLanguage:"invalid"}));
    const plugin=create(ReplicateApiPlugin,"replicate-elevenlabs-dubbing");
    const result=plugin.parseResponse({output:"https://example.com/dub.flac"});
    t.is(result.artifacts[0].type,"audio");t.is(result.artifacts[0].mimeType,"audio/flac");
    t.is(plugin.getFallbackAudioMimeType(),"audio/flac");
});

test("H3 is blocked both in metadata and direct prediction adapter",t=>{
    const plugin=create(ReplicateApiPlugin,"replicate-minimax-h3");
    t.false(plugin.model.metadata.isAvailable);
    t.throws(()=>plugin.getRequestParameters("scene",{model:plugin.modelName},{prompt:"{{text}}"}),{message:/awaiting a published/});
});

test("router forwards canonical references and false/zero controls",t=>{
    const mapped=PARAM_MAPPERS.media_replicate({model:"replicate-seedance-2.5",inputImageRoles:["start"],watermark:false,fps:24,cloningStrength:0},refs(1),refs(10,"mp4"),refs(10,"wav"));
    t.deepEqual(mapped.inputImageRoles,["start_frame"]);t.is(mapped.inputAudio.length,10);t.is(mapped.inputVideos.length,10);t.false(mapped.watermark);t.is(mapped.cloningStrength,0);
});

test("Omni 1.1 accepts 10 images, 3 videos and no standalone audio",t=>{
    const plugin=create(GeminiInteractionsPlugin,"gemini-omni-1.1-flash-preview");
    const input={inputImages:refs(10),inputVideos:refs(3,"mp4"),resolution:"4k",aspectRatio:"9:16"};
    const result=plugin.getRequestParameters("Scene",input,{prompt:"{{text}}"});
    t.is(result.input.length,14);t.deepEqual(result.response_format,{type:"video",aspect_ratio:"9:16",resolution:"4k"});
    t.throws(()=>plugin.getRequestParameters("Scene",{inputAudio:refs(1,"wav")},{prompt:"{{text}}"}),{message:/at most 0 audio/});
    t.throws(()=>plugin.getRequestParameters("Scene",{inputImages:refs(11)},{prompt:"{{text}}"}));
});

test("Interactions input references never become generated output",t=>{
    const plugin=create(GeminiInteractionsPlugin,"gemini-omni-1.1-flash-preview");
    const response=plugin.parseResponse({steps:[{type:"user_input",content:[{type:"video",uri:"https://example.com/input.mp4"}]},{type:"model_output",content:[{type:"video",uri:"https://example.com/output.mp4"}]}]});
    t.is(response.artifacts.length,1);t.is(response.artifacts[0].url,"https://example.com/output.mp4");
});

test("Lyria 3.5 uses API-key auth and never falls back to Vertex credentials",async t=>{
    const plugin=create(GeminiMusicPlugin,"google-lyria-3.5-music");
    plugin.config={get:key=>key==="geminiApiKey"?"test-key":null};
    t.deepEqual(await plugin.getAuthHeaders(),{"x-goog-api-key":"test-key"});
    plugin.config={get:()=>null};
    await t.throwsAsync(()=>plugin.getAuthHeaders(),{message:/GEMINI_API_KEY/});
});

test("Lyria 3.5 preserves interleaved lyrics and all audio blocks",async t=>{
    const plugin=create(GeminiMusicPlugin,"google-lyria-3.5-music");
    const request=plugin.getRequestParameters("Song",{inputImages:refs(10),audioFormat:"wav"},{prompt:"{{text}}"});
    t.is(request.model,"lyria-3.5");t.is(request.input.length,11);t.deepEqual(request.response_format,{type:"audio"});
    const parsed=plugin.parseResponse({steps:[{type:"user_input",content:[{type:"image",data:"not-output"}]},{type:"model_output",content:[{type:"text",text:"Verse one"},{type:"audio",data:"audio1",mime_type:"audio/mpeg"},{type:"audio",data:"audio2",mime_type:"audio/mpeg"}]}]});
    t.is(parsed.artifacts.length,2);t.is(parsed.output_text,"Verse one");
    const resolver={pathwayResultData:{artifacts:parsed.artifacts}};
    const normalized=JSON.parse(await normalizeLyria35Response(parsed.output_text,resolver,{},async data=>({url:`https://example.com/${data}.mp3`})));
    t.is(normalized.output.length,2);t.is(normalized.lyrics,"Verse one");t.false("data" in resolver.pathwayResultData.artifacts[0]);
});

test("Gemini 3.8 normalizes explicit MINIMAL and preserves supported thinking levels",t=>{
    const plugin=create(Gemini3ReasoningVisionPlugin,"gemini-flash-38-vision");
    for(const [thinkingLevel,expected] of [["MINIMAL","low"],["none","low"],["medium","medium"],["high","high"]]) {
        const result=plugin.getRequestParameters("Hello",{thinkingLevel},{prompt:"{{text}}"},{pathway:{}});
        t.is(result.generationConfig.thinkingConfig.thinkingLevel,expected);
    }
});
