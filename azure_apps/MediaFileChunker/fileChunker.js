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

const generateUniqueTempFileName = () => {
    return path.join(os.tmpdir(), uuidv4());
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
                `chunk-${i + 1}-${path.basename(inputPath)}`
            );

            const chunkPromise = processChunk(
                inputPath,
                outputFileName,
                i * chunkDurationInSeconds,
                chunkDurationInSeconds
            );

            chunkPromises.push(chunkPromise);
        }

        // const chunkedFiles = await Promise.all(chunkPromises);
        // console.log('All chunks processed. Chunked file names:', chunkedFiles);
        // return { chunks: chunkedFiles, folder: uniqueOutputPath }
        return { chunkPromises, uniqueOutputPath }
    } catch (err) {
        console.error('Error occurred during the splitting process:', err);
    }
}

async function deleteTempPath(path) {
    try {
        if (!path) {
            console.log('Temporary path is not defined.');
            return;
        }
        if (!fs.existsSync(path)) {
            console.log(`Temporary path ${path} does not exist.`);
            return;
        }
        const stats = fs.statSync(path);
        if (stats.isFile()) {
            fs.unlinkSync(path);
            console.log(`Temporary file ${path} deleted successfully.`);
        } else if (stats.isDirectory()) {
            fs.rmSync(path, { recursive: true });
            console.log(`Temporary folder ${path} and its contents deleted successfully.`);
        }
    } catch (err) {
        console.error('Error occurred while deleting the temporary path:', err);
    }
}


function isValidYoutubeUrl(url) {
    const regex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.?be)\/.+$/;
    return regex.test(url);
}

function convertYoutubeToMp3Stream(video) {
    // Configure ffmpeg to convert the video to mp3
    const mp3Stream = ffmpeg(video)
        // .withAudioCodec('libmp3lame')
        // .toFormat('mp3')
        .audioBitrate(128)
        .on('error', (err) => {
            console.error(`An error occurred during conversion: ${err.message}`);
        });

    return mp3Stream;
}

async function pipeStreamToFile(stream, filePath) {
    try {
        await pipeline(stream, fs.createWriteStream(filePath));
        console.log('Stream piped to file successfully.');
    } catch (error) {
        console.error(`Error piping stream to file: ${error.message}`);
    }
}

const saveYoutubeUrl = async (url, filename) => {
    let stream = ytdl(url, {
        quality: 'highestaudio',
    });

    return new Promise((resolve, reject) => {
        ffmpeg(stream)
            .audioBitrate(128)
            .save(filename)
            .on('progress', p => {
                readline.cursorTo(process.stdout, 0);
                process.stdout.write(`${p.targetSize}kb downloaded`);
            })
            .on('error', (err) => {
                console.log('an error happened: ' + err.message);
                reject(err);
            })
            .on('end', () => {
                console.log(`\ndone, thanks - ${(Date.now() - start) / 1000}s`);
                resolve(filename);
            });
    });
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

    // const info = await ytdl.getInfo(url);
    // const audioFormat = ytdl.chooseFormat(info.formats, { quality: 'highestaudio' });

    // if (!audioFormat) {
    //     throw new Error('No suitable audio format found');
    // }

    // const stream = ytdl.downloadFromInfo(info, { format: audioFormat });
    // // const stream = ytdl(url, { filter: 'audioonly' })

    // const mp3Stream = convertYoutubeToMp3Stream(stream);
    // await pipeStreamToFile(mp3Stream, outputFileName); // You can also pipe the stream to a file
    // return outputFileName;
}

function deleteFile(filePath) {
    try {
        fs.unlinkSync(filePath);
        console.log(`File ${filePath} cleaned successfully.`);
    } catch (error) {
        console.error(`Error deleting file ${filePath}:`, error);
    }
}

export {
    splitMediaFile, deleteTempPath, processYoutubeUrl, isValidYoutubeUrl, saveYoutubeUrl
};