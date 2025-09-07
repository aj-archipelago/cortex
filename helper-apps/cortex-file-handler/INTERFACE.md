# Cortex File Handler Interface Documentation

## Overview

The Cortex File Handler is a service that processes files through various operations including uploading, downloading, chunking, and document processing. It supports multiple storage backends (Azure Blob Storage, Google Cloud Storage, and Local File System).

## Request Methods

### POST

- **Purpose**: Upload a file
- **Content-Type**: `multipart/form-data`
- **Parameters**:
  - `hash` (optional): Unique identifier for the file
  - `requestId` (required): Unique identifier for the request
  - File content must be included in the form data
- **Behavior**:
  - Uploads file to primary storage (Azure or Local)
  - If GCS is configured, also uploads to GCS
  - If hash is provided, stores file metadata in Redis
  - Returns upload result with file URLs
- **Response**: Object containing:
  - `url`: Primary storage URL
  - `gcs`: GCS URL (if GCS is configured)
  - `hash`: Hash value (if provided)
  - `message`: Success message
  - `filename`: Original filename
- **Note**: The `save` parameter is not supported in POST requests. To convert and save a document as text, use GET with the `save` parameter.

### GET

- **Purpose**: Process or retrieve files
- **Parameters** (can be in query string or request body):
  - `uri` (required if not using fetch/load/restore): URL of the file to process
    - Requires `requestId` parameter
    - No Redis caching
    - Direct processing based on file type
  - `requestId` (required with `uri`): Unique identifier for the request
  - `save` (optional): If true, saves document as text file
    - When true, converts document to text and saves to primary storage only (Azure or Local)
    - Does not save to GCS
    - Original document is deleted from storage after text conversion
  - `hash` (optional): Unique identifier for the file
  - `checkHash` (optional): Check if hash exists
  - `clearHash` (optional): Remove hash from storage
  - `generateShortLived` (optional): Generate a short-lived URL for an existing hash
    - Requires `hash` parameter
    - Generates a new SAS token with short expiration time
    - Returns a temporary URL for secure sharing
  - `shortLivedMinutes` (optional): Duration in minutes for short-lived URLs (default: 5)
  - `fetch`/`load`/`restore` (optional): URL to fetch remote file (these are aliases - any of the three parameters will trigger the same remote file processing behavior)
    - Does not require `requestId`
    - Uses Redis caching
    - Downloads and validates file first
    - Ensures correct file extension
    - Truncates long filenames
- **Behavior**:
  - For documents (PDF, DOC, etc.):
    - If `save=true`:
      - Converts document to text
      - Saves text file to primary storage (Azure or Local)
      - Deletes original document from storage
      - Does not save to GCS
      - Returns object with primary storage URL
    - If `save=false`:
      - Converts document to text
      - Returns array of text chunks
      - Does not persist any files
  - For media files:
    - Splits into chunks
    - Uploads chunks to primary storage and GCS (if configured)
    - Returns chunk information with offsets
  - For remote files (`fetch`/`load`/`restore`):
    - Downloads file from URL
    - Processes based on file type
    - Returns processed result
    - Caches result in Redis using URL as key
    - Updates Redis timestamp on subsequent requests
    - Truncates filenames longer than 200 characters
    - Ensures correct file extension based on content type
  - For checkHash (`checkHash=true`):
    - Requires valid `hash` parameter
    - Checks if file exists in storage and restores if needed
    - Always generates new SAS token with short expiration (default: 5 minutes)
    - Returns file information with temporary URL and expiration information
    - Updates Redis timestamp

### DELETE

- **Purpose**: Remove files from storage
- **Parameters** (can be in query string or request body):
  - `requestId` (required): Unique identifier for the request
- **Behavior**:
  - Deletes file from primary storage (Azure or Local)
  - Deletes file from GCS if configured
  - Returns deletion result
- **Response**: Array of deleted file URLs

## Storage Configuration

- **Azure**: Enabled if `AZURE_STORAGE_CONNECTION_STRING` is set
- **GCS**: Enabled if `GCP_SERVICE_ACCOUNT_KEY_BASE64` or `GCP_SERVICE_ACCOUNT_KEY` is set
- **Local**: Used as fallback if Azure is not configured

## Response Format

- **Success**:
  - Status: 200
  - Body: Varies by operation (see specific methods above)
- **Error**:
  - Status: 400/404/500
  - Body: Error message string

## Progress Tracking

- Progress updates are published to Redis for each operation
- Progress includes:
  - `progress`: Completion percentage (0-1)
  - `completedCount`: Number of completed steps
  - `totalCount`: Total number of steps
  - `numberOfChunks`: Number of chunks (for media files)
  - `data`: Additional operation data
- Progress updates are published to Redis channel associated with `requestId`

## File Types

- **Documents**: Processed based on `DOC_EXTENSIONS` list
  - Supported extensions:
    - Text: .txt, .json, .csv, .md, .xml, .js, .html, .css
    - Office: .doc, .docx, .xls, .xlsx
  - Document processing limitations:
    - PDFs: Does not support scanned, encrypted, or password-protected PDFs
    - Requires OCR for PDFs without embedded fonts
  - Text chunking:
    - Maximum chunk size: 10,000 characters
    - Chunks are split at sentence boundaries when possible
    - Returns array of text chunks
- **Media**: All other file types, processed through chunking
  - Chunked into smaller pieces for processing
  - Each chunk is stored separately
  - Media chunking behavior:
    - Default chunk duration: 500 seconds
    - Chunks are processed in parallel (3 at a time)
    - Audio is converted to MP3 format (128kbps)
    - Uses 4MB read buffer for file processing
  - Supported media types:
    - Images: .jpg, .jpeg, .png, .webp, .heic, .heif, .pdf
    - Video: .mp4, .mpeg, .mov, .avi, .flv, .mpg, .webm, .wmv, .3gp
    - Audio: .wav, .mp3, .aac, .ogg, .flac, .m4a
  - File download behavior:
    - 30 second timeout for downloads
    - Supports streaming downloads
    - Handles URL encoding/decoding
    - Truncates filenames longer than 200 characters

## Storage Behavior

- **Primary Storage** (Azure or Local):
  - Files are stored with UUID-based names
  - Organized by requestId folders
  - Azure: Uses SAS tokens for access
  - Local: Served via HTTP on configured port
- **GCS** (if configured):
  - Files stored with gs:// protocol URLs
  - Same folder structure as primary storage
  - Only used for media file chunks
- **Redis**:
  - Stores file metadata and URLs
  - Used for caching remote file results
  - Tracks file access timestamps
  - Used for progress tracking

## Cleanup

- Automatic cleanup of inactive files
- Removes files from:
  - Primary storage (Azure/Local)
  - GCS (if configured)
  - Redis file store map
- Cleanup is triggered on each request but only runs if not already in progress
- Temporary files are cleaned up:
  - After 1 hour of inactivity
  - After successful processing
  - On error conditions

## Usage Examples

### Check Hash (Always Returns Short-Lived URL)

```bash
# Check hash with 5-minute short-lived URL (default)
GET /file-handler?hash=abc123&checkHash=true

# Check hash with 10-minute short-lived URL
GET /file-handler?hash=abc123&checkHash=true&shortLivedMinutes=10
```

**Response (always includes short-lived URL):**
```json
{
  "message": "File 'document.pdf' uploaded successfully.",
  "filename": "document.pdf",
  "url": "https://storage.blob.core.windows.net/container/file.pdf?original-sas-token",
  "gcs": "gs://bucket/file.pdf",
  "hash": "abc123",
  "shortLivedUrl": "https://storage.blob.core.windows.net/container/file.pdf?sv=2023-11-03&se=2024-01-15T10%3A15%3A00Z&sr=b&sp=r&sig=...",
  "expiresInMinutes": 5,
  "timestamp": "2024-01-15T10:10:00.000Z",
  "converted": {
    "url": "https://storage.blob.core.windows.net/container/converted.pdf",
    "gcs": "gs://bucket/converted.pdf"
  }
}
```

## Error Handling

- **400 Bad Request**:
  - Missing required parameters
  - Invalid or inaccessible URL
  - Unsupported file type
- **404 Not Found**:
  - File or hash not found
  - File not found in storage
- **500 Internal Server Error**:
  - Processing errors
  - Storage errors
  - Document conversion errors
  - PDF processing errors (scanned, encrypted, password-protected)
- All errors include descriptive message in response body
