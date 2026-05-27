import test from "ava";
import createMediaTool from "../../../pathways/system/entity/tools/sys_tool_create_media.js";

test("CreateMedia exposes referenceVideos for video extension", (t) => {
  const definition = createMediaTool.toolDefinition[0].function;
  const referenceVideos = definition.parameters.properties.referenceVideos;

  t.truthy(referenceVideos);
  t.is(referenceVideos.type, "array");
  t.true(definition.description.includes("EXTEND a video"));
  t.true(referenceVideos.description.includes("extend"));
});
