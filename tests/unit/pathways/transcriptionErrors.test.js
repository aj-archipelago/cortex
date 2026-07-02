import test from 'ava';

import {
    YOUTUBE_VIDEO_ACCESS_DENIED_CODE,
    isYoutubeVideoAccessDeniedError,
    normalizeTranscriptionError,
} from '../../../lib/transcriptionErrors.js';

test('isYoutubeVideoAccessDeniedError detects Gemini video permission failures', (t) => {
    t.true(
        isYoutubeVideoAccessDeniedError(
            'User does not have access to the video.; RPC to BAG server failed: PERMISSION_DENIED',
        ),
    );
    t.true(
        isYoutubeVideoAccessDeniedError(
            new Error(
                'PERMISSION_DENIED: Error raised from operator beyond_api_gateway during video execution',
            ),
        ),
    );
});

test('normalizeTranscriptionError classifies inaccessible YouTube videos', (t) => {
    const original = new Error('User does not have access to the video.');
    const normalized = normalizeTranscriptionError(original, {
        isYoutube: true,
    });

    t.is(normalized.code, YOUTUBE_VIDEO_ACCESS_DENIED_CODE);
    t.true(normalized.message.startsWith(YOUTUBE_VIDEO_ACCESS_DENIED_CODE));
    t.true(normalized.message.includes('upload the media file directly'));
    t.is(normalized.cause, original);
});

test('normalizeTranscriptionError leaves unrelated and non-YouTube errors unchanged', (t) => {
    const unrelated = new Error('Provider temporarily unavailable');
    t.is(normalizeTranscriptionError(unrelated, { isYoutube: true }), unrelated);

    const unrelatedVideoPermissionError = new Error(
        'PERMISSION_DENIED: project is not allowed to use video understanding',
    );
    t.false(isYoutubeVideoAccessDeniedError(unrelatedVideoPermissionError));
    t.is(
        normalizeTranscriptionError(unrelatedVideoPermissionError, {
            isYoutube: true,
        }),
        unrelatedVideoPermissionError,
    );

    const nonYoutube = new Error('User does not have access to the video.');
    t.is(
        normalizeTranscriptionError(nonYoutube, { isYoutube: false }),
        nonYoutube,
    );
});
