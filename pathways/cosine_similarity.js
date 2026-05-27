// Calculates cosine similarity between a text string and candidate strings.

import { callPathway } from '../lib/pathwayTools.js';

export function cosineSimilarity(vecA, vecB) {
    if (!Array.isArray(vecA) || !Array.isArray(vecB)) {
        throw new Error('Vectors must be arrays');
    }
    if (vecA.length !== vecB.length) {
        throw new Error('Vectors must have the same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
        dotProduct += vecA[i] * vecB[i];
        normA += vecA[i] * vecA[i];
        normB += vecB[i] * vecB[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) {
        return 0;
    }

    return dotProduct / (normA * normB);
}

function parseEmbeddingResponse(response) {
    const parsed = typeof response === 'string' ? JSON.parse(response) : response;
    const embedding = Array.isArray(parsed?.[0]) ? parsed[0] : parsed;
    if (!Array.isArray(embedding)) {
        throw new Error('Embedding response did not contain a vector');
    }
    return embedding;
}

export async function buildCosineSimilarityResult({
    text,
    input,
    model = 'azure-embeddings',
    embeddingPathway = callPathway,
}) {
    if (!text || !input || !Array.isArray(input)) {
        throw new Error('Both text and input are required, and input must be an array');
    }

    const validStrings = input.filter(s => s && s.trim().length > 0);
    if (validStrings.length === 0) {
        throw new Error('Input must contain at least one non-empty string');
    }

    if (text.trim().length === 0) {
        throw new Error('Text cannot be empty');
    }

    const embeddingResponses = await Promise.all([
        embeddingPathway('embeddings', { input: [text], model }),
        ...validStrings.map(string =>
            embeddingPathway('embeddings', { input: [string], model })
        ),
    ]);

    const textEmbedding = parseEmbeddingResponse(embeddingResponses[0]);
    const stringEmbeddings = embeddingResponses.slice(1).map(parseEmbeddingResponse);

    const results = stringEmbeddings.map((embedding, index) => ({
        string: validStrings[index],
        similarity: cosineSimilarity(textEmbedding, embedding),
    }));

    results.sort((a, b) => b.similarity - a.similarity);

    return {
        text,
        totalStrings: validStrings.length,
        results,
    };
}

export default {
    name: 'cosine_similarity',
    description: 'Calculates cosine similarity between a text string and an array of strings using embeddings',
    inputParameters: {
        text: '',
        input: { type: 'array', items: { type: 'string' }, default: [] },
        model: 'azure-embeddings',
    },
    executePathway: async ({ args }) => {
        try {
            return JSON.stringify(await buildCosineSimilarityResult(args));
        } catch (error) {
            throw new Error(`Cosine similarity calculation failed: ${error.message}`);
        }
    },
};
