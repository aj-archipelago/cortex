export default {
    prompt: ["{{text}}"],

    inputParameters: {
        model: "replicate-seedance-1-pro",
        resolution: "720p",
        aspectRatio: "16:9",
        fps: 24,
        duration: 5,
        image: "",
        reference_images: [],
        reference_videos: [],
        reference_audios: [],
        camera_fixed: false,
        seed: null,
        generate_audio: false,
        last_frame_image: "",
    },

    timeout: 60 * 30, // 30 minutes
};
