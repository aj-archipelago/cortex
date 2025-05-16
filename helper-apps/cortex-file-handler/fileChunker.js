import fs from 'fs';
import http from 'http';
import https from 'https';
import os from 'os';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { promisify } from 'util';

import axios from 'axios';
import ffmpeg from 'fluent-ffmpeg';
import { v4 as uuidv4 } from 'uuid';

import { ensureEncoded } from './helper.js';

const ffmpegProbe = promisify(ffmpeg.ffprobe);

// Temp file management
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const tempDirectories = new Map(); // dir -> { createdAt, requestId }

// Temp directory cleanup
async function cleanupTempDirectories() {
    for (const [dir, info] of tempDirectories) {
        try {
            // Cleanup directories older than 1 hour
            if (Date.now() - info.createdAt > 60 * 60 * 1000) {
                await fs.promises.rm(dir, { recursive: true, force: true });
                tempDirectories.delete(dir);
                console.log(`Cleaned up old temp directory: ${dir}`);
            }
        } catch (err) {
            // Directory might be gone
            tempDirectories.delete(dir);
        }
    }
}

// Setup periodic cleanup
setInterval(async () => {
    try {
        await cleanupTempDirectories();
    } catch (err) {
        console.error('Error during periodic cleanup:', err);
    }
}, CLEANUP_INTERVAL_MS);

// Process a single chunk with streaming and progress tracking
async function processChunk(inputPath, outputFileName, start, duration) {
    return new Promise((resolve, reject) => {
        const command = ffmpeg(inputPath)
            .seekInput(start)
            .duration(duration)
            .format('mp3')
            .audioCodec('libmp3lame')
            .audioBitrate(128)
            .on('start', () => {
                console.log(`Processing chunk: ${start}s -> ${start + duration}s`);
            })
            .on('progress', (progress) => {
                if (progress.percent) {
                    console.log(`Chunk progress: ${progress.percent}%`);
                }
            })
            .on('error', (err, stdout, stderr) => {
                console.error('FFmpeg error:', err.message);
                if (stdout) console.log('FFmpeg stdout:', stdout);
                if (stderr) console.error('FFmpeg stderr:', stderr);
                reject(err);
            })
            .on('end', () => {
                console.log(`Chunk complete: ${outputFileName}`);
                resolve(outputFileName);
            });

        // Use pipeline for better error handling and backpressure
        pipeline(
            command,
            fs.createWriteStream(outputFileName, { highWaterMark: 4 * 1024 * 1024 }), // 4MB chunks
        ).catch(reject);
    });
}

const generateUniqueFolderName = () => {
    const uniqueFolderName = uuidv4();
    const tempFolderPath = os.tmpdir();
    return path.join(tempFolderPath, uniqueFolderName);
};

async function downloadFile(url, outputPath) {
    try {
        const agent = {
            http: new http.Agent({
                keepAlive: true,
                maxSockets: 10,
                maxFreeSockets: 10,
                timeout: 60000,
            }),
            https: new https.Agent({
                keepAlive: true,
                maxSockets: 10,
                maxFreeSockets: 10,
                timeout: 60000,
            }),
        };

        let response;
        try {
            response = await axios.get(decodeURIComponent(url), {
                responseType: 'stream',
                timeout: 30000,
                maxContentLength: Infinity,
                decompress: true,
                httpAgent: agent.http,
                httpsAgent: agent.https,
                maxRedirects: 5,
                validateStatus: (status) => status >= 200 && status < 300,
            });
        } catch (error) {
            response = await axios.get(url, {
                responseType: 'stream',
                timeout: 30000,
                maxContentLength: Infinity,
                decompress: true,
                httpAgent: agent.http,
                httpsAgent: agent.https,
                maxRedirects: 5,
                validateStatus: (status) => status >= 200 && status < 300,
            });
        }

        // Use pipeline for better error handling and memory management
        await pipeline(
            response.data,
            fs.createWriteStream(outputPath, { highWaterMark: 4 * 1024 * 1024 }), // 4MB chunks
        );

        if (!fs.existsSync(outputPath) || fs.statSync(outputPath).size === 0) {
            throw new Error('Download failed or file is empty');
        }
    } catch (error) {
        if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
        }
        throw error;
    }
}

async function splitMediaFile(
    inputPath,
    chunkDurationInSeconds = 500,
    requestId = uuidv4(),
) {
    let tempPath = null;
    let uniqueOutputPath = null;
    let inputStream = null;

    try {
        uniqueOutputPath = generateUniqueFolderName();
        fs.mkdirSync(uniqueOutputPath, { recursive: true });

        tempDirectories.set(uniqueOutputPath, {
            createdAt: Date.now(),
            requestId,
        });

        // Handle URL downloads with streaming
        const isUrl = /^(https?|ftp):\/\/[^\s/$.?#].[^\s]*$/i.test(inputPath);
        if (isUrl) {
            const urlObj = new URL(ensureEncoded(inputPath));
            const originalFileName =
        path.basename(urlObj.pathname) || 'downloaded_file';
            tempPath = path.join(uniqueOutputPath, originalFileName);
            console.log('Downloading file to:', tempPath);
            await downloadFile(inputPath, tempPath);
            inputPath = tempPath;
        }

        inputPath = path.resolve(inputPath);
        if (!fs.existsSync(inputPath)) {
            throw new Error(`Input file not found: ${inputPath}`);
        }

        // Use a larger chunk size for better throughput while still managing memory
        inputStream = fs.createReadStream(inputPath, {
            highWaterMark: 4 * 1024 * 1024, // 4MB chunks
            autoClose: true,
        });

        console.log('Probing file:', inputPath);
        const metadata = await ffmpegProbe(inputPath);
        if (!metadata?.format?.duration) {
            throw new Error('Invalid media file or unable to determine duration');
        }

        const duration = metadata.format.duration;
        const numChunks = Math.ceil((duration - 1) / chunkDurationInSeconds);
        console.log(
            `Processing ${numChunks} chunks of ${chunkDurationInSeconds} seconds each`,
        );

        const chunkResults = new Array(numChunks); // Pre-allocate array to maintain order
        const chunkOffsets = new Array(numChunks); // Pre-allocate offsets array

        // Process chunks in parallel with a concurrency limit
        const CONCURRENT_CHUNKS = Math.min(3, os.cpus().length); // Use CPU count to determine concurrency
        const chunkPromises = [];

        for (let i = 0; i < numChunks; i += CONCURRENT_CHUNKS) {
            const chunkBatch = [];
            for (let j = 0; j < CONCURRENT_CHUNKS && i + j < numChunks; j++) {
                const chunkIndex = i + j;
                const outputFileName = path.join(
                    uniqueOutputPath,
                    `chunk-${chunkIndex + 1}-${path.parse(inputPath).name}.mp3`,
                );
                const offset = chunkIndex * chunkDurationInSeconds;

                chunkBatch.push(
                    processChunk(
                        inputPath,
                        outputFileName,
                        offset,
                        chunkDurationInSeconds,
                    )
                        .then((result) => {
                            chunkResults[chunkIndex] = result; // Store in correct position
                            chunkOffsets[chunkIndex] = offset; // Store offset in correct position
                            console.log(`Completed chunk ${chunkIndex + 1}/${numChunks}`);
                            return result;
                        })
                        .catch((error) => {
                            console.error(
                                `Failed to process chunk ${chunkIndex + 1}:`,
                                error,
                            );
                            return null;
                        }),
                );
            }

            // Wait for the current batch to complete before starting the next
            await Promise.all(chunkBatch);
        }

        // Filter out any failed chunks
        const validChunks = chunkResults.filter(Boolean);
        const validOffsets = chunkOffsets.filter((_, index) => chunkResults[index]);

        if (validChunks.length === 0) {
            throw new Error('No chunks were successfully processed');
        }

        return {
            chunkPromises: validChunks,
            chunkOffsets: validOffsets,
            uniqueOutputPath,
        };
    } catch (err) {
        if (uniqueOutputPath && fs.existsSync(uniqueOutputPath)) {
            try {
                fs.rmSync(uniqueOutputPath, { recursive: true, force: true });
                tempDirectories.delete(uniqueOutputPath);
            } catch (cleanupErr) {
                console.error('Error during cleanup:', cleanupErr);
            }
        }
        console.error('Error in splitMediaFile:', err);
        throw new Error(`Error processing media file: ${err.message}`);
    } finally {
        if (inputStream) {
            try {
                inputStream.destroy();
            } catch (err) {
                console.error('Error closing input stream:', err);
            }
        }
    }
}

export { splitMediaFile, downloadFile };
