import fs from 'fs';
import { path as ffmpegPath } from '@ffmpeg-installer/ffmpeg';
import { path as ffprobePath } from '@ffprobe-installer/ffprobe';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import { pipeline } from 'stream';
import ytdl from 'ytdl-core';
import { promisify } from 'util';

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);
console.log(`ffmpegPath: ${ffmpegPath}`);
console.log(`ffprobePath: ${ffprobePath}`);

const ffmpegProbe = promisify(ffmpeg.ffprobe);

async function processChunk(inputPath, outputFileName, start, duration) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .seekInput(start)
            .duration(duration)
            .audioCodec('libmp3lame') // Ensure output is always in MP3 format
            .on('start', (cmd) => {
                console.log(`Started FFmpeg with command: ${cmd}`);
            })
            .on('error', (err) => {
                console.error(`Error occurred while processing chunk:`, err);
                reject(err);
            })
            .on('end', () => {
                console.log(`Finished processing chunk`);
                resolve(outputFileName);
            })
            .save(outputFileName);
    });
}

const generateUniqueFolderName = () => {
    const uniqueFolderName = uuidv4();
    const tempFolderPath = os.tmpdir(); // Get the system's temporary folder
    const uniqueOutputPath = path.join(tempFolderPath, uniqueFolderName);
    return uniqueOutputPath;
}

async function splitMediaFile(inputPath, chunkDurationInSeconds = 600) {
    try {
        const metadata = await ffmpegProbe(inputPath);
        const duration = metadata.format.duration;
        const numChunks = Math.ceil((duration - 1) / chunkDurationInSeconds);

        const chunkPromises = [];

        const uniqueOutputPath = generateUniqueFolderName();

        // Create unique folder
        fs.mkdirSync(uniqueOutputPath, { recursive: true });


        for (let i = 0; i < numChunks; i++) {
            const outputFileName = path.join(
                uniqueOutputPath,
                `chunk-${i + 1}-${path.parse(inputPath).name}.mp3`
            );

            const chunkPromise = processChunk(
                inputPath,
                outputFileName,
                i * chunkDurationInSeconds,
                chunkDurationInSeconds
            );

            chunkPromises.push(chunkPromise);
        }

        return { chunkPromises, uniqueOutputPath }
    } catch (err) {
        console.error('Error occurred during the splitting process:', err);
    }
}

async function pipeStreamToFile(stream, filePath) {
    try {
        await pipeline(stream, fs.createWriteStream(filePath));
        console.log('Stream piped to file successfully.');
    } catch (error) {
        console.error(`Error piping stream to file: ${error.message}`);
    }
}


const ytdlDownload = async (url, filename) => {
    return new Promise((resolve, reject) => {
        const video = ytdl(url, { quality: 'highestaudio' });
        let lastLoggedTime = Date.now();

        video.on('error', (error) => {
            reject(error);
        });

        video.on('progress', (chunkLength, downloaded, total) => {
            const currentTime = Date.now();
            if (currentTime - lastLoggedTime >= 2000) { // Log every 2 seconds
                const percent = downloaded / total;
                console.log(`${(percent * 100).toFixed(2)}% downloaded ${url}`);
                lastLoggedTime = currentTime;
            }
        });

        video.pipe(fs.createWriteStream(filename))
            .on('finish', () => {
                resolve();
            })
            .on('error', (error) => {
                reject(error);
            });
    });
};

const processYoutubeUrl = async (url) => {
    try {
        const outputFileName = path.join(os.tmpdir(), `${uuidv4()}.mp3`);
        await ytdlDownload(url, outputFileName);
        return outputFileName;
    } catch (e) {
        console.log(e);
        throw e;
    }
}

export {
    splitMediaFile, processYoutubeUrl
};