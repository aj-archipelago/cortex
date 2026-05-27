# Media Generation Contract

## Veo Video Extension

Veo video extension is exposed through the existing `media_generate` pathway and
the `CreateMedia` entity tool.

### Model Metadata

`sys_model_metadata(category: "video")` exposes extension-capable Veo models with:

```json
{
  "modelId": "veo-3.1-generate",
  "mediaDefaults": {
    "inputImages": [0, 3],
    "inputVideos": [0, 1],
    "aspectRatio": "16:9",
    "duration": 8,
    "resolution": "720p",
    "generateAudio": true
  },
  "videoInputModes": ["extend"],
  "preferredUrlFormat": "gcs"
}
```

`inputVideos: [0, 1]` means callers may attach at most one input video. For Veo,
that video is treated as an extension source, not as a generic style reference.
The UI should prefer the models whose `videoInputModes` includes `"extend"`.
The current Cortex Veo 3.1 models all expose this mode:
`veo-3.1-generate`, `veo-3.1-fast-generate`, and
`veo-3.1-lite-generate`.

### `media_generate`

To extend a video directly, call `media_generate` with:

```json
{
  "model": "veo-3.1-generate",
  "text": "Continue the camera move as the subject enters the garden.",
  "inputVideos": ["gs://bucket/path/base.mp4"],
  "resolution": "720p"
}
```

The provider-facing Veo payload receives:

```json
{
  "instances": [
    {
      "prompt": "...",
      "video": {
        "gcsUri": "gs://bucket/path/base.mp4",
        "mimeType": "video/mp4"
      }
    }
  ],
  "parameters": {
    "resolution": "720p",
    "generateAudio": true
  }
}
```

`media_generate` also accepts a `data:video/mp4;base64,...` input video and maps
it to Veo `inlineData`, but GCS input is preferred and is what model metadata
advertises.

### `CreateMedia`

For agent/tool use, pass one `referenceVideos` item:

```json
{
  "type": "video",
  "prompt": "Continue the clip into a wide shot of the garden.",
  "referenceVideos": ["base.mp4"],
  "userMessage": "Extending the video"
}
```

`CreateMedia` resolves the file through `fileAccessPlan` with `preferGcs: true`
and calls `video_veo` using `veo-3.1-generate`. The output is uploaded and added
to the file collection like normal generated videos.
