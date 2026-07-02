import test from "ava";
import createMediaTool, {
  DEFAULT_AGENT_IMAGE_MODEL,
  DEFAULT_AGENT_IMAGE_PATHWAY,
} from "../../../pathways/system/entity/tools/sys_tool_create_media.js";

test("CreateMedia exposes referenceVideos for video extension", (t) => {
  const definition = createMediaTool.toolDefinition[0].function;
  const referenceVideos = definition.parameters.properties.referenceVideos;

  t.truthy(referenceVideos);
  t.is(referenceVideos.type, "array");
  t.true(definition.description.includes("EXTEND a video"));
  t.true(referenceVideos.description.includes("extend"));
});

test("CreateMedia defaults agent image generation to Gemini Flash Lite image", (t) => {
  t.is(DEFAULT_AGENT_IMAGE_MODEL, "gemini-flash-lite-31-image");
  t.is(DEFAULT_AGENT_IMAGE_PATHWAY, "image_gemini_31_lite");
});
