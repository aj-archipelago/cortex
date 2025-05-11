import { createReadStream, createWriteStream } from 'fs';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { pipeline } from 'stream/promises';

import axios from 'axios';
import Papa from 'papaparse';
import * as pdfjsLib from 'pdfjs-dist';
import XLSX from 'xlsx';

const MARKITDOWN_CONVERT_URL =
  process.env.MARKITDOWN_CONVERT_URL;

if (!MARKITDOWN_CONVERT_URL) {
    throw new Error('MARKITDOWN_CONVERT_URL is not set');
}

export async function convertDocument(filePath, originalUrl = null) {
    const ext = path.extname(filePath).toLowerCase();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'convert-'));

    try {
    // Handle Excel files
        if (ext === '.xlsx' || ext === '.xls') {
            const csvPath = await xlsxToCsv(filePath);
            const convertedPath = path.join(
                tempDir,
                `${path.basename(filePath, ext)}.csv`,
            );
            await pipeline(
                createReadStream(csvPath, { highWaterMark: 64 * 1024 }),
                createWriteStream(convertedPath, { highWaterMark: 64 * 1024 }),
            );
            await fs.unlink(csvPath);
            return {
                convertedPath,
                convertedName: path.basename(convertedPath),
                converted: true,
            };
        }

        // Handle documents that need markdown conversion
        if (
            ext === '.docx' ||
      ext === '.doc' ||
      ext === '.ppt' ||
      ext === '.pptx'
        ) {
            if (!originalUrl) {
                throw new Error('Original URL is required for document conversion');
            }

            const markdown = await convertToMarkdown(originalUrl);
            if (!markdown) {
                throw new Error('Markdown conversion returned empty result');
            }

            const convertedPath = path.join(
                tempDir,
                `${path.basename(filePath, ext)}.md`,
            );
            await fs.writeFile(convertedPath, markdown);
            return {
                convertedPath,
                convertedName: path.basename(convertedPath),
                converted: true,
            };
        }

        // No conversion needed
        return { converted: false };
    } catch (error) {
    // Clean up temp directory on error
        await fs.rm(tempDir, { recursive: true, force: true });
        throw error;
    }
}

export async function convertToMarkdown(fileUrl) {
    try {
        const apiUrl = `${MARKITDOWN_CONVERT_URL}${encodeURIComponent(fileUrl)}`;
        console.log('Calling Markitdown API:', apiUrl);
        const response = await axios.get(apiUrl);
        console.log('Markitdown API response:', JSON.stringify(response.data));
        return response.data.markdown || '';
    } catch (err) {
        console.error(
            'Error converting to markdown via Markitdown API:',
            err.message,
        );
        throw err;
    }
}

export async function txtToText(filePath) {
    const chunks = [];
    for await (const chunk of createReadStream(filePath, {
        highWaterMark: 64 * 1024,
    })) {
        chunks.push(chunk);
    }
    return Buffer.concat(chunks).toString('utf-8');
}

export async function xlsxToText(filePath) {
    const workbook = XLSX.readFile(filePath, { type: 'buffer' });
    let finalText = '';

    workbook.SheetNames.forEach((sheetName) => {
        const sheet = workbook.Sheets[sheetName];
        const sheetAsJson = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        sheetAsJson.forEach((row) => {
            finalText += row.join(' ') + '\n';
        });
    });

    return finalText;
}

async function pdfToText(filePath) {
    const pdf = await pdfjsLib.getDocument({
        url: filePath,
        cMapUrl: 'https://unpkg.com/pdfjs-dist@2.12.313/cmaps/',
        cMapPacked: true,
        standardFontDataUrl:
      'https://unpkg.com/pdfjs-dist@2.12.313/standard_fonts/',
    }).promise;

    const meta = await pdf.getMetadata();

    // Check if pdf is scanned
    if (
        meta &&
    meta.metadata &&
    meta.metadata._metadataMap &&
    meta.metadata._metadataMap.has('dc:format')
    ) {
        const format = meta.metadata._metadataMap.get('dc:format');
        if (
            format &&
      format._value &&
      format._value.toLowerCase() === 'application/pdf; version=1.3'
        ) {
            throw new Error('Scanned PDFs are not supported');
        }
    }

    // Check if pdf is encrypted
    if (pdf._pdfInfo && pdf._pdfInfo.encrypt) {
        throw new Error('Encrypted PDFs are not supported');
    }

    // Check if pdf is password protected
    if (pdf._passwordNeeded) {
        throw new Error('Password protected PDFs are not supported');
    }

    let finalText = '';
    let ocrNeeded = true;

    for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const operatorList = await page.getOperatorList();

        // Check if there are any fonts used in the PDF
        if (operatorList.fnArray.some((fn) => fn === pdfjsLib.OPS.setFont)) {
            ocrNeeded = false;
        }

        const textContent = await page.getTextContent();
        const strings = textContent.items.map((item) => item.str);
        finalText += strings.join(' ') + '\n';
    }

    if (ocrNeeded) {
        throw new Error('OCR might be needed for this document!');
    }

    return finalText.trim();
}

export async function csvToText(filePath) {
    const chunks = [];
    for await (const chunk of createReadStream(filePath, {
        highWaterMark: 64 * 1024,
    })) {
        chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf-8');
    const results = Papa.parse(text);
    let finalText = '';

    results.data.forEach((row) => {
        finalText += row.join(' ') + '\n';
    });

    return finalText;
}

export async function documentToText(filePath) {
    const fileExtension = filePath.split('.').pop();

    switch (fileExtension) {
        case 'pdf':
            return pdfToText(filePath);
        case 'txt':
        case 'html':
            return txtToText(filePath);
        case 'docx':
        case 'doc':
            return docxToText(filePath);
        case 'xlsx':
        case 'xls':
            return xlsxToText(filePath);
        case 'csv':
            return csvToText(filePath);
        default:
            throw new Error(`Unsupported file type: ${fileExtension}`);
    }
}

export async function xlsxToCsv(filePath) {
    const workbook = XLSX.readFile(filePath, { type: 'buffer' });
    const outputPath = filePath.replace(/\.[^/.]+$/, '.csv');
    let csvContent = '';

    // Process each sheet
    workbook.SheetNames.forEach((sheetName) => {
        const sheet = workbook.Sheets[sheetName];
        const csv = XLSX.utils.sheet_to_csv(sheet);
        csvContent += `Sheet: ${sheetName}\n${csv}\n\n`;
    });

    // Write to CSV file
    await fs.writeFile(outputPath, csvContent, 'utf-8');
    return outputPath;
}

export function easyChunker(text) {
    const result = [];
    const n = 10000;

    // If the text is less than n characters, just process it as is
    if (text.length <= n) {
        return [text];
    }

    let startIndex = 0;
    while (startIndex < text.length) {
        let endIndex = Math.min(startIndex + n, text.length);

        // Make sure we don't split in the middle of a sentence
        while (
            endIndex > startIndex &&
      text[endIndex] !== '.' &&
      text[endIndex] !== ' '
        ) {
            endIndex--;
        }

        // If we didn't find a sentence break, just split at n characters
        if (endIndex === startIndex) {
            endIndex = startIndex + n;
        }

        // Push the chunk to the result array
        result.push(text.substring(startIndex, endIndex));

        // Move the start index to the next chunk
        startIndex = endIndex;
    }

    return result;
}
