const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const util = require('util');
const ffmpegProbe = util.promisify(ffmpeg.ffprobe);
const pipeline = util.promisify(require('stream').pipeline);
const ytdl = require('ytdl-core');


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

        const chunkedFiles = await Promise.all(chunkPromises);
        console.log('All chunks processed. Chunked file names:', chunkedFiles);
        return { chunks: chunkedFiles, folder: uniqueOutputPath }
    } catch (err) {
        console.error('Error occurred during the splitting process:', err);
    }
}

async function deleteTempPath(path) {
    try {
        if (!path) return;
        const stats = fs.statSync(path);
        if (stats.isFile()) {
            fs.unlinkSync(path);
            console.log(`Temporary file ${path} deleted successfully.`);
        } else if (stats.isDirectory()) {
            fs.rmdirSync(path, { recursive: true });
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
        .withAudioCodec('libmp3lame')
        .toFormat('mp3')
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


const processYoutubeUrl = async (url) => {
    const mp3Stream = convertYoutubeToMp3Stream(ytdl(url));
    const outputFileName = path.join(os.tmpdir(), `${uuidv4()}.mp3`);
    await pipeStreamToFile(mp3Stream, outputFileName); // You can also pipe the stream to a file
    return outputFileName;
}

function deleteFile(filePath) {
    try {
        fs.unlinkSync(filePath);
        console.log(`File ${filePath} cleaned successfully.`);
    } catch (error) {
        console.error(`Error deleting file ${filePath}:`, error);
    }
}

module.exports = {
    splitMediaFile, deleteTempPath, processYoutubeUrl, isValidYoutubeUrl
};