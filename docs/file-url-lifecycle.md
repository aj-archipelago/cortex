Chat image URLs are checked in memory before each model call. Azure SAS expiry (`se`, capped by `ske` for user delegation) and Google signed URL expiry are parsed once into a bounded cache. The check reserves 60 seconds for clock skew and provider download time. Unknown expiry does not count as fresh, and URL timing never establishes ownership.

ViewImages keeps the exact blob path and context with each image. Once a link approaches expiry, Cortex resolves that same file through the current file access plan and storage grant. It checks the returned origin and path, preserves versioned references without substituting the current file, and updates the generated markdown link alongside the vision input. Renewal results and in-flight work are cached only within the request, with at most eight simultaneous renewals and a short backoff after failed renewal.

The shared short-lived URL helper reuses an already suitable link instead of immediately issuing a second lookup. It still exchanges long-lived storage URLs for short-lived model access. Image validation performs one HEAD for a new signed URL, shares concurrent validation, and caches successful validation until the expiry margin (up to five minutes). Expired links are rejected locally. Unsigned or unrecognized external URLs retain network validation.

A model URL-download failure permits one retry after scoped renewal. It does not rerun completed tools or retry unrelated errors, canceled requests, or an active tool callback. A preview failure does not imply deletion or corruption of the original file. The error explanation preserves existing work and directs continuation through workspace files or ViewImages. Assistant commentary is retained once per tool round, including parallel, cached, failed, and non-streaming tool calls.

For OpenAI Responses, that retry now sends authorized managed image bytes inline. A renewed URL can still exceed the provider's download deadline: large images can exceed that deadline even when their access URLs are fresh. The adapter performs the existing scoped lookup before downloading, accepts only HTTPS Azure blob URLs without redirects, and limits each download to 20 MiB and 20 seconds. Inline images are limited to 24 MiB of decoded bytes per model call, counting repeated image parts. Unsupported types or failed downloads retain their original URLs and existing error handling.

The fallback runs after prompt compilation and truncation, so base64 does not enter saved history, tool results, markdown links, or token estimation. Request-size diagnostics and debug output redact base64. Subsequent model calls in the same agent request reuse a cache bounded to 24 MiB, keyed by access plan, context, blob path, and exact signed URL. Healthy requests still use URLs. Other model adapters and raw Responses API passthrough input are unchanged.

The September 23 audit covered these other refresh paths in Cortex and Concierge:

| Path | Decision |
| --- | --- |
| Cortex ViewImages and `generateFileMessageContent` | Share the cheap freshness check; retain storage identity for later tool rounds. |
| Cortex image validation used by OpenAI/Responses/Grok and Claude | Cache successful signed URL validation within the plugin instance; preserve initial MIME/access checks. |
| Concierge `prepareFileContentForLLM` / `resolveAndHealFile` | Keep resolution: it checks storage ownership, handles converted files and legacy targets, and can repair records. Expiry alone cannot replace that work. |
| Concierge image/text/media proxies | Keep authorized resolution and fetch-on-use with bounded 403 recovery. A proactive expiry check could save the failed fetch for an already-expired URL, but is a separate small optimization. Profile and applet-cover provenance checks remain necessary. |
| Queued image/video/audio generation and transcription | Keep refresh at execution time after queue delay, along with owner/source validation and selection of Azure versus GCS input. It occurs at the provider handoff rather than every tool round. |
| File-handler upload/list/copy and signing | Keep signing at the operation that produces access. Short-lived SAS expiry remains capped by the grant. |
| Workspace addresses and MCP/OAuth tokens | Separate lifecycles; a blob URL expiry check cannot replace service discovery or token refresh. |

No Concierge, worker, or file-handler changes are needed for this fix. A remaining two-second discovery lookup can still time out independently of URL expiry; renewal uses a ten-second metadata-only lookup. The audit did not establish that every provider URL-download timeout is caused by expiry.

The focused tests cover expiry boundaries, Azure/GCS timestamp formats, long-lived versus short-lived links, simulated twenty-minute tool loops, duplicate and concurrent images, scoped identity, bounded fan-out, failed renewal backoff, provider recovery, cancellation, actual Responses input conversion, and preservation of assistant progress and image metadata. All media and provider calls in these tests are mocked.
