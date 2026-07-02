export const YOUTUBE_VIDEO_ACCESS_DENIED_CODE =
    'YOUTUBE_VIDEO_ACCESS_DENIED';

export const YOUTUBE_VIDEO_ACCESS_DENIED_MESSAGE = `${YOUTUBE_VIDEO_ACCESS_DENIED_CODE}: This YouTube video is not accessible for transcription. It may be private, members-only, age-restricted, region-restricted, or unavailable. Use a public YouTube link or upload the media file directly.`;

export function isYoutubeVideoAccessDeniedError(error) {
    const message = String(error?.message || error || '');
    return (
        /user does not have access to the video/i.test(message) ||
        (/permission_denied/i.test(message) &&
            /\b(beyond_api_gateway|bag server)\b/i.test(message))
    );
}

export function normalizeTranscriptionError(error, { isYoutube = false } = {}) {
    if (!isYoutube || !isYoutubeVideoAccessDeniedError(error)) {
        return error;
    }

    const normalized = new Error(YOUTUBE_VIDEO_ACCESS_DENIED_MESSAGE);
    normalized.code = YOUTUBE_VIDEO_ACCESS_DENIED_CODE;
    normalized.cause = error;
    return normalized;
}
