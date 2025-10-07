/**
 * Node.js Client Example for Document to PDF Converter
 * 
 * This example shows how to:
 * 1. Upload files with streaming
 * 2. Download PDFs with streaming
 * 3. Save to local file system
 */

const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const axios = require('axios');

const SERVICE_URL = process.env.DOC_TO_PDF_URL || 'http://localhost:8080';

/**
 * Method 1: Upload local file (Recommended - Streaming)
 * Uses streams for memory efficiency
 */
async function convertFileToPDF(inputFilePath, outputFilePath) {
    try {
        console.log(`📤 Uploading: ${inputFilePath}`);

        // Create form data with file stream
        const form = new FormData();
        const fileStream = fs.createReadStream(inputFilePath);
        form.append('file', fileStream, path.basename(inputFilePath));

        // Upload with streaming (both upload and download)
        const response = await axios({
            method: 'POST',
            url: `${SERVICE_URL}/`,  // Can use / or /convert
            data: form,
            headers: {
                ...form.getHeaders(),
            },
            responseType: 'stream',  // Stream the response
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
        });

        // Stream the PDF response to file
        const writer = fs.createWriteStream(outputFilePath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                console.log(`✅ Saved to: ${outputFilePath}`);
                const stats = fs.statSync(outputFilePath);
                console.log(`📄 Size: ${(stats.size / 1024).toFixed(2)} KB`);
                resolve(outputFilePath);
            });
            writer.on('error', reject);
        });

    } catch (error) {
        console.error('❌ Conversion failed:', error.message);
        if (error.response) {
            console.error('Response:', error.response.data);
        }
        throw error;
    }
}

/**
 * Method 2: Convert from URI
 * Downloads from URL and converts to PDF
 */
async function convertUriToPDF(documentUri, outputFilePath) {
    try {
        console.log(`🌐 Converting from URI: ${documentUri}`);

        const response = await axios({
            method: 'POST',
            url: `${SERVICE_URL}/convert`,
            data: { uri: documentUri },
            headers: {
                'Content-Type': 'application/json',
            },
            responseType: 'stream',  // Stream the response
        });

        // Stream to file
        const writer = fs.createWriteStream(outputFilePath);
        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                console.log(`✅ Saved to: ${outputFilePath}`);
                resolve(outputFilePath);
            });
            writer.on('error', reject);
        });

    } catch (error) {
        console.error('❌ Conversion failed:', error.message);
        if (error.response) {
            const chunks = [];
            for await (const chunk of error.response.data) {
                chunks.push(chunk);
            }
            console.error('Error:', JSON.parse(Buffer.concat(chunks).toString()));
        }
        throw error;
    }
}

/**
 * Method 3: Upload with progress tracking
 * Shows upload and download progress
 */
async function convertFileWithProgress(inputFilePath, outputFilePath) {
    try {
        console.log(`📤 Uploading: ${inputFilePath}`);

        const form = new FormData();
        const fileStream = fs.createReadStream(inputFilePath);
        const fileSize = fs.statSync(inputFilePath).size;

        form.append('file', fileStream, path.basename(inputFilePath));

        let uploadedBytes = 0;

        const response = await axios({
            method: 'POST',
            url: `${SERVICE_URL}/`,
            data: form,
            headers: form.getHeaders(),
            responseType: 'stream',
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
            onUploadProgress: (progressEvent) => {
                uploadedBytes = progressEvent.loaded;
                const percent = Math.round((progressEvent.loaded * 100) / fileSize);
                process.stdout.write(`\r📤 Upload: ${percent}%`);
            },
        });

        console.log('\n📥 Downloading PDF...');

        const writer = fs.createWriteStream(outputFilePath);
        let downloadedBytes = 0;

        response.data.on('data', (chunk) => {
            downloadedBytes += chunk.length;
            process.stdout.write(`\r📥 Downloaded: ${(downloadedBytes / 1024).toFixed(2)} KB`);
        });

        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                console.log(`\n✅ Saved to: ${outputFilePath}`);
                resolve(outputFilePath);
            });
            writer.on('error', reject);
        });

    } catch (error) {
        console.error('\n❌ Conversion failed:', error.message);
        throw error;
    }
}

/**
 * Method 4: Batch conversion
 * Convert multiple files efficiently
 */
async function convertMultipleFiles(inputFiles, outputDir) {
    console.log(`📦 Converting ${inputFiles.length} files...`);

    const results = [];

    for (const inputFile of inputFiles) {
        try {
            const fileName = path.basename(inputFile, path.extname(inputFile));
            const outputFile = path.join(outputDir, `${fileName}.pdf`);

            await convertFileToPDF(inputFile, outputFile);
            results.push({ success: true, input: inputFile, output: outputFile });
        } catch (error) {
            results.push({ success: false, input: inputFile, error: error.message });
        }
    }

    // Summary
    const successful = results.filter(r => r.success).length;
    console.log(`\n✅ Converted ${successful}/${inputFiles.length} files`);

    return results;
}

/**
 * Health check
 */
async function checkHealth() {
    try {
        const response = await axios.get(`${SERVICE_URL}/health`);
        console.log('✅ Service is healthy:', response.data);
        return true;
    } catch (error) {
        console.error('❌ Service is not available:', error.message);
        return false;
    }
}

// Example usage
async function main() {
    // Check if service is running
    const isHealthy = await checkHealth();
    if (!isHealthy) {
        console.error('Service is not available. Please start it first.');
        process.exit(1);
    }

    console.log('\n=== Document to PDF Converter - Node.js Client ===\n');

    // Example 1: Convert a single file
    await convertFileToPDF(
        '../samples/data.txt',
        './output/data.pdf'
    );

    console.log('\n---\n');

    // Example 2: Convert with progress
    await convertFileWithProgress(
        '../samples/file-sample_1MB.docx',
        './output/document.pdf'
    );

    console.log('\n---\n');

    // Example 3: Convert from URI
    // await convertUriToPDF(
    //     'https://example.com/document.docx',
    //     './output/from-uri.pdf'
    // );

    // Example 4: Batch conversion
    // await convertMultipleFiles(
    //     ['file1.docx', 'file2.xlsx', 'file3.pptx'],
    //     './output'
    // );
}

// Run if called directly
if (require.main === module) {
    // Create output directory
    const outputDir = path.join(__dirname, 'output');
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    main().catch(console.error);
}

// Export for use in other modules
module.exports = {
    convertFileToPDF,
    convertUriToPDF,
    convertFileWithProgress,
    convertMultipleFiles,
    checkHealth,
};
