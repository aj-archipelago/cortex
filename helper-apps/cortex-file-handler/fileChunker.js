import fs from 'fs';
import path from 'path';
import ffmpeg from 'fluent-ffmpeg';
import { v4 as uuidv4 } from 'uuid';
import os from 'os';
import { promisify } from 'util';
import axios from 'axios';
import { ensureEncoded } from './helper.js';


const ffmpegProbe = promisify(ffmpeg.ffprobe);


async function processChunk(inputPath, outputFileName, start, duration) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .seekInput(start)
            .duration(duration)
            .format('mp3')
            .audioCodec('libmp3lame')
            .audioBitrate(128)
            .on('error', (err) => {
                reject(err);
            })
            .on('end', () => {
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
    } catch (error) {
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
            const maxLength = 200; // Set the maximum length for the filename
            let truncatedFileName = originalFileName;
            if (originalFileName.length > maxLength) {
                const extension = path.extname(originalFileName); // Preserve the file extension
                const basename = path.basename(originalFileName, extension); // Get the filename without the extension
                truncatedFileName = basename.substring(0, maxLength) + extension; // Truncate the filename and append the extension
            }

            // Use the original-truncated file name when saving the downloaded file
            const downloadPath = path.join(uniqueOutputPath, truncatedFileName);
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
        throw new Error(`Error processing media file, check if the file is a valid media file or is accessible`);
    }
}

export {
    splitMediaFile, downloadFile
};