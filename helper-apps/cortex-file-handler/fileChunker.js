import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import { promisify } from 'util';
import axios from 'axios';
import { ensureEncoded } from './helper.js';

const ffmpegProbe = promisify(ffmpeg.ffprobe);

// Temp file management
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const tempDirectories = new Map(); // dir -> { createdAt, requestId }

// Temp directory cleanup
async function cleanupTempDirectories() {
    const tempDir = os.tmpdir();
    
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

// Process a single chunk with streaming
async function processChunk(inputPath, outputFileName, start, duration) {
    return new Promise((resolve, reject) => {
        const command = ffmpeg(inputPath)
            .seekInput(start)
            .duration(duration)
            .format('mp3')
            .audioCodec('libmp3lame')
            .audioBitrate(128);

        // Set up streaming pipeline
        command.stream()
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
            })
            .pipe(fs.createWriteStream(outputFileName));
    });
}

const generateUniqueFolderName = () => {
    const uniqueFolderName = uuidv4();
    const tempFolderPath = os.tmpdir();
    return path.join(tempFolderPath, uniqueFolderName);
}

async function downloadFile(url, outputPath) {
    try {
        let response;
        try {
            response = await axios.get(decodeURIComponent(url), { responseType: 'stream' });
        } catch (error) {
            response = await axios.get(url, { responseType: 'stream' });
        }

        const fileStream = fs.createWriteStream(outputPath);
        response.data.pipe(fileStream);

        await new Promise((resolve, reject) => {
            fileStream.on('finish', resolve);
            fileStream.on('error', reject);
        });

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

async function splitMediaFile(inputPath, chunkDurationInSeconds = 500, requestId = uuidv4()) {
    let tempPath = null;
    let uniqueOutputPath = null;
    let inputStream = null;
    
    try {
        uniqueOutputPath = generateUniqueFolderName();
        fs.mkdirSync(uniqueOutputPath, { recursive: true });
        
        // Track temp directory for cleanup
        tempDirectories.set(uniqueOutputPath, {
            createdAt: Date.now(),
            requestId
        });

        // Handle URL downloads with streaming
        const isUrl = /^(https?|ftp):\/\/[^\s/$.?#].[^\s]*$/i.test(inputPath);
        if (isUrl) {
            const urlObj = new URL(ensureEncoded(inputPath));
            const originalFileName = path.basename(urlObj.pathname) || 'downloaded_file';
            tempPath = path.join(uniqueOutputPath, originalFileName);
            console.log('Downloading file to:', tempPath);
            await downloadFile(inputPath, tempPath);
            inputPath = tempPath;
        }

        // Convert to absolute path and verify existence
        inputPath = path.resolve(inputPath);
        if (!fs.existsSync(inputPath)) {
            throw new Error(`Input file not found: ${inputPath}`);
        }

        // Create read stream for input file
        inputStream = fs.createReadStream(inputPath, { highWaterMark: 1024 * 1024 }); // 1MB chunks

        console.log('Probing file:', inputPath);
        const metadata = await ffmpegProbe(inputPath);
        if (!metadata?.format?.duration) {
            throw new Error('Invalid media file or unable to determine duration');
        }

        const duration = metadata.format.duration;
        const numChunks = Math.ceil((duration - 1) / chunkDurationInSeconds);
        console.log(`Processing ${numChunks} chunks of ${chunkDurationInSeconds} seconds each`);

        const chunkPromises = [];
        const chunkOffsets = [];

        // Process chunks sequentially with streaming
        for (let i = 0; i < numChunks; i++) {
            const outputFileName = path.join(uniqueOutputPath, `chunk-${i + 1}-${path.parse(inputPath).name}.mp3`);
            const offset = i * chunkDurationInSeconds;
            
            try {
                const result = await processChunk(inputPath, outputFileName, offset, chunkDurationInSeconds);
                chunkPromises.push(result);
                chunkOffsets.push(offset);
                console.log(`Completed chunk ${i + 1}/${numChunks}`);
            } catch (error) {
                console.error(`Failed to process chunk ${i + 1}:`, error);
                // Continue with next chunk
            }
        }

        if (chunkPromises.length === 0) {
            throw new Error('No chunks were successfully processed');
        }

        return { chunkPromises, chunkOffsets, uniqueOutputPath };
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
        // Clean up resources
        if (inputStream) {
            try {
                inputStream.destroy();
            } catch (err) {
                console.error('Error closing input stream:', err);
            }
        }
    }
}

export {
    splitMediaFile,
    downloadFile
};