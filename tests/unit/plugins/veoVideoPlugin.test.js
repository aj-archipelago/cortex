import test from "ava";
import VeoVideoPlugin from "../../../server/plugins/veoVideoPlugin.js";

function createPlugin() {
  const pathway = {
    name: "video_veo",
    model: "veo-3.1-generate",
    prompt: { prompt: "{{text}}" },
    inputParameters: {
      model: "veo-3.1-generate",
      image: "",
      video: "",
      lastFrame: "",
      referenceImages: [],
      durationSeconds: 8,
      generateAudio: true,
    },
  };

  const model = {
    name: "veo-3.1-generate",
    type: "VEO-VIDEO",
  };

  return new VeoVideoPlugin(pathway, model);
}

test("VeoVideoPlugin forwards start frame, end frame, and reference images", (t) => {
  const plugin = createPlugin();

  const request = plugin.getRequestParameters(
    "a product reveal",
    {
      model: "veo-3.1-generate",
      image: JSON.stringify({
        gcsUri: "gs://bucket/start.png",
        mimeType: "image/png",
      }),
      lastFrame: JSON.stringify({
        gcsUri: "gs://bucket/end.png",
        mimeType: "image/png",
      }),
      referenceImages: [
        {
          image: {
            gcsUri: "gs://bucket/product.png",
            mimeType: "image/png",
          },
          referenceType: "asset",
        },
      ],
      durationSeconds: 8,
      generateAudio: true,
    },
    { prompt: "{{text}}" },
  );

  t.deepEqual(request.instances[0], {
    prompt: "a product reveal",
    image: {
      gcsUri: "gs://bucket/start.png",
      mimeType: "image/png",
    },
    lastFrame: {
      gcsUri: "gs://bucket/end.png",
      mimeType: "image/png",
    },
    referenceImages: [
      {
        image: {
          gcsUri: "gs://bucket/product.png",
          mimeType: "image/png",
        },
        referenceType: "asset",
      },
    ],
  });
});

test("VeoVideoPlugin forwards input video for extension without durationSeconds", (t) => {
  const plugin = createPlugin();

  const request = plugin.getRequestParameters(
    "continue the camera move into the garden",
    {
      model: "veo-3.1-generate",
      video: JSON.stringify({
        gcsUri: "gs://bucket/base.mp4",
        mimeType: "video/mp4",
      }),
      durationSeconds: 8,
      resolution: "720p",
      generateAudio: true,
    },
    { prompt: "{{text}}" },
  );

  t.deepEqual(request.instances[0], {
    prompt: "continue the camera move into the garden",
    video: {
      gcsUri: "gs://bucket/base.mp4",
      mimeType: "video/mp4",
    },
  });
  t.deepEqual(request.parameters, {
    generateAudio: true,
    resolution: "720p",
  });
});

test("VeoVideoPlugin forwards input video for Veo Lite extension", (t) => {
  const plugin = createPlugin();

  const request = plugin.getRequestParameters(
    "continue the clip",
    {
      model: "veo-3.1-lite-generate",
      video: JSON.stringify({
        gcsUri: "gs://bucket/base.mp4",
        mimeType: "video/mp4",
      }),
    },
    { prompt: "{{text}}" },
  );

  t.deepEqual(request.instances[0], {
    prompt: "continue the clip",
    video: {
      gcsUri: "gs://bucket/base.mp4",
      mimeType: "video/mp4",
    },
  });
  t.deepEqual(request.parameters, {
    generateAudio: true,
  });
});
