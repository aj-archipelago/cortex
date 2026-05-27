import test from 'ava';
import imageFlux from '../../../pathways/image_flux.js';
import imageGemini3 from '../../../pathways/image_gemini_3.js';
import imageGemini31 from '../../../pathways/image_gemini_31.js';
import imageQwen from '../../../pathways/image_qwen.js';
import imageSeedream4 from '../../../pathways/image_seedream4.js';
import { PARAM_MAPPERS } from '../../../pathways/media_generate.js';

test('image pathway contracts expose generation and edit controls', (t) => {
    t.is(imageQwen.inputParameters.model, 'replicate-qwen-image');
    t.true('negativePrompt' in imageQwen.inputParameters);
    t.true('aspectRatio' in imageQwen.inputParameters);
    t.true('output_format' in imageQwen.inputParameters);
    t.true('output_quality' in imageQwen.inputParameters);
    t.true('input_image' in imageQwen.inputParameters);
    t.true('input_image_2' in imageQwen.inputParameters);
    t.true('input_image_3' in imageQwen.inputParameters);
    t.true('guidance' in imageQwen.inputParameters);
    t.true('num_inference_steps' in imageQwen.inputParameters);

    t.is(imageSeedream4.inputParameters.model, 'replicate-seedream-4');
    t.true('size' in imageSeedream4.inputParameters);
    t.true('aspectRatio' in imageSeedream4.inputParameters);
    t.true('maxImages' in imageSeedream4.inputParameters);
    t.true('numberResults' in imageSeedream4.inputParameters);
    t.true('input_image' in imageSeedream4.inputParameters);
    t.true('input_image_3' in imageSeedream4.inputParameters);
    t.true('sequentialImageGeneration' in imageSeedream4.inputParameters);

    t.true('resolution' in imageFlux.inputParameters);
    t.true('input_images' in imageFlux.inputParameters);
    t.true('seed' in imageFlux.inputParameters);

    for (const pathway of [imageGemini3, imageGemini31]) {
        t.true('aspectRatio' in pathway.inputParameters);
        t.true('image_size' in pathway.inputParameters);
        t.true('input_image' in pathway.inputParameters);
        t.true('input_image_3' in pathway.inputParameters);
    }
});

test('media_generate maps Qwen base generation without image inputs', (t) => {
    const mapped = PARAM_MAPPERS.image_qwen(
        {
            text: 'a bright editorial illustration',
            model: 'replicate-qwen-image',
            aspectRatio: '16:9',
            outputFormat: 'webp',
            outputQuality: 80,
            imageSize: 'optimize_for_quality',
            numberResults: 2,
        },
        ['https://example.com/ignored.png'],
    );

    t.deepEqual(mapped, {
        text: 'a bright editorial illustration',
        model: 'replicate-qwen-image',
        aspectRatio: '16:9',
        output_format: 'webp',
        output_quality: 80,
        image_size: 'optimize_for_quality',
        numberResults: 2,
    });
});

test('media_generate maps Qwen edit models with up to three input images', (t) => {
    const images = [
        'https://example.com/one.png',
        'https://example.com/two.png',
        'https://example.com/three.png',
        'https://example.com/four.png',
    ];
    const mapped = PARAM_MAPPERS.image_qwen(
        {
            text: 'combine these references',
            model: 'replicate-qwen-image-edit-plus',
            aspectRatio: 'match_input_image',
            outputFormat: 'png',
            outputQuality: 95,
        },
        images,
    );

    t.is(mapped.input_image, images[0]);
    t.is(mapped.input_image_2, images[1]);
    t.is(mapped.input_image_3, images[2]);
    t.false('input_image_4' in mapped);
});

test('media_generate maps Seedream 4 generation and references', (t) => {
    const mapped = PARAM_MAPPERS.image_seedream4(
        {
            text: 'a product render',
            model: 'replicate-seedream-4',
            size: '2K',
            width: 2048,
            height: 1152,
            aspectRatio: '16:9',
            numberResults: 3,
            seed: 123,
        },
        ['https://example.com/ref-a.png', 'https://example.com/ref-b.png'],
    );

    t.deepEqual(mapped, {
        text: 'a product render',
        model: 'replicate-seedream-4',
        size: '2K',
        width: 2048,
        height: 1152,
        aspectRatio: '16:9',
        maxImages: 3,
        numberResults: 3,
        input_image: 'https://example.com/ref-a.png',
        input_image_1: 'https://example.com/ref-a.png',
        input_image_2: 'https://example.com/ref-b.png',
        input_image_3: '',
        seed: 123,
    });
});

test('media_generate maps Flux 2 Pro references as an input_images array', (t) => {
    const images = Array.from({ length: 10 }, (_, index) => `https://example.com/ref-${index}.png`);
    const mapped = PARAM_MAPPERS.image_flux(
        {
            text: 'a cinematic frame',
            model: 'replicate-flux-2-pro',
            aspectRatio: '16:9',
            resolution: '2 MP',
            outputFormat: 'png',
            outputQuality: 95,
            seed: 55,
        },
        images,
    );

    t.deepEqual(mapped, {
        text: 'a cinematic frame',
        model: 'replicate-flux-2-pro',
        aspectRatio: '16:9',
        resolution: '2 MP',
        output_format: 'png',
        output_quality: 95,
        seed: 55,
        input_images: images.slice(0, 8),
    });
});

test('media_generate maps Gemini image pathways with shared image controls', (t) => {
    const mapped = PARAM_MAPPERS.image_gemini_3(
        {
            text: 'a generated infographic',
            model: 'gemini-flash-image',
            optimizePrompt: true,
            aspectRatio: '4:3',
            imageSize: '2K',
        },
        ['data:image/png;base64,one', 'data:image/png;base64,two'],
    );

    t.deepEqual(mapped, {
        text: 'a generated infographic',
        model: 'gemini-flash-image',
        optimizePrompt: true,
        aspectRatio: '4:3',
        image_size: '2K',
        input_image: 'data:image/png;base64,one',
        input_image_2: 'data:image/png;base64,two',
    });
});
