import test from "ava";
import {
  PARAM_MAPPERS,
} from "../../../pathways/media_generate.js";

test("media_generate maps Veo image roles to start, end, and asset references", (t) => {
  const mapped = PARAM_MAPPERS.video_veo(
    {
      text: "a product reveal",
      model: "veo-3.1-fast-generate",
      inputImageRoles: ["start_frame", "reference", "end_frame"],
      duration: 8,
      generateAudio: true,
    },
    [
      "gs://bucket/start.png",
      "gs://bucket/product.png",
      "gs://bucket/end.jpg",
    ],
  );

  t.deepEqual(JSON.parse(mapped.image), {
    gcsUri: "gs://bucket/start.png",
    mimeType: "image/png",
  });
  t.deepEqual(JSON.parse(mapped.lastFrame), {
    gcsUri: "gs://bucket/end.jpg",
    mimeType: "image/jpeg",
  });
  t.deepEqual(mapped.referenceImages, [
    {
      image: {
        gcsUri: "gs://bucket/product.png",
        mimeType: "image/png",
      },
      referenceType: "asset",
    },
  ]);
});

test("media_generate rejects unsupported Veo image role formats before provider submission", (t) => {
  const error = t.throws(() => PARAM_MAPPERS.video_veo(
    {
      text: "a product reveal",
      model: "veo-3.1-fast-generate",
      inputImageRoles: ["start_frame", "reference", "end_frame"],
    },
    [
      "gs://bucket/start.png",
      "gs://bucket/product.webp",
      "gs://bucket/end.jpg",
    ],
  ));

  t.regex(error.message, /Veo image references must be JPEG or PNG/);
  t.regex(error.message, /webp/);
});

test("media_generate preserves generic Veo image behavior when roles are absent", (t) => {
  const mapped = PARAM_MAPPERS.video_veo(
    {
      text: "a product reveal",
      model: "veo-3.1-fast-generate",
    },
    [
      "gs://bucket/start.png",
      "gs://bucket/ignored.png",
    ],
  );

  t.deepEqual(JSON.parse(mapped.image), {
    gcsUri: "gs://bucket/start.png",
    mimeType: "image/png",
  });
  t.is(mapped.lastFrame, "");
  t.deepEqual(mapped.referenceImages, []);
});

test("media_generate maps Veo input video to extension payload", (t) => {
  const mapped = PARAM_MAPPERS.video_veo(
    {
      text: "continue the camera move into the garden",
      model: "veo-3.1-generate",
    },
    [],
    [
      "gs://bucket/base.mp4",
    ],
  );

  t.deepEqual(JSON.parse(mapped.video), {
    gcsUri: "gs://bucket/base.mp4",
    mimeType: "video/mp4",
  });
  t.is(mapped.resolution, "720p");
});

test("media_generate rejects unsupported Veo extension video formats before provider submission", (t) => {
  const error = t.throws(() => PARAM_MAPPERS.video_veo(
    {
      text: "continue the camera move",
      model: "veo-3.1-generate",
    },
    [],
    [
      "gs://bucket/base.mov",
    ],
  ));

  t.regex(error.message, /requires MP4 input/);
  t.regex(error.message, /mov/);
});

test("media_generate maps Seedance 2.0 image roles to provider fields", (t) => {
  const mapped = PARAM_MAPPERS.video_seedance(
    {
      text: "a character walking through a city",
      model: "replicate-seedance-2.0",
      inputImageRoles: ["reference", "start_frame", "end_frame"],
      duration: 7,
    },
    [
      "https://example.com/character.png",
      "https://example.com/start.png",
      "https://example.com/end.png",
    ],
    [],
  );

  t.is(mapped.image, "https://example.com/start.png");
  t.is(mapped.last_frame_image, "https://example.com/end.png");
  t.deepEqual(mapped.reference_images, ["https://example.com/character.png"]);
});

test("media_generate maps Kling image roles to start and end images", (t) => {
  const mapped = PARAM_MAPPERS.video_kling(
    {
      text: "a camera push-in",
      model: "replicate-kling-v2.5-turbo-pro",
      inputImageRoles: ["end_frame", "start_frame"],
    },
    [
      "https://example.com/end.png",
      "https://example.com/start.png",
    ],
  );

  t.is(mapped.start_image, "https://example.com/start.png");
  t.is(mapped.end_image, "https://example.com/end.png");
  t.is(mapped.image, "https://example.com/start.png");
});
