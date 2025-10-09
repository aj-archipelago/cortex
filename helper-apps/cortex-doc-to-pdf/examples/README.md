# JavaScript Client Examples

Complete examples showing how to use the Document to PDF Converter from JavaScript.

## Node.js Client

### Installation

```bash
cd examples
npm install
```

### Usage

```javascript
const { convertFileToPDF, convertUriToURL, checkHealth } = require('./nodejs-client');

// Check if service is running
await checkHealth();

// Convert a local file (streaming)
await convertFileToURL(
    'document.docx',
    'output.pdf'
);

// Convert from URI
await convertUriToURL(
    'https://example.com/document.xlsx',
    'output.pdf'
);
```

### Run Example

```bash
npm run example
```

### Features

- ✅ **Streaming upload** - Files are streamed in chunks (memory efficient)
- ✅ **Streaming download** - PDF is streamed directly to file
- ✅ **Progress tracking** - Monitor upload and download progress
- ✅ **Batch conversion** - Convert multiple files efficiently
- ✅ **Error handling** - Comprehensive error handling
- ✅ **Large file support** - Handles files of any size

### API Methods

#### `convertFileToURL(inputPath, outputPath)`
Convert a local file to PDF with streaming.

```javascript
await convertFileToURL('./document.docx', './output.pdf');
```

#### `convertUriToURL(uri, outputPath)`
Convert a document from URL to PDF.

```javascript
await convertUriToURL('https://example.com/file.xlsx', './output.pdf');
```

#### `convertFileWithProgress(inputPath, outputPath)`
Convert with upload/download progress tracking.

```javascript
await convertFileWithProgress('./large-file.docx', './output.pdf');
// Shows: 📤 Upload: 75%
//        📥 Downloaded: 523.45 KB
```

#### `convertMultipleFiles(files, outputDir)`
Batch convert multiple files.

```javascript
await convertMultipleFiles(
    ['file1.docx', 'file2.xlsx', 'file3.pptx'],
    './output'
);
```

#### `checkHealth()`
Check if service is running.

```javascript
const isHealthy = await checkHealth();
```

## Advanced Examples

### TypeScript Example

```typescript
import axios from 'axios';
import * as fs from 'fs';
import FormData from 'form-data';

interface ConversionResult {
    success: boolean;
    outputPath: string;
    error?: string;
}

async function convertFile(
    inputPath: string,
    outputPath: string
): Promise<ConversionResult> {
    try {
        const form = new FormData();
        form.append('file', fs.createReadStream(inputPath));
        
        const response = await axios.post('http://localhost:8080/', form, {
            headers: form.getHeaders(),
            responseType: 'stream',
        });
        
        const writer = fs.createWriteStream(outputPath);
        response.data.pipe(writer);
        
        return new Promise((resolve) => {
            writer.on('finish', () => 
                resolve({ success: true, outputPath })
            );
            writer.on('error', (error) => 
                resolve({ success: false, outputPath, error: error.message })
            );
        });
    } catch (error) {
        return { 
            success: false, 
            outputPath, 
            error: error.message 
        };
    }
}
```

### React Example

```jsx
import React, { useState } from 'react';
import axios from 'axios';

function DocumentConverter() {
    const [file, setFile] = useState(null);
    const [progress, setProgress] = useState(0);
    const [pdfUrl, setPdfUrl] = useState(null);
    
    const handleConvert = async () => {
        if (!file) return;
        
        const formData = new FormData();
        formData.append('file', file);
        
        try {
            const response = await axios.post(
                'http://localhost:8080/',
                formData,
                {
                    responseType: 'blob',
                    onUploadProgress: (e) => {
                        setProgress(Math.round((e.loaded * 100) / e.total));
                    }
                }
            );
            
            const url = URL.createObjectURL(response.data);
            setPdfUrl(url);
        } catch (error) {
            console.error('Conversion failed:', error);
        }
    };
    
    return (
        <div>
            <input 
                type="file" 
                onChange={(e) => setFile(e.target.files[0])}
            />
            <button onClick={handleConvert}>Convert</button>
            {progress > 0 && <progress value={progress} max="100" />}
            {pdfUrl && <a href={pdfUrl} download="output.pdf">Download PDF</a>}
        </div>
    );
}
```

## Service Endpoints

Both Node.js and browser examples support these endpoints:

- **POST /** - Convert file (root path)
- **POST /convert** - Convert file (explicit path)
- **GET /health** - Health check

## Streaming Benefits

### Upload Streaming
- Files are sent in chunks (not loaded entirely in memory)
- Supports large files without memory issues
- Progress can be tracked

### Download Streaming
- PDF is streamed directly to destination
- No intermediate buffering
- Memory efficient
- Can save directly to file (Node.js) or download (browser)

## Error Handling

```javascript
try {
    await convertFileToURL('document.docx', 'output.pdf');
} catch (error) {
    if (error.response) {
        // Server responded with error
        console.error('Server error:', error.response.data);
    } else if (error.request) {
        // No response received
        console.error('No response from server');
    } else {
        // Other errors
        console.error('Error:', error.message);
    }
}
```

## Performance Tips

1. **Use streaming** - Always use `responseType: 'stream'` in Node.js
2. **Batch processing** - Convert multiple files sequentially, not in parallel
3. **Error recovery** - Implement retry logic for failed conversions
4. **Progress feedback** - Show progress to users for better UX
5. **File validation** - Validate file types before upload

## Troubleshooting

### CORS Issues (Browser)
If you get CORS errors in the browser, the server needs to set appropriate headers. For development, you can use a proxy or run the service with CORS enabled.

### Large Files
The service handles large files efficiently with streaming. No special configuration needed!

### Memory Usage
Both upload and download use streaming, so memory usage stays low even with large files.

## License

Part of the Cortex project.
