export default {
    prompt: `{{text}}\n\nGenerate a numbered list of concise, SEO-friendly keywords (maximum 3 words)
    for the above news article. The keywords must be in the same language as the article
    and appear as exact matches in the text, ensuring their suitability for internal content linking
    and search engine optimization.`,
    list: true,
    model: 'oai-gpt4o',
    useInputChunking: true,
    inputChunkSize: 2000,
    useParallelChunkProcessing: true,
};
