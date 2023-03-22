const fs = require('fs');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const os = require('os');
const util = require('util');
const ffmpegProbe = util.promisify(ffmpeg.ffprobe);

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

async function splitMediaFile(inputPath, chunkDurationInSeconds=600) {
    try {
        const metadata = await ffmpegProbe(inputPath);
        const duration = metadata.format.duration;
        const numChunks = Math.ceil((duration-1) / chunkDurationInSeconds);

        const chunkPromises = [];

        // Generate unique folder name
        const uniqueFolderName = uuidv4();
        const tempFolderPath = os.tmpdir(); // Get the system's temporary folder
        const uniqueOutputPath = path.join(tempFolderPath, uniqueFolderName);

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

async function deleteTempFolder(folder) {
    try {
        if(!folder) return;
        fs.rmdirSync(folder, { recursive: true });
        console.log(`Temporary folder ${folder} and its contents deleted successfully.`);
    } catch (err) {
        console.error('Error occurred while deleting the temporary folder:', err);
    }
}


module.exports = {
   splitMediaFile, deleteTempFolder
};