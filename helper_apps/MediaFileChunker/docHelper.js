import pdfjsLib from 'pdfjs-dist';
import fs from 'fs/promises';
import mammoth from 'mammoth';
import XLSX from 'xlsx';
import Papa from 'papaparse';

export async function txtToText(filePath) {
    const text = await fs.readFile(filePath, 'utf-8');
    return text;
}

export async function docxToText(filePath) {
    const buffer = await fs.readFile(filePath);
    const result = await mammoth.extractRawText({ buffer: buffer });
    return result.value;
}

export async function xlsxToText(filePath) {
    const workbook = XLSX.readFile(filePath);
    let finalText = '';

    workbook.SheetNames.forEach(sheetName => {
        const sheet = workbook.Sheets[sheetName];
        const sheetAsJson = XLSX.utils.sheet_to_json(sheet, { header: 1 });
        sheetAsJson.forEach(row => {
            finalText += row.join(' ') + '\n';
        });
    });

    return finalText;
}

export async function pdfToText(filePath) {
    const pdf = await pdfjsLib.getDocument(filePath).promise;
    let finalText = '';

    for(let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const textContent = await page.getTextContent();
        const strings = textContent.items.map(item => item.str);
        finalText += strings.join(' ');
    }

    return finalText;
}

export async function csvToText(filePath) {
    const text = await fs.readFile(filePath, 'utf-8');
    const results = Papa.parse(text);
    let finalText = '';

    results.data.forEach(row => {
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
            return txtToText(filePath);
        case 'docx':
            return docxToText(filePath);
        case 'xlsx':
            return xlsxToText(filePath);
        case 'csv':
            return csvToText(filePath);
        default:
            throw new Error(`Unsupported file type: ${fileExtension}`);
    }
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
        while (endIndex > startIndex && text[endIndex] !== '.' && text[endIndex] !== ' ') {
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