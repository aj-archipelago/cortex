# MOGRT Handler Service

A service for managing Motion Graphics Templates (MOGRT) files and their preview GIFs with S3 storage integration.

## Table of Contents
- [Setup](#setup)
- [Environment Variables](#environment-variables)
- [API Documentation](#api-documentation)
  - [Upload MOGRT Files](#upload-mogrt-files)
  - [Get Master Manifest](#get-master-manifest)
  - [Get Individual Manifest](#get-individual-manifest)
- [File Structure](#file-structure)
- [Error Handling](#error-handling)

## Setup

1. Install dependencies:
```bash
npm install
```

2. Set up environment variables (see [Environment Variables](#environment-variables) section)

3. Start the server:
```bash
npm start
```

The server will start on port 7072 by default.

## Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `PORT` | Server port | 7072 | No |
| `AWS_REGION` | AWS region for S3 | us-east-1 | No |
| `S3_BUCKET_NAME` | S3 bucket name for file storage | - | Yes |
| `AWS_ACCESS_KEY_ID` | AWS access key | - | Yes |
| `AWS_SECRET_ACCESS_KEY` | AWS secret key | - | Yes |
| `SIGNED_URL_EXPIRY_SECONDS` | Expiration time for signed URLs | 3600 (1 hour) | No |

## API Documentation

### Upload MOGRT Files

Upload a MOGRT file with its preview GIF.

**Endpoint:** `POST /api/MogrtHandler`

**Content-Type:** `multipart/form-data`

**Required Files:**
- A `.mogrt` file
- A `.gif` preview file

**Example Request:**
```bash
curl -X POST http://localhost:7072/api/MogrtHandler \
  -F "mogrt=@/path/to/template.mogrt" \
  -F "preview=@/path/to/preview.gif"
```

**Success Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "mogrtFile": "uploads/550e8400-e29b-41d4-a716-446655440000/template.mogrt",
  "previewFile": "uploads/550e8400-e29b-41d4-a716-446655440000/preview.gif",
  "uploadDate": "2025-02-05T14:05:39Z",
  "mogrtUrl": "https://bucket.s3.amazonaws.com/uploads/550e8400-e29b-41d4-a716-446655440000/template.mogrt?[signed-url-params]",
  "previewUrl": "https://bucket.s3.amazonaws.com/uploads/550e8400-e29b-41d4-a716-446655440000/preview.gif?[signed-url-params]"
}
```

**Error Responses:**
- `400 Bad Request`: Missing required files or invalid file types
- `500 Internal Server Error`: Server or S3 error

### Get Master Manifest

Retrieve a list of all uploaded MOGRT files.

**Endpoint:** `GET /api/MogrtHandler`

**Example Request:**
```bash
curl http://localhost:7072/api/MogrtHandler
```

**Success Response:**
```json
[
  {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "mogrtFile": "uploads/550e8400-e29b-41d4-a716-446655440000/template.mogrt",
    "previewFile": "uploads/550e8400-e29b-41d4-a716-446655440000/preview.gif",
    "uploadDate": "2025-02-05T14:05:39Z",
    "mogrtUrl": "https://bucket.s3.amazonaws.com/uploads/550e8400-e29b-41d4-a716-446655440000/template.mogrt?[signed-url-params]",
    "previewUrl": "https://bucket.s3.amazonaws.com/uploads/550e8400-e29b-41d4-a716-446655440000/preview.gif?[signed-url-params]"
  }
]
```

**Error Response:**
- `500 Internal Server Error`: Server or S3 error

### Get Individual Manifest

Retrieve information about a specific MOGRT upload.

**Endpoint:** `GET /api/MogrtHandler?manifestId=<uuid>`

**Parameters:**
- `manifestId` (required): UUID of the upload

**Example Request:**
```bash
curl http://localhost:7072/api/MogrtHandler?manifestId=550e8400-e29b-41d4-a716-446655440000
```

**Success Response:**
```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "mogrtFile": "uploads/550e8400-e29b-41d4-a716-446655440000/template.mogrt",
  "previewFile": "uploads/550e8400-e29b-41d4-a716-446655440000/preview.gif",
  "uploadDate": "2025-02-05T14:05:39Z",
  "mogrtUrl": "https://bucket.s3.amazonaws.com/uploads/550e8400-e29b-41d4-a716-446655440000/template.mogrt?[signed-url-params]",
  "previewUrl": "https://bucket.s3.amazonaws.com/uploads/550e8400-e29b-41d4-a716-446655440000/preview.gif?[signed-url-params]"
}
```

**Error Responses:**
- `404 Not Found`: Manifest not found
- `500 Internal Server Error`: Server or S3 error

## File Structure

Files are organized in S3 with the following structure:

```
bucket/
├── master-manifest.json
└── uploads/
    └── <uuid>/
        ├── template.mogrt
        ├── preview.gif
        └── manifest.json
```

## Error Handling

All endpoints return errors in the following format:

```json
{
  "error": "Error message description"
}
```

Common error scenarios:
1. Missing required files in upload
2. Invalid file types (only .mogrt and .gif allowed)
3. S3 access or permission issues
4. Missing or invalid manifest ID
5. Server configuration errors (missing environment variables)
