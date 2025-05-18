import axios from 'axios';
import { execSync } from 'child_process';
import fs from 'fs/promises';

export async function cleanupHashAndFile(hash, uploadedUrl, baseUrl) {   
    // Only perform hash operations if hash is provided
    if (hash) {
        try {
            const clearResponse = await axios.get(
                `${baseUrl}?hash=${hash}&clearHash=true`,
                {
                    validateStatus: (status) => true,
                    timeout: 10000,
                },
            );
        } catch (error) {
            console.error(`[cleanupHashAndFile] Error clearing hash: ${error.message}`);
        }
    }

    // Then delete the file
    try {
        const folderName = getFolderNameFromUrl(uploadedUrl);
        const deleteResponse = await axios.delete(
            `${baseUrl}?operation=delete&requestId=${folderName}`,
            {
                validateStatus: (status) => true,
                timeout: 10000,
            },
        );
    } catch (error) {
        console.error(`[cleanupHashAndFile] Error deleting file: ${error.message}`);
    }

    // Only verify hash if hash was provided
    if (hash) {
        try {
            const verifyResponse = await axios.get(
                `${baseUrl}?hash=${hash}&checkHash=true`,
                {
                    validateStatus: (status) => true,
                    timeout: 10000,
                },
            );
        } catch (error) {
            console.error(`[cleanupHashAndFile] Error verifying hash: ${error.message}`);
        }
    }
}

export function getFolderNameFromUrl(url) {
    const urlObj = new URL(url);
    const parts = urlObj.pathname.split('/').filter(Boolean);
    if (url.includes('127.0.0.1:10000')) {
        return parts[2].split('_')[0];
    }
    return parts[1].split('_')[0];
}

// Helper function to create a test media (audio) file of specified duration using ffmpeg
export async function createTestMediaFile(filepath, durationSeconds = 10) {
    try {
        console.log(`Creating test file: ${filepath} (${durationSeconds}s)`);
        // Generate silence using ffmpeg (mono, 44.1kHz)
        execSync(
            `ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t ${durationSeconds} -q:a 9 -acodec libmp3lame "${filepath}"`,
            {
                stdio: ['ignore', 'pipe', 'pipe'], // Capture stdout and stderr
            },
        );

        // Verify the file was created and has content
        const stats = await fs.stat(filepath);
        if (stats.size === 0) {
            throw new Error('Generated file is empty');
        }
        console.log(
            `Successfully created ${filepath} (${(stats.size / 1024 / 1024).toFixed(2)}MB)`,
        );
    } catch (error) {
        console.error(`Error creating test file ${filepath}:`, error.message);
        if (error.stderr) console.error('ffmpeg error:', error.stderr.toString());
        throw error;
    }
} 