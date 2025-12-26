# Cortex File System - Complete Documentation

## Table of Contents
1. [Architecture Overview](#architecture-overview)
2. [File Handler Service](#file-handler-service)
3. [Cortex File Utilities Layer](#cortex-file-utilities-layer)
4. [File Collection System](#file-collection-system)
5. [Tools Integration](#tools-integration)
6. [Data Flow Diagrams](#data-flow-diagrams)
7. [Storage Layers](#storage-layers)
8. [Key Concepts](#key-concepts)
9. [Complete Function Reference](#complete-function-reference)
10. [Error Handling](#error-handling)

---

## Architecture Overview

The Cortex file system is a multi-layered architecture that handles file uploads, storage, retrieval, and management:

```
┌─────────────────────────────────────────────────────────────┐
│                    Cortex Application                        │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │         System Tools & Plugins                       │   │
│  │  (WriteFile, EditFile, Image, FileCollection, etc.)  │   │
│  └──────────────────┬─────────────────────────────────┘   │
│                      │                                       │
│  ┌───────────────────▼─────────────────────────────────┐   │
│  │         lib/fileUtils.js                             │   │
│  │  (Encapsulated file handler interactions)            │   │
│  └───────────────────┬─────────────────────────────────┘   │
│                      │                                       │
│  ┌───────────────────▼─────────────────────────────────┐   │
│  │         File Collection System                       │   │
│  │  (Redis hash maps: FileStoreMap:ctx:<contextId>)    │   │
│  └───────────────────┬─────────────────────────────────┘   │
└───────────────────────┼───────────────────────────────────────┘
                        │
                        │ HTTP/HTTPS
                        │
┌───────────────────────▼───────────────────────────────────────┐
│         Cortex File Handler Service                           │
│  (External Azure Function - cortex-file-handler)              │
│                                                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐       │
│  │   Azure Blob │  │   GCS        │  │    Redis     │       │
│  │   Storage    │  │   Storage    │  │   Metadata   │       │
│  └──────────────┘  └──────────────┘  └──────────────┘       │
└────────────────────────────────────────────────────────────────┘
```

### Key Components

1. **File Handler Service** (`cortex-file-handler`): External Azure Function that handles actual file storage
2. **File Utilities** (`lib/fileUtils.js`): Cortex's abstraction layer over the file handler
3. **File Collection System**: Redis-based metadata storage for user file collections
4. **System Tools**: Pathways that use files (WriteFile, EditFile, Image, etc.)

---

## File Handler Service

The file handler is an external Azure Function service that manages file storage and processing.

### Configuration
- **URL**: Configured via `WHISPER_MEDIA_API_URL` environment variable
- **Storage Backends**: Azure Blob Storage (primary), Google Cloud Storage (optional), Local (fallback)

### Key Features

#### 1. Single Container Architecture
- All files stored in a single Azure Blob Storage container
- Files distinguished by blob index tags, not separate containers
- No `container` parameter supported - always uses configured container

#### 2. Retention Management
- **Temporary** (default): Files tagged with `retention=temporary`, auto-deleted after 30 days
- **Permanent**: Files tagged with `retention=permanent`, retained indefinitely
- Retention changed via `setRetention` operation (updates blob tag, no file copying)

#### 3. Context Scoping
- **`contextId`**: Optional parameter for per-user/per-context file isolation
- Redis keys: `<hash>:ctx:<contextId>` for context-scoped files
- Falls back to unscoped keys if context-scoped not found
- **Strongly recommended** for multi-tenant applications

#### 4. Hash-Based Deduplication
- Files identified by xxhash64 hash
- Duplicate uploads return existing file URLs
- Hash stored in Redis for fast lookups

#### 5. Short-Lived URLs
- All operations return `shortLivedUrl` (5-minute expiration, configurable)
- Provides secure, time-limited access
- Preferred for LLM file access

### API Endpoints

#### POST `/file-handler` - Upload File
```javascript
// FormData:
{
  file: <FileStream>,
  hash: "abc123",           // Optional: for deduplication
  contextId: "user-456",    // Optional: for scoping
  requestId: "req-789"      // Optional: for tracking
}

// Response:
{
  url: "https://storage.../file.pdf?long-lived-sas",
  shortLivedUrl: "https://storage.../file.pdf?short-lived-sas",
  gcs: "gs://bucket/file.pdf",  // If GCS configured
  hash: "abc123",
  filename: "file.pdf"
}
```

#### GET `/file-handler` - Retrieve/Process File
```javascript
// Query Parameters:
{
  hash: "abc123",                    // Check if file exists
  checkHash: true,                    // Enable hash check
  contextId: "user-456",              // Optional: for scoping
  shortLivedMinutes: 5,               // Optional: URL expiration
  fetch: "https://example.com/file",  // Download from URL
  save: true                          // Save converted document
}

// Response (checkHash):
{
  url: "https://storage.../file.pdf",
  shortLivedUrl: "https://storage.../file.pdf?short-lived",
  gcs: "gs://bucket/file.pdf",
  hash: "abc123",
  filename: "file.pdf",
  converted: {                        // If file was converted
    url: "https://storage.../converted.csv",
    gcs: "gs://bucket/converted.csv"
  }
}
```

#### DELETE `/file-handler` - Delete File
```javascript
// Query Parameters:
{
  hash: "abc123",           // Delete by hash
  contextId: "user-456",    // Optional: for scoping
  requestId: "req-789"      // Or delete all files for requestId
}
```

#### POST/PUT `/file-handler` - Set Retention
```javascript
// Body:
{
  hash: "abc123",
  retention: "permanent",   // or "temporary"
  contextId: "user-456",   // Optional: for scoping
  setRetention: true
}

// Response:
{
  hash: "abc123",
  filename: "file.pdf",
  retention: "permanent",
  url: "https://storage.../file.pdf",  // Same URL (tag updated)
  shortLivedUrl: "https://storage.../file.pdf?new-sas",
  gcs: "gs://bucket/file.pdf"
}
```

---

## Cortex File Utilities Layer

**Location**: `lib/fileUtils.js`

This is Cortex's abstraction layer that encapsulates all file handler interactions. **No direct axios calls to the file handler should exist** - all go through these functions.

### Core Functions

#### URL Building
```javascript
buildFileHandlerUrl(baseUrl, params)
```
- Handles separator detection (`?` vs `&`)
- Properly encodes all parameters
- Skips null/undefined/empty values
- **Used by all file handler operations**

#### File Upload
```javascript
uploadFileToCloud(fileInput, mimeType, filename, pathwayResolver, contextId)
```
- **Input Types**: URL string, base64 string, or Buffer
- **Process**:
  1. Converts input to Buffer
  2. Computes xxhash64 hash
  3. Checks if file exists via `checkHashExists` (deduplication)
  4. If exists, returns existing URLs
  5. If not, uploads via file handler POST
- **Returns**: `{url, gcs, hash}`
- **ContextId**: Passed in formData body (not URL)

#### File Retrieval
```javascript
checkHashExists(hash, fileHandlerUrl, pathwayResolver, contextId, shortLivedMinutes)
```
- Checks if file exists by hash
- Returns short-lived URL (prefers converted version)
- **Returns**: `{url, gcs, hash, filename}` or `null`
- Makes single API call (optimized)

```javascript
fetchFileFromUrl(fileUrl, requestId, contextId, save)
```
- Downloads file from URL via file handler
- Processes based on file type
- **Used by**: `azureVideoTranslatePlugin`, `azureCognitivePlugin`

#### File Deletion
```javascript
deleteFileByHash(hash, pathwayResolver, contextId)
```
- Deletes file from cloud storage
- Handles 404 gracefully (file already deleted)
- **Returns**: `true` if deleted, `false` if not found

#### Retention Management
```javascript
setRetentionForHash(hash, retention, contextId, pathwayResolver)
```
- Sets file retention to `'temporary'` or `'permanent'`
- Best-effort operation (logs warnings on failure)
- **Used by**: `addFileToCollection` when `permanent=true`

#### Short-Lived URL Resolution
```javascript
ensureShortLivedUrl(fileObject, fileHandlerUrl, contextId, shortLivedMinutes)
```
- Resolves file object to use short-lived URL
- Updates GCS URL if converted version exists
- **Used by**: Tools that send files to LLMs

#### Media Chunks
```javascript
getMediaChunks(file, requestId, contextId)
```
- Gets chunked media file URLs
- **Used by**: Media processing workflows

#### Cleanup
```javascript
markCompletedForCleanUp(requestId, contextId)
```
- Marks request as completed for cleanup
- **Used by**: `azureCognitivePlugin`

---

## File Collection System

**Location**: `lib/fileUtils.js` + `pathways/system/entity/tools/sys_tool_file_collection.js`

The file collection system stores file metadata in Redis hash maps using atomic operations for concurrent safety. Files are stored directly in Redis hash maps keyed by hash, with context-scoped isolation.

### Storage Architecture

```
Redis Hash Maps
└── FileStoreMap:ctx:<contextId>
    └── Hash Map (hash → fileData JSON)
        └── File Entry (JSON):
            {
              // CFH-managed fields (preserved from file handler)
              url: "https://storage.../file.pdf",
              gcs: "gs://bucket/file.pdf",
              filename: "uuid-based-filename.pdf",  // CFH-managed
              
              // Cortex-managed fields (user metadata)
              id: "timestamp-random",
              displayFilename: "user-friendly-name.pdf",  // User-provided name
              mimeType: "application/pdf",
              tags: ["pdf", "report"],
              notes: "Quarterly report",
              hash: "abc123",
              permanent: true,
              addedDate: "2024-01-15T10:00:00.000Z",
              lastAccessed: "2024-01-15T10:00:00.000Z"
            }
```

### Key Features

#### 1. Atomic Operations
- Uses Redis hash map operations (HSET, HGET, HDEL) which are atomic
- No version-based locking needed - Redis operations are thread-safe
- Direct hash map access: `FileStoreMap:ctx:<contextId>` → `{hash: fileData}`

#### 2. Caching
- In-memory cache with 5-second TTL
- Reduces Redis load for read operations
- Cache invalidated on writes

#### 3. Field Ownership
- **CFH-managed fields**: `url`, `gcs`, `filename` (UUID-based, managed by file handler)
- **Cortex-managed fields**: `id`, `displayFilename`, `tags`, `notes`, `mimeType`, `permanent`, `addedDate`, `lastAccessed`
- When merging data, CFH fields are preserved, Cortex fields are updated

### Core Functions

#### Loading
```javascript
loadFileCollection(contextId, contextKey, useCache)
```
- Loads collection from Redis hash map `FileStoreMap:ctx:<contextId>`
- Returns array of file entries (sorted by lastAccessed, most recent first)
- Uses cache if available and fresh (5-second TTL)
- Converts hash map entries to array format

#### Saving
```javascript
saveFileCollection(contextId, contextKey, collection)
```
- Saves collection to Redis hash map (only updates changed entries)
- Uses atomic HSET operations per file
- Optimized to only write files that actually changed
- Returns `true` if successful, `false` on error

#### Metadata Updates
```javascript
updateFileMetadata(contextId, hash, metadata)
```
- Updates Cortex-managed metadata fields atomically
- Preserves all CFH-managed fields
- Updates only specified fields (displayFilename, tags, notes, mimeType, dates, permanent)
- **Used for**: Updating lastAccessed, modifying tags/notes without full reload

#### Adding Files
```javascript
addFileToCollection(contextId, contextKey, url, gcs, filename, tags, notes, hash, fileUrl, pathwayResolver, permanent)
```
- Adds file entry to collection via atomic HSET operation
- If `fileUrl` provided, uploads file first via `uploadFileToCloud()`
- If `permanent=true`, sets retention to permanent via `setRetentionForHash()`
- Merges with existing CFH data if file with same hash already exists
- Returns file entry object with `id`

#### Processing Chat History Files
```javascript
syncAndStripFilesFromChatHistory(chatHistory, contextId, contextKey)
```
- Files IN collection: stripped from message (replaced with placeholder), tools can access them
- Files NOT in collection: left in message as-is (model sees them directly)
- Updates lastAccessed for collection files
- **Used by**: `sys_entity_agent` to process incoming chat history

### File Entry Schema

```javascript
{
  id: string,                    // Unique ID: "timestamp-random" (Cortex-managed)
  url: string,                   // Azure Blob Storage URL (CFH-managed)
  gcs: string | null,            // Google Cloud Storage URL (CFH-managed)
  filename: string | null,       // CFH-managed filename (UUID-based) (CFH-managed)
  displayFilename: string | null, // User-friendly filename (Cortex-managed)
  mimeType: string | null,      // MIME type (Cortex-managed)
  tags: string[],               // Searchable tags (Cortex-managed)
  notes: string,                // User notes/description (Cortex-managed)
  hash: string,                 // File hash for deduplication (used as Redis key)
  permanent: boolean,           // Whether file is permanent (Cortex-managed)
  addedDate: string,            // ISO timestamp when added (Cortex-managed)
  lastAccessed: string          // ISO timestamp of last access (Cortex-managed)
}
```

**Field Ownership Notes**:
- `filename`: Managed by CFH, UUID-based storage filename
- `displayFilename`: Managed by Cortex, user-provided friendly name
- When displaying files, prefer `displayFilename` with fallback to `filename`

---

## Tools Integration

### System Tools That Use Files

#### 1. WriteFile (`sys_tool_writefile.js`)
**Flow**:
1. User provides content and filename
2. Creates Buffer from content
3. Calls `uploadFileToCloud()` with `contextId`
4. Calls `addFileToCollection()` with `permanent=true`
5. Returns file info with `fileId`

**Key Code**:
```javascript
const uploadResult = await uploadFileToCloud(
    fileBuffer, mimeType, filename, resolver, contextId
);
const fileEntry = await addFileToCollection(
    contextId, contextKey, uploadResult.url, uploadResult.gcs,
    filename, tags, notes, uploadResult.hash, null, resolver, true
);
```

#### 2. EditFile (`sys_tool_editfile.js`)
**Flow**:
1. User provides file identifier and modification
2. Resolves file via `resolveFileParameter()` → finds in collection
3. Downloads file content via `axios.get(file.url)`
4. Modifies content (line replacement or search/replace)
5. Uploads modified file via `uploadFileToCloud()` (creates new hash)
6. Updates collection entry atomically via `updateFileMetadata()` with new URL/hash
7. Deletes old file version (if not permanent) via `deleteFileByHash()`

**Key Code**:
```javascript
const foundFile = await resolveFileParameter(fileParam, contextId, contextKey);
const oldHash = foundFile.hash;
const uploadResult = await uploadFileToCloud(
    fileBuffer, mimeType, filename, resolver, contextId
);
// Update file entry atomically (preserves CFH data, updates Cortex metadata)
await updateFileMetadata(contextId, foundFile.hash, {
    url: uploadResult.url,
    gcs: uploadResult.gcs,
    hash: uploadResult.hash
});
if (!foundFile.permanent) {
    await deleteFileByHash(oldHash, resolver, contextId);
}
```

#### 3. FileCollection (`sys_tool_file_collection.js`)
**Tools**:
- `AddFileToCollection`: Adds file to collection (with optional upload)
- `SearchFileCollection`: Searches files by filename, tags, notes
- `ListFileCollection`: Lists all files with filtering/sorting
- `RemoveFileFromCollection`: Removes files (deletes from cloud if not permanent)

**Key Code**:
```javascript
// Add file
await addFileToCollection(contextId, contextKey, url, gcs, filename, tags, notes, hash, fileUrl, resolver, permanent);

// Remove file (with permanent check)
if (!fileInfo.permanent) {
    await deleteFileByHash(fileInfo.hash, resolver, contextId);
}
```

#### 4. Image Tools (`sys_tool_image.js`, `sys_tool_image_gemini.js`)
**Flow**:
1. Generates/modifies image
2. Gets image URL
3. Uploads via `uploadFileToCloud()`
4. Adds to collection with `permanent=true`

#### 5. ReadFile (`sys_tool_readfile.js`)
**Flow**:
1. Resolves file via `resolveFileParameter()` → finds in collection
2. Downloads file content via `axios.get(file.url)`
3. Validates file is text-based via `isTextMimeType()`
4. Returns content with line/character range support

#### 6. ViewImage (`sys_tool_view_image.js`)
**Flow**:
1. Finds file in collection
2. Resolves to short-lived URL via `ensureShortLivedUrl()`
3. Returns image URL for display

#### 7. AnalyzeFile (`sys_tool_analyzefile.js`)
**Flow**:
1. Extracts files from chat history via `extractFilesFromChatHistory()`
2. Generates file message content via `generateFileMessageContent()`
3. Injects files into chat history via `injectFileIntoChatHistory()`
4. Uses Gemini Vision model to analyze files

### Plugins That Use Files

#### 1. AzureVideoTranslatePlugin
**Flow**:
1. Receives video URL
2. If not from Azure storage, uploads via `fetchFileFromUrl()`
3. Uses uploaded URL for video translation

**Key Code**:
```javascript
const response = await fetchFileFromUrl(videoUrl, this.requestId, contextId, false);
const resultUrl = Array.isArray(response) ? response[0] : response.url;
```

#### 2. AzureCognitivePlugin
**Flow**:
1. Receives file for indexing
2. If not text file, converts via `fetchFileFromUrl()` with `save=true`
3. Uses converted text file for indexing
4. Marks completed via `markCompletedForCleanUp()`

**Key Code**:
```javascript
const data = await fetchFileFromUrl(file, requestId, contextId, true);
url = Array.isArray(data) ? data[0] : data.url;
```

---

## Data Flow Diagrams

### File Upload Flow

```
User/LLM Request
    │
    ▼
System Tool (WriteFile, Image, etc.)
    │
    ▼
uploadFileToCloud()
    │
    ├─► Convert input to Buffer
    ├─► Compute xxhash64 hash
    ├─► checkHashExists() ──► File Handler GET /file-handler?checkHash=true
    │                           │
    │                           ├─► File exists? ──► Return existing URLs
    │                           │
    │                           └─► File not found ──► Continue
    │
    └─► Upload via POST ──► File Handler POST /file-handler
        │                      │
        │                      ├─► Store in Azure Blob Storage
        │                      ├─► Store in GCS (if configured)
        │                      ├─► Store metadata in Redis
        │                      └─► Return {url, gcs, hash, shortLivedUrl}
        │
        └─► addFileToCollection()
            │
            ├─► If permanent=true ──► setRetentionForHash() ──► File Handler POST /file-handler?setRetention=true
            │
            └─► Save to Redis hash map (atomic operation)
                │
                └─► Redis HSET FileStoreMap:ctx:<contextId> <hash> <fileData>
                    │
                    ├─► Merge with existing CFH data (if hash exists)
                    ├─► Preserve CFH fields (url, gcs, filename)
                    └─► Update Cortex fields (displayFilename, tags, notes, etc.)
```

### File Retrieval Flow

```
User/LLM Request (e.g., "view file.pdf")
    │
    ▼
System Tool (ViewImage, ReadFile, etc.)
    │
    ▼
resolveFileParameter()
    │
    ├─► Find in collection via findFileInCollection()
    │   │
    │   └─► Matches by: ID, filename, hash, URL, or fuzzy filename
    │
    └─► ensureShortLivedUrl()
        │
        └─► checkHashExists() ──► File Handler GET /file-handler?checkHash=true&shortLivedMinutes=5
            │                      │
            │                      ├─► Check Redis for hash metadata
            │                      ├─► Generate short-lived SAS token
            │                      └─► Return {url, gcs, hash, filename, shortLivedUrl}
            │
            └─► Return file object with shortLivedUrl
```

### File Edit Flow

```
User/LLM Request (e.g., "edit file.txt, replace line 5")
    │
    ▼
EditFile Tool
    │
    ├─► resolveFileParameter() ──► Find file in collection
    │
    ├─► Download file content ──► axios.get(file.url)
    │
    ├─► Modify content (line replacement or search/replace)
    │
    ├─► uploadFileToCloud() ──► Upload modified file
    │   │
    │   └─► Returns new {url, gcs, hash}
    │
    └─► updateFileMetadata() ──► Redis HSET (atomic update)
        │
        ├─► Preserve CFH fields (url, gcs, filename)
        ├─► Update Cortex fields (url, gcs, hash)
        └─► If update succeeds:
            └─► Delete old file (if not permanent)
                └─► deleteFileByHash() ──► File Handler DELETE /file-handler?hash=oldHash
```

### File Deletion Flow

```
User/LLM Request (e.g., "remove file.pdf from collection")
    │
    ▼
RemoveFileFromCollection Tool
    │
    ├─► Load collection ──► findFileInCollection() for each fileId
    │
    ├─► Capture file info (hash, permanent) from collection
    │
    └─► Redis HDEL FileStoreMap:ctx:<contextId> <hash> (atomic deletion)
        │
        └─► Async deletion (fire and forget)
            │
            ├─► For each file:
            │   │
            │   ├─► If permanent=true ──► Skip deletion (keep in cloud)
            │   │
            │   └─► If permanent=false ──► deleteFileByHash()
            │       │
            │       └─► File Handler DELETE /file-handler?hash=hash&contextId=contextId
            │           │
            │           ├─► Delete from Azure Blob Storage
            │           ├─► Delete from GCS (if configured)
            │           └─► Remove from Redis metadata
```

---

## Storage Layers

### Layer 1: Cloud Storage (File Handler)

#### Azure Blob Storage (Primary)
- **Container**: Single container (configured via `AZURE_STORAGE_CONTAINER_NAME`)
- **Naming**: UUID-based filenames
- **Organization**: By `requestId` folders
- **Access**: SAS tokens (long-lived and short-lived)
- **Tags**: Blob index tags for retention (`retention=temporary` or `retention=permanent`)
- **Lifecycle**: Azure automatically deletes `retention=temporary` files after 30 days

#### Google Cloud Storage (Optional)
- **Enabled**: If `GCP_SERVICE_ACCOUNT_KEY` configured
- **URL Format**: `gs://bucket/path`
- **Usage**: Media file chunks, converted files
- **No short-lived URLs**: GCS URLs are permanent (no SAS equivalent)

#### Local Storage (Fallback)
- **Used**: If Azure not configured
- **Served**: Via HTTP on configured port

### Layer 2: Redis Metadata (File Handler)

**Purpose**: Fast hash lookups, file metadata caching

**Key Format**:
- Unscoped: `<hash>`
- Context-scoped: `<hash>:ctx:<contextId>`
- Legacy (migrated): `<hash>:<containerName>` (auto-migrated on read)

**Data Stored**:
```javascript
{
  url: "https://storage.../file.pdf?long-lived-sas",
  shortLivedUrl: "https://storage.../file.pdf?short-lived-sas",
  gcs: "gs://bucket/file.pdf",
  hash: "abc123",
  filename: "file.pdf",
  timestamp: "2024-01-15T10:00:00.000Z",
  converted: {
    url: "https://storage.../converted.csv",
    gcs: "gs://bucket/converted.csv"
  }
}
```

### Layer 3: File Collection (Cortex Redis Hash Maps)

**Purpose**: User-facing file collections with metadata

**Storage**: Redis hash maps (`FileStoreMap:ctx:<contextId>`)

**Format**:
```javascript
// Redis Hash Map Structure:
// Key: FileStoreMap:ctx:<contextId>
// Value: Hash map where each entry is {hash: fileDataJSON}

// Example hash map entry:
{
  "abc123": JSON.stringify({
    // CFH-managed fields
    url: "https://storage.../file.pdf",
    gcs: "gs://bucket/file.pdf",
    filename: "uuid-based-name.pdf",
    
    // Cortex-managed fields
    id: "1736966400000-abc123",
    displayFilename: "user-friendly-name.pdf",
    mimeType: "application/pdf",
    tags: ["pdf", "report"],
    notes: "Quarterly report",
    hash: "abc123",
    permanent: true,
    addedDate: "2024-01-15T10:00:00.000Z",
    lastAccessed: "2024-01-15T10:00:00.000Z"
  })
}
```

**Features**:
- Atomic operations (Redis HSET/HDEL/HGET are thread-safe)
- In-memory caching (5-second TTL)
- Direct hash map access (no versioning needed)
- Context-scoped isolation (`FileStoreMap:ctx:<contextId>`)

---

## Key Concepts

### 1. Context Scoping (`contextId` and `altContextId`)

**Purpose**: Per-user/per-context file isolation with optional cross-context reading

**Usage**:
- **`contextId`**: Primary context for file operations (strongly recommended)
- **`altContextId`**: Optional secondary context for read-only file access (union)
- Stored in Redis with scoped keys: `FileStoreMap:ctx:<contextId>`

**Benefits**:
- Prevents hash collisions between users
- Enables per-user file management
- Supports multi-tenant applications
- `altContextId` allows reading files from a secondary context (e.g., workspace files)

**Example**:
```javascript
// Upload with contextId
await uploadFileToCloud(fileBuffer, mimeType, filename, resolver, "user-123");

// Check hash with contextId
await checkHashExists(hash, fileHandlerUrl, null, "user-123");

// Delete with contextId
await deleteFileByHash(hash, resolver, "user-123");

// Load merged collection (reads from both contexts)
const collection = await loadMergedFileCollection("user-123", null, "workspace-456");

// Resolve file from either context
const url = await resolveFileParameter("file.pdf", "user-123", null, { altContextId: "workspace-456" });
```

**`altContextId` Behavior**:
- Files are read from both `contextId` and `altContextId` (union)
- Writes/updates only go to the context that owns the file
- Deduplication: if a file exists in both contexts (same hash), primary takes precedence
- Files from alt context bypass `inCollection` filtering (all files accessible)

### 2. Permanent Files (`permanent` flag)

**Purpose**: Indicate files that should be kept indefinitely

**Storage**:
- Stored in file collection entry: `permanent: true`
- Sets blob index tag: `retention=permanent`
- Prevents deletion from cloud storage

**Usage**:
```javascript
// Add permanent file
await addFileToCollection(
    contextId, contextKey, url, gcs, filename, tags, notes, hash,
    null, resolver, true  // permanent=true
);

// Check before deletion
if (!file.permanent) {
    await deleteFileByHash(file.hash, resolver, contextId);
}
```

**Behavior**:
- Permanent files are **not deleted** from cloud storage when removed from collection
- Retention set via `setRetentionForHash()` (best-effort)
- Default: `permanent=false` (temporary, 30-day retention)

### 3. Hash Deduplication

**Purpose**: Avoid storing duplicate files

**Process**:
1. Compute xxhash64 hash of file content
2. Check if hash exists via `checkHashExists()`
3. If exists, return existing URLs (no upload)
4. If not, upload and store hash

**Benefits**:
- Saves storage space
- Faster uploads (skip if duplicate)
- Consistent file references

### 4. Short-Lived URLs

**Purpose**: Secure, time-limited file access

**Features**:
- 5-minute expiration (configurable)
- Always included in file handler responses
- Preferred for LLM file access
- Automatically generated on `checkHash` operations

**Usage**:
```javascript
// Resolve to short-lived URL
const fileWithShortLivedUrl = await ensureShortLivedUrl(
    fileObject, fileHandlerUrl, contextId, 5  // 5 minutes
);
// fileWithShortLivedUrl.url is now short-lived URL
```

### 5. Atomic Operations

**Purpose**: Ensure thread-safe collection modifications

**Process**:
- Redis hash map operations (HSET, HDEL, HGET) are atomic
- No version-based locking needed
- Direct hash map updates per file (not full collection replacement)

**Functions**:
- `addFileToCollection()`: Atomic HSET operation
- `updateFileMetadata()`: Atomic HSET operation (updates single file)
- `loadFileCollection()`: Atomic HGETALL operation
- File removal: Atomic HDEL operation

**Benefits**:
- No version conflicts (each file updated independently)
- Faster operations (no retry loops)
- Simpler code (no locking logic needed)

---

## Complete Function Reference

### File Handler Operations

#### `buildFileHandlerUrl(baseUrl, params)`
Builds file handler URL with query parameters.
- **Parameters**:
  - `baseUrl`: File handler service URL
  - `params`: Object with query parameters (null/undefined skipped)
- **Returns**: Complete URL with encoded parameters
- **Used by**: All file handler operations

#### `fetchFileFromUrl(fileUrl, requestId, contextId, save)`
Downloads and processes file from URL.
- **Parameters**:
  - `fileUrl`: URL to fetch
  - `requestId`: Request ID for tracking
  - `contextId`: Optional context ID
  - `save`: Whether to save converted file (default: false)
- **Returns**: Response data (object or array)
- **Used by**: `azureVideoTranslatePlugin`, `azureCognitivePlugin`

#### `uploadFileToCloud(fileInput, mimeType, filename, pathwayResolver, contextId)`
Uploads file to cloud storage with deduplication.
- **Parameters**:
  - `fileInput`: URL string, base64 string, or Buffer
  - `mimeType`: MIME type (optional)
  - `filename`: Filename (optional, inferred if not provided)
  - `pathwayResolver`: Optional resolver for logging
  - `contextId`: Optional context ID for scoping
- **Returns**: `{url, gcs, hash}`
- **Process**:
  1. Converts input to Buffer
  2. Computes hash
  3. Checks if exists (deduplication)
  4. Uploads if not exists
- **Used by**: All tools that upload files

#### `checkHashExists(hash, fileHandlerUrl, pathwayResolver, contextId, shortLivedMinutes)`
Checks if file exists by hash.
- **Parameters**:
  - `hash`: File hash
  - `fileHandlerUrl`: File handler URL
  - `pathwayResolver`: Optional resolver for logging
  - `contextId`: Optional context ID
  - `shortLivedMinutes`: URL expiration (default: 5)
- **Returns**: `{url, gcs, hash, filename}` or `null`
- **Used by**: Upload deduplication, file resolution

#### `deleteFileByHash(hash, pathwayResolver, contextId)`
Deletes file from cloud storage.
- **Parameters**:
  - `hash`: File hash
  - `pathwayResolver`: Optional resolver for logging
  - `contextId`: Optional context ID
- **Returns**: `true` if deleted, `false` if not found
- **Handles**: 404 gracefully (file already deleted)

#### `setRetentionForHash(hash, retention, contextId, pathwayResolver)`
Sets file retention (temporary or permanent).
- **Parameters**:
  - `hash`: File hash
  - `retention`: `'temporary'` or `'permanent'`
  - `contextId`: Optional context ID
  - `pathwayResolver`: Optional resolver for logging
- **Returns**: Response data or `null`
- **Used by**: `addFileToCollection` when `permanent=true`

#### `ensureShortLivedUrl(fileObject, fileHandlerUrl, contextId, shortLivedMinutes)`
Resolves file to use short-lived URL.
- **Parameters**:
  - `fileObject`: File object with `hash` and `url`
  - `fileHandlerUrl`: File handler URL
  - `contextId`: Optional context ID
  - `shortLivedMinutes`: URL expiration (default: 5)
- **Returns**: File object with `url` updated to short-lived URL
- **Used by**: Tools that send files to LLMs

#### `getMediaChunks(file, requestId, contextId)`
Gets chunked media file URLs.
- **Parameters**:
  - `file`: File URL
  - `requestId`: Request ID
  - `contextId`: Optional context ID
- **Returns**: Array of chunk URLs

#### `markCompletedForCleanUp(requestId, contextId)`
Marks request as completed for cleanup.
- **Parameters**:
  - `requestId`: Request ID
  - `contextId`: Optional context ID
- **Returns**: Response data or `null`

### File Collection Operations

#### `loadFileCollection(contextId, contextKey, useCache)`
Loads file collection from Redis hash map.
- **Parameters**:
  - `contextId`: Context ID (required)
  - `contextKey`: Optional encryption key
  - `useCache`: Whether to use cache (default: true)
- **Returns**: Array of file entries (sorted by lastAccessed, most recent first)
- **Process**:
  1. Checks in-memory cache (5-second TTL)
  2. Loads from Redis hash map `FileStoreMap:ctx:<contextId>`
  3. Filters by `inCollection` (only returns global files or chat-specific files)
  4. Converts hash map entries to array format
  5. Updates cache
- **Used by**: Primary file collection operations

#### `loadFileCollectionAll(contextId, contextKey)`
Loads ALL files from a context, bypassing `inCollection` filtering.
- **Parameters**:
  - `contextId`: Context ID (required)
  - `contextKey`: Optional encryption key
- **Returns**: Array of all file entries (no filtering)
- **Used by**: `loadMergedFileCollection` when loading alt context files

#### `loadMergedFileCollection(contextId, contextKey, altContextId)`
Loads merged file collection from primary and optional alternate context.
- **Parameters**:
  - `contextId`: Primary context ID (required)
  - `contextKey`: Optional encryption key
  - `altContextId`: Optional alternate context ID for union
- **Returns**: Array of file entries from both contexts (deduplicated by hash/url/gcs)
- **Process**:
  1. Loads primary collection via `loadFileCollection()`
  2. Tags each file with `_contextId` (internal, stripped before returning to callers)
  3. If `altContextId` provided, loads alt collection via `loadFileCollectionAll()` (bypasses inCollection filter)
  4. Deduplicates: primary takes precedence if same file exists in both
  5. Returns merged collection
- **Used by**: `syncAndStripFilesFromChatHistory`, `getAvailableFiles`, `resolveFileParameter`, file tools

#### `saveFileCollection(contextId, contextKey, collection)`
Saves file collection to Redis hash map (optimized - only updates changed entries).
- **Parameters**:
  - `contextId`: Context ID
  - `contextKey`: Optional encryption key (unused, kept for compatibility)
  - `collection`: Array of file entries
- **Returns**: `true` if successful, `false` on error
- **Process**:
  1. Compares each file with current state
  2. Only updates files that changed (optimized)
  3. Uses atomic HSET operations per file
  4. Preserves CFH-managed fields, updates Cortex-managed fields
- **Used by**: Tools that need to save multiple file changes

#### `updateFileMetadata(contextId, hash, metadata)`
Updates Cortex-managed metadata fields atomically.
- **Parameters**:
  - `contextId`: Context ID (required)
  - `hash`: File hash (used as Redis key)
  - `metadata`: Object with fields to update (displayFilename, tags, notes, mimeType, addedDate, lastAccessed, permanent)
- **Returns**: `true` if successful, `false` on error
- **Process**:
  1. Loads existing file data from Redis
  2. Merges metadata (preserves CFH fields, updates Cortex fields)
  3. Writes back via atomic HSET
  4. Invalidates cache
- **Used by**: Search operations (updates lastAccessed), EditFile (updates URL/hash)

#### `addFileToCollection(contextId, contextKey, url, gcs, filename, tags, notes, hash, fileUrl, pathwayResolver, permanent)`
Adds file to collection via atomic operation.
- **Parameters**:
  - `contextId`: Context ID (required)
  - `contextKey`: Optional encryption key (unused, kept for compatibility)
  - `url`: Azure URL (optional if fileUrl provided)
  - `gcs`: GCS URL (optional)
  - `filename`: User-friendly filename (required)
  - `tags`: Array of tags (optional)
  - `notes`: Notes string (optional)
  - `hash`: File hash (optional, computed if not provided)
  - `fileUrl`: URL to upload (optional, uploads if provided)
  - `pathwayResolver`: Optional resolver for logging
  - `permanent`: Whether file is permanent (default: false)
- **Returns**: File entry object with `id`
- **Process**:
  1. If `fileUrl` provided, uploads file first via `uploadFileToCloud()`
  2. If `permanent=true`, sets retention to permanent via `setRetentionForHash()`
  3. Creates file entry with `displayFilename` (user-friendly name)
  4. Writes to Redis hash map via atomic HSET
  5. Merges with existing CFH data if hash already exists
- **Used by**: WriteFile, Image tools, FileCollection tool

#### `syncAndStripFilesFromChatHistory(chatHistory, contextId, contextKey, altContextId)`
Processes chat history files based on collection membership.
- **Parameters**:
  - `chatHistory`: Chat history array to process
  - `contextId`: Context ID (required)
  - `contextKey`: Optional encryption key
  - `altContextId`: Optional alternate context ID for merged collection
- **Returns**: `{ chatHistory, availableFiles }` - processed chat history and formatted file list
- **Process**:
  1. Loads merged file collection (contextId + altContextId)
  2. For each file in chat history:
     - If in collection: strip from message, update lastAccessed and inCollection in owning context
     - If not in collection: leave in message as-is
  3. Returns processed history and available files string
  4. Uses atomic operations per file, updating the context that owns each file
- **Used by**: `sys_entity_agent` to process incoming chat history

### File Resolution

#### `resolveFileParameter(fileParam, contextId, contextKey, options)`
Resolves file parameter to file URL.
- **Parameters**:
  - `fileParam`: File ID, filename, URL, or hash
  - `contextId`: Context ID (required)
  - `contextKey`: Optional encryption key
  - `options`: Optional options object:
    - `preferGcs`: Boolean - prefer GCS URL over Azure URL
    - `useCache`: Boolean - use cache (default: true)
    - `altContextId`: String - alternate context ID for merged collection lookup
- **Returns**: File URL string (Azure or GCS) or `null` if not found
- **Matching** (via `findFileInCollection()`):
  - Exact ID match
  - Exact hash match
  - Exact URL match (Azure or GCS)
  - Exact filename match (case-insensitive, basename comparison)
  - Fuzzy filename match (contains, minimum 4 characters)
- **Used by**: ReadFile, EditFile, and other tools that need file URLs

#### `findFileInCollection(fileParam, collection)`
Finds file in collection array.
- **Parameters**:
  - `fileParam`: File identifier
  - `collection`: Collection array
- **Returns**: File entry or `null`
- **Used by**: `resolveFileParameter`

#### `generateFileMessageContent(fileParam, contextId, contextKey)`
Generates file content for LLM messages.
- **Parameters**:
  - `fileParam`: File identifier (ID, filename, URL, or hash)
  - `contextId`: Context ID (required)
  - `contextKey`: Optional encryption key
- **Returns**: File content object with `type`, `url`, `gcs`, `hash` or `null`
- **Process**:
  1. Finds file in collection via `findFileInCollection()`
  2. Resolves to short-lived URL via `ensureShortLivedUrl()`
  3. Returns OpenAI-compatible format: `{type: 'image_url', url, gcs, hash}`
- **Used by**: AnalyzeFile tool to inject files into chat history

#### `extractFilesFromChatHistory(chatHistory)`
Extracts file metadata from chat history messages.
- **Parameters**:
  - `chatHistory`: Chat history array to scan
- **Returns**: Array of file metadata objects `{url, gcs, hash, type}`
- **Process**:
  1. Scans all messages for file content objects
  2. Extracts from `image_url`, `file`, or direct URL objects
  3. Returns normalized format
- **Used by**: File extraction utilities

#### `getAvailableFiles(chatHistory, contextId, contextKey, altContextId)`
Gets formatted list of available files from collection.
- **Parameters**:
  - `chatHistory`: Unused (kept for API compatibility)
  - `contextId`: Context ID (required)
  - `contextKey`: Optional encryption key
  - `altContextId`: Optional alternate context ID for merged collection
- **Returns**: Formatted string of available files (last 10 most recent)
- **Process**:
  1. Loads merged file collection (contextId + altContextId)
  2. Formats files via `formatFilesForTemplate()`
  3. Returns compact one-line format per file
- **Used by**: Template rendering to show available files

### Utility Functions

#### `computeFileHash(filePath)`
Computes xxhash64 hash of file.
- **Returns**: Hash string (hex)

#### `computeBufferHash(buffer)`
Computes xxhash64 hash of buffer.
- **Returns**: Hash string (hex)

#### `extractFilenameFromUrl(url, gcs)`
Extracts filename from URL (prefers GCS).
- **Returns**: Filename string

#### `ensureFilenameExtension(filename, mimeType)`
Ensures filename has correct extension based on MIME type.
- **Returns**: Filename with correct extension

#### `determineMimeTypeFromUrl(url, gcs, filename)`
Determines MIME type from URL or filename.
- **Returns**: MIME type string

#### `isTextMimeType(mimeType)`
Checks if MIME type is text-based.
- **Parameters**:
  - `mimeType`: MIME type string to check
- **Returns**: Boolean (true if text-based)
- **Supports**: All `text/*` types, plus application types like JSON, JavaScript, XML, YAML, Python, etc.
- **Used by**: ReadFile, EditFile to validate file types

#### `getMimeTypeFromFilename(filenameOrPath, defaultMimeType)`
Gets MIME type from filename or path.
- **Parameters**:
  - `filenameOrPath`: Filename or full file path
  - `defaultMimeType`: Optional default (default: 'application/octet-stream')
- **Returns**: MIME type string
- **Used by**: File upload, file type detection

#### `getMimeTypeFromExtension(extension, defaultMimeType)`
Gets MIME type from file extension.
- **Parameters**:
  - `extension`: File extension (with or without leading dot)
  - `defaultMimeType`: Optional default (default: 'application/octet-stream')
- **Returns**: MIME type string

---

## Error Handling

### File Handler Errors

**Network Errors**:
- Handled gracefully in all functions
- Logged via `pathwayResolver` or `logger`
- Non-critical operations return `null` instead of throwing

**404 Errors**:
- Treated as "file not found" (not an error)
- `deleteFileByHash` returns `false` on 404
- `checkHashExists` returns `null` on 404

**Timeout Errors**:
- Upload: 30 seconds
- Check hash: 10 seconds
- Fetch file: 60 seconds
- Set retention: 15 seconds

### File Collection Errors

**Missing ContextId**:
- File collection operations require `contextId`
- Returns `null` or throws error if missing

**Concurrent Modifications**:
- Prevented by atomic Redis operations (HSET, HDEL are thread-safe)
- No version conflicts (each file updated independently)

**Invalid File Data**:
- Invalid JSON entries are skipped during load
- Missing required fields are handled gracefully

### Best Practices

1. **Always pass `contextId`** when available (strongly recommended for multi-tenant)
2. **Use atomic operations** - `addFileToCollection()`, `updateFileMetadata()` are thread-safe
3. **Check `permanent` flag** before deleting files from cloud storage
4. **Handle errors gracefully** - don't throw on non-critical failures
5. **Use short-lived URLs** for LLM file access (via `ensureShortLivedUrl()`)
6. **Check for existing files** before uploading (automatic in `uploadFileToCloud`)
7. **Preserve CFH fields** - when updating metadata, preserve `url`, `gcs`, `filename` from file handler
8. **Use `displayFilename`** for user-facing displays (fallback to `filename` if not set)

---

## Summary

The Cortex file system provides:

✅ **Encapsulated file handler interactions** - No direct axios calls
✅ **Hash-based deduplication** - Avoids duplicate storage
✅ **Context scoping** - Per-user file isolation via `FileStoreMap:ctx:<contextId>`
✅ **Permanent file support** - Indefinite retention
✅ **Atomic operations** - Thread-safe collection modifications via Redis hash maps
✅ **Short-lived URLs** - Secure file access (5-minute expiration)
✅ **Comprehensive error handling** - Graceful failure handling
✅ **Single API call optimization** - Efficient file resolution
✅ **Field ownership separation** - CFH-managed vs Cortex-managed fields
✅ **Chat history integration** - Automatic file syncing from conversations

All file operations flow through `lib/fileUtils.js`, ensuring consistency, maintainability, and proper error handling throughout the system.

### Architecture Highlights

- **File Handler Service**: External Azure Function managing cloud storage
- **File Utilities Layer**: Abstraction over file handler (no direct API calls)
- **File Collection System**: Redis hash maps for user file metadata
- **Atomic Operations**: Thread-safe via Redis HSET/HDEL/HGET operations
- **Context Isolation**: Per-context hash maps for multi-tenant support

