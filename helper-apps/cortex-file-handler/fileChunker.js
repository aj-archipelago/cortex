import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import { promisify } from 'util';
import axios from 'axios';
import { ensureEncoded } from './helper.js';
import ytdl from 'ytdl-core';


const ffmpegProbe = promisify(ffmpeg.ffprobe);


async function processChunk(inputPath, outputFileName, start, duration) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .seekInput(start)
            .duration(duration)
            .format('mp3')
            .audioCodec('libmp3lame')
            .audioBitrate(128)
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

async function downloadFile(url, outputPath) {
    try {
        // Make an HTTP request for the file
        const response = await axios.get(url, { responseType: 'stream' });

        // Create a writable file stream to save the file
        const fileStream = fs.createWriteStream(outputPath);

        // Pipe the response data into the file stream
        response.data.pipe(fileStream);

        // Wait for the file stream to finish writing
        await new Promise((resolve, reject) => {
            fileStream.on('finish', resolve);
            fileStream.on('error', reject);
        });

        console.log(`Downloaded file saved to: ${outputPath}`);
    } catch (error) {
        console.error(`Error downloading file from ${url}:`, error);
        throw error;
    }
}

// Split a media file into chunks of max 500 seconds
async function splitMediaFile(inputPath, chunkDurationInSeconds = 500) {
    try {
        // Create unique folder
        const uniqueOutputPath = generateUniqueFolderName();
        fs.mkdirSync(uniqueOutputPath, { recursive: true });

        // Download the file if it's not a local file
        const isUrl = /^(https?|ftp):\/\/[^\s/$.?#].[^\s]*$/i.test(inputPath);
        if (isUrl) {
            inputPath = ensureEncoded(inputPath);
            // Extract the original file name from the URL
            const urlObj = new URL(inputPath);
            const originalFileName = path.basename(urlObj.pathname);

            // Use the original file name when saving the downloaded file
            const downloadPath = path.join(uniqueOutputPath, originalFileName);
            await downloadFile(inputPath, downloadPath);
            inputPath = downloadPath;
        }

        const metadata = await ffmpegProbe(inputPath);
        const duration = metadata.format.duration;
        const numChunks = Math.ceil((duration - 1) / chunkDurationInSeconds);

        const chunkPromises = [];
        const chunkOffsets = [];

        for (let i = 0; i < numChunks; i++) {
            const outputFileName = path.join(uniqueOutputPath, `chunk-${i + 1}-${path.parse(inputPath).name}.mp3`);
            const offset = i * chunkDurationInSeconds;

            const chunkPromise = processChunk(inputPath, outputFileName, offset, chunkDurationInSeconds);
            
            chunkPromises.push(chunkPromise);
            chunkOffsets.push(offset);
        }

        return { chunkPromises, chunkOffsets, uniqueOutputPath }; 
    } catch (err) {
        const msg = `Error processing media file, check if the file is a valid media file or is accessible`;
        console.error(msg, err);
        throw new Error(msg);
    }
}

const ytdlDownload = async (url, filename, video = false) => {
    return new Promise((resolve, reject) => {
        const videoOptions = video 
            ? { filter: 'audioandvideo' }  // audio and video
            : { quality: 'highestaudio' }; // audio only

        const videoStream = ytdl(url, videoOptions);
        let lastLoggedTime = Date.now();

        videoStream.on('error', (error) => {
            reject(error);
        });

        videoStream.on('progress', (chunkLength, downloaded, total) => {
            const currentTime = Date.now();
            if (currentTime - lastLoggedTime >= 2000) { // Log every 2 seconds
                const percent = downloaded / total;
                console.log(`${(percent * 100).toFixed(2)}% downloaded ${url}`);
                lastLoggedTime = currentTime;
            }
        });

        videoStream.pipe(fs.createWriteStream(filename))
            .on('finish', () => {
                resolve();
            })
            .on('error', (error) => {
                reject(error);
            });
    });
};

async function processYoutubeUrl(url, video=false) {
    try {
        const outputFormat = video ? '.mp4' : '.mp3';
        const outputFileName = path.join(os.tmpdir(), `${uuidv4()}${outputFormat}`);
        await ytdlDownload(url, outputFileName, video);
        return outputFileName;
    } catch (e) {
        console.log(e);
        throw e;
    }
}

export {
    splitMediaFile, processYoutubeUrl, downloadFile
};