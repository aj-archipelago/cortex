# Document to PDF Converter - Azure Container App

A comprehensive document-to-PDF conversion service that runs as both an Azure Function and a standalone HTTP server. Built with LibreOffice, it supports **40+ document formats** including Word, Excel, PowerPoint, text files, HTML, and more.

## Quick Start

### Using Docker Compose (Easiest)

```bash
# Build and start the service
docker compose up --build -d

# Test the service
curl "http://localhost:8080/convert?uri=https://file-examples.com/storage/fe783f04fc66761fd44fb46/2017/02/file-sample_100kB.doc" -o test.pdf

# Check health
curl http://localhost:8080/health

# View logs
docker compose logs -f

# Stop the service
docker compose down
```

## Supported Formats

### Microsoft Office
- **Word**: `.doc`, `.docx`, `.docm`, `.dot`, `.dotx`, `.dotm`
- **Excel**: `.xls`, `.xlsx`, `.xlsm`, `.xlt`, `.xltx`, `.xltm`, `.csv`
- **PowerPoint**: `.ppt`, `.pptx`, `.pptm`, `.pot`, `.potx`, `.potm`, `.pps`, `.ppsx`, `.ppsm`

### OpenDocument
- **Text**: `.odt`, `.ott`
- **Spreadsheet**: `.ods`, `.ots`
- **Presentation**: `.odp`, `.otp`
- **Graphics**: `.odg`, `.otg`

### Web & Text
- **Web**: `.html`, `.htm`, `.xhtml`
- **Text**: `.txt`, `.rtf`, `.xml`

### Legacy Formats
- WordPerfect, Lotus 1-2-3, dBase files, and more

## API Usage

### Endpoints

**Standalone Server Mode** (Docker):
- `GET/POST /convert` - Convert document to PDF
- `GET /health` - Health check

**Azure Function Mode**:
- `GET/POST /api/convert` - Convert document to PDF

### Convert Document

```bash
# GET request
curl "http://localhost:8080/convert?uri=https://example.com/document.docx" -o output.pdf

# POST request
curl -X POST http://localhost:8080/convert \
  -H "Content-Type: application/json" \
  -d '{"uri": "https://example.com/document.xlsx"}' \
  -o output.pdf
```

### Response

**Success (200)**:
- Content-Type: `application/pdf`
- Body: PDF binary data

**Error (400/500)**:
```json
{
  "error": "Error type",
  "details": "Error details"
}
```

## Testing

### Run Tests

```bash
# Run conversion tests
python3 tests/test_conversion.py

# Run streaming tests
python3 tests/test_streaming.py

# Or run in Docker
docker compose run --rm doc-to-pdf python3 tests/test_streaming.py
```

Tests verify:
- ✅ File upload streaming (memory efficient)
- ✅ URI-based conversion
- ✅ Streaming downloads
- ✅ Concurrent conversions
- ✅ Error handling
- ✅ All document formats

Sample files are in the `samples/` directory.

## Deployment

### Azure Container Apps (Recommended)

```bash
# Create resources
az group create --name cortex-rg --location eastus
az acr create --resource-group cortex-rg --name cortexregistry --sku Basic

# Build and push
az acr build --registry cortexregistry --image cortex-doc-to-pdf:latest .

# Create container app environment
az containerapp env create \
  --name cortex-env \
  --resource-group cortex-rg \
  --location eastus

# Deploy
az containerapp create \
  --name cortex-doc-to-pdf \
  --resource-group cortex-rg \
  --environment cortex-env \
  --image cortexregistry.azurecr.io/cortex-doc-to-pdf:latest \
  --target-port 8080 \
  --ingress external \
  --min-replicas 1 \
  --max-replicas 10 \
  --cpu 1.0 \
  --memory 2.0Gi \
  --env-vars PORT=8080 \
  --command python function_app.py
```

### Azure Function App

```bash
# Create Function App
az functionapp create \
  --resource-group cortex-rg \
  --name cortex-doc-to-pdf-func \
  --storage-account cortexstorage \
  --runtime python \
  --runtime-version 3.11 \
  --functions-version 4 \
  --os-type Linux

# Deploy
func azure functionapp publish cortex-doc-to-pdf-func
```

## Local Development

### With Docker (Recommended)

```bash
# Start with auto-reload
docker compose up

# Rebuild after code changes
docker compose up --build
```

### Without Docker

```bash
# Install LibreOffice
# macOS: brew install --cask libreoffice
# Ubuntu: sudo apt-get install libreoffice

# Install dependencies
pip install -r requirements.txt

# Run server
python function_app.py
```

## Configuration

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | HTTP server port | `8080` |
| `AzureWebJobsStorage` | Azure Storage (Function mode) | - |
| `FUNCTIONS_WORKER_RUNTIME` | Azure Functions runtime | `python` |

### Conversion Timeout

Adjust in `host.json`:
```json
{
  "functionTimeout": "00:10:00"
}
```

## Performance

### Typical Conversion Times
- Simple documents: 1-3 seconds
- Complex documents: 3-10 seconds
- Large presentations: 10-30 seconds

### Resource Requirements
- **CPU**: 1.0 vCPU minimum
- **Memory**: 2.0 GB minimum  
- **Disk**: Ephemeral storage

## Troubleshooting

### Docker Build Issues

**Platform mismatch error** (Apple Silicon Macs):
```bash
# Already configured in docker-compose.yml
platform: linux/amd64
```

**Disk space error**:
```bash
docker system prune -a -f
```

### Conversion Failures

**Check logs**:
```bash
docker compose logs -f
```

**Test with known-good file**:
```bash
curl "http://localhost:8080/convert?uri=https://file-examples.com/storage/fe783f04fc66761fd44fb46/2017/02/file-sample_100kB.doc" -o test.pdf
```

## Project Structure

```
cortex-doc-to-pdf/
├── function_app.py          # Main entry point & routing
├── request_handlers.py      # HTTP request/response handling
├── document_converter.py    # Conversion business logic
├── converter.py             # LibreOffice wrapper
├── tests/                   # Test suite
│   ├── test_streaming.py   # Streaming tests
│   ├── test_conversion.py  # Conversion tests
│   └── run_tests.sh        # Test runner
├── samples/                 # Sample documents
├── Dockerfile              # Container image
├── docker-compose.yml      # Local orchestration
├── requirements.txt        # Dependencies
└── README.md              # Documentation
```

## Examples

### URI-Based Conversion

```bash
# Word document via URI
curl -X POST http://localhost:8080/convert \
  -H "Content-Type: application/json" \
  -d '{"uri": "https://example.com/document.docx"}' \
  -o output.pdf

# Or with GET (URL-encode special characters)
curl "http://localhost:8080/convert?uri=https://example.com/file.xlsx" -o output.pdf
```

### File Upload (Recommended - Streaming)

Upload local files directly - **no need for remote URI**. Files are streamed in 8KB chunks for memory efficiency.

```bash
# Upload file directly (streams upload & download)
curl -X POST http://localhost:8080/convert \
  -F "file=@document.xlsx" \
  -o output.pdf

# Works with any supported format
curl -X POST http://localhost:8080/convert \
  -F "file=@presentation.pptx" \
  -o slides.pdf

# Large files are handled efficiently (no memory bloat)
curl -X POST http://localhost:8080/convert \
  -F "file=@large-spreadsheet.xlsx" \
  -o output.pdf
```

**Why file upload is recommended:**
- ✅ **Streaming**: Chunked upload (8KB) and download
- ✅ **Memory efficient**: Handles large files without RAM bloat
- ✅ **Direct**: No need to host files on a server first
- ✅ **Fast**: No download step required

### JavaScript/Node.js Example

**See `examples/` folder for complete working examples!**

```javascript
const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

// Upload file with streaming (both upload & download)
async function convertToPDF(inputFile, outputFile) {
    const form = new FormData();
    form.append('file', fs.createReadStream(inputFile));
    
    const response = await axios({
        method: 'POST',
        url: 'http://localhost:8080/',  // Can use / or /convert
        data: form,
        headers: form.getHeaders(),
        responseType: 'stream',  // Stream the response
    });
    
    // Stream PDF to file
    const writer = fs.createWriteStream(outputFile);
    response.data.pipe(writer);
    
    return new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
    });
}

// Usage
await convertToPDF('document.docx', 'output.pdf');
```

**Features:**
- ✅ Streaming upload (memory efficient)
- ✅ Streaming download (direct to file)
- ✅ Progress tracking support
- ✅ Works in Node.js and Browser

**Full example:** See `examples/nodejs-client.js`

### Python Example

```python
import requests

# Method 1: Upload local file (Recommended - Streaming)
def convert_file_to_pdf(file_path):
    with open(file_path, 'rb') as f:
        files = {'file': f}
        response = requests.post(
            'http://localhost:8080/convert',
            files=files
        )
    
    if response.status_code == 200:
        with open('output.pdf', 'wb') as f:
            f.write(response.content)
        print('✓ PDF created successfully')
    else:
        print(f'✗ Error: {response.json()}')

# Method 2: Convert from URI
def convert_url_to_pdf(document_url):
    response = requests.post(
        'http://localhost:8080/convert',
        json={'uri': document_url}
    )
    
    if response.status_code == 200:
        with open('output.pdf', 'wb') as f:
            f.write(response.content)
        print('✓ PDF created successfully')
    else:
        print(f'✗ Error: {response.json()}')

# Upload local file (streams efficiently)
convert_file_to_pdf('document.docx')

# Or convert from URL
convert_url_to_pdf('https://example.com/document.docx')
```

## Security Considerations

- **Authentication**: Add API keys or OAuth for production
- **Rate Limiting**: Implement at API gateway level
- **Input Validation**: URI format and allowlisting
- **HTTPS**: Use reverse proxy or Azure ingress
- **Resource Limits**: Configure memory and CPU limits

## License

This project is part of the Cortex project.

## Support

For issues or questions:
1. Check the logs: `docker compose logs -f`
2. Run tests: `./test_in_docker.sh`
3. Verify LibreOffice: `docker compose run --rm --entrypoint soffice doc-to-pdf --version`