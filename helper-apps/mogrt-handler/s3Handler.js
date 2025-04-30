import { S3Client, PutObjectCommand, GetObjectCommand, ListObjectVersionsCommand, GetObjectAttributesCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Readable } from 'stream';

// Create s3Client lazily to allow for proper mocking in tests
let s3Client = null;
const getS3Client = () => {
    if (!s3Client) {
        s3Client = new S3Client({
            region: process.env.AWS_REGION || 'us-east-1'
        });
    }
    return s3Client;
};

const BUCKET_NAME = process.env.S3_BUCKET_NAME || (process.env.NODE_ENV === 'test' ? 'test-bucket' : null);
const MASTER_MANIFEST_KEY = 'master-manifest.json';
const SIGNED_URL_EXPIRY = parseInt(process.env.SIGNED_URL_EXPIRY_SECONDS) || 3600; // Default 1 hour

if (!BUCKET_NAME) {
    throw new Error('S3_BUCKET_NAME environment variable is required');
}

/**
 * Generates a signed URL for an S3 object
 * @param {string} key - The S3 object key
 * @returns {Promise<string>} - The signed URL
 */
async function generateSignedUrl(key) {
    const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key
    });
    
    return await getSignedUrl(getS3Client(), command, { expiresIn: SIGNED_URL_EXPIRY });
}

/**
 * Adds signed URLs to a manifest object
 * @param {Object} manifest - The manifest object
 * @returns {Promise<Object>} - Manifest with signed URLs
 */
async function addSignedUrlsToManifest(manifest) {
    const result = { ...manifest };
    if (manifest?.mogrtFile) {
        result.mogrtUrl = await generateSignedUrl(manifest.mogrtFile);
    }
    if (manifest?.previewFile) {
        result.previewUrl = await generateSignedUrl(manifest.previewFile);
    }
    return result;
}

/**
 * Gets the master manifest file containing all MOGRT entries
 * @returns {Promise<Array>} Array of all MOGRT entries
 */
async function getMasterManifest() {
    try {
        console.log('🔍 Attempting to get master manifest from S3...');
        const response = await getS3Client().send(
            new GetObjectCommand({
                Bucket: BUCKET_NAME,
                Key: MASTER_MANIFEST_KEY
            })
        );
        console.log('📥 Retrieved master manifest response');
        
        const manifestData = await response.Body.transformToString();
        console.log('📄 Raw master manifest data:', manifestData);

        let manifest = JSON.parse(manifestData);
        if (!Array.isArray(manifest)) {
            console.warn('Master manifest is not an array. Resetting to empty manifest.');
            manifest = [];
        }
        const requiredKeys = ['id', 'mogrtFile','name', 'previewFile', 'uploadDate'];
        const validManifest = manifest.filter(entry => {
            const missingKeys = requiredKeys.filter(key => !(Object.prototype.hasOwnProperty.call(entry, key) && entry[key] !== undefined && entry[key] !== null));
            if (missingKeys.length > 0) {
                console.warn('Manifest entry missing keys:', missingKeys, 'Entry:', JSON.stringify(entry, null, 2));
                return false;
            }
            return true;
        });
        manifest = validManifest;
        console.log('🔄 Parsed master manifest:', JSON.stringify(manifest, null, 2));
        
        // Add signed URLs to each entry
        console.log('🔑 Adding signed URLs to manifest entries...');
        const manifestWithUrls = await Promise.all(manifest.map(entry => addSignedUrlsToManifest(entry)));
        console.log('✅ Successfully added signed URLs to all entries');
        
        return manifestWithUrls;
    } catch (error) {
        if (error.name === 'NoSuchKey') {
            console.log('⚠️ Master manifest not found, creating empty manifest');
            const emptyManifest = [];
            await updateMasterManifest(emptyManifest);
            return emptyManifest;
        }
        console.error('❌ Error getting master manifest:', error);
        throw error;
    }
}

/**
 * Updates the master manifest file
 * @param {Array} manifest - The complete manifest array
 */
async function updateMasterManifest(manifest) {
    console.log('📝 Preparing to update master manifest...');
    console.log('📊 Current manifest entries:', manifest.length);
    
    // Remove signed URLs before saving
    const manifestToSave = manifest.map(({ id, mogrtFile, previewFile, name, uploadDate }) => {
        console.log(`🔖 Processing entry ${id}:`, { mogrtFile, previewFile, uploadDate });
        return {
            id,
            mogrtFile,
            previewFile,
            name,
            uploadDate
        };
    });

    const uploadParams = {
        Bucket: BUCKET_NAME,
        Key: MASTER_MANIFEST_KEY,
        Body: Buffer.from(JSON.stringify(manifestToSave, null, 2)),
        ContentType: 'application/json'
    };

    console.log('💾 Saving master manifest to S3:', JSON.stringify(manifestToSave, null, 2));
    try {
        await getS3Client().send(new PutObjectCommand(uploadParams));
        console.log('✅ Master manifest successfully updated');
    } catch (error) {
        console.error('❌ Error updating master manifest:', error);
        throw error;
    }
}

/**
 * Adds a new entry to the master manifest
 * @param {Object} entry - The new manifest entry to add
 */
async function addToMasterManifest(entry) {
    try {
        console.log('📥 Getting current master manifest...');
        const masterManifest = await getMasterManifest();
        console.log('📊 Current master manifest entries:', masterManifest.length);
        console.log('📄 Current master manifest content:', JSON.stringify(masterManifest, null, 2));
        
        // Check if entry already exists
        const existingIndex = masterManifest.findIndex(item => item.id === entry.id);
        
        if (existingIndex !== -1) {
            console.log(`🔄 Updating existing entry at index ${existingIndex}:`, entry.id);
            console.log('📝 Old entry:', JSON.stringify(masterManifest[existingIndex], null, 2));
            console.log('📝 New entry:', JSON.stringify(entry, null, 2));
            masterManifest[existingIndex] = entry;
        } else {
            console.log('➕ Adding new entry:', JSON.stringify(entry, null, 2));
            masterManifest.push(entry);
        }

        console.log('💾 Saving updated master manifest...');
        await updateMasterManifest(masterManifest);
        console.log('✅ Master manifest successfully updated');
        console.log('📊 New total entries:', masterManifest.length);
    } catch (error) {
        console.error('❌ Error in addToMasterManifest:', error);
        throw error;
    }
}

/**
 * Uploads a file to S3
 * @param {string} key - key (location) of the file in S3
 * @param {Buffer|Readable} fileData - File data to upload
 * @returns {Promise<{key: string, location: string}>}
 */
export async function uploadToS3(key, fileData, contentType) {
    
    const uploadParams = {
        Bucket: BUCKET_NAME,
        Key: key,
        Body: fileData instanceof Buffer ? fileData : Readable.from(fileData),
        ContentType: contentType || (key.endsWith('.json') ? 'application/json' : 'application/octet-stream')
    };

    await getS3Client().send(new PutObjectCommand(uploadParams));

    return {
        key,
        location: `s3://${BUCKET_NAME}/${key}`
    };
}

/**
 * Gets the manifest file for a specific upload
 * @param {string} uploadId - UUID of the upload
 * @returns {Promise<Object>} - Manifest JSON with signed URLs
 */
export async function getManifest(uploadId) {
    if (uploadId === 'master') {
        return getMasterManifest();
    }

    const key = `${uploadId}/manifest.json`;
    
    try {
        const response = await getS3Client().send(
            new GetObjectCommand({
                Bucket: BUCKET_NAME,
                Key: key
            })
        );

        const manifestData = await response.Body.transformToString();
        const manifest = JSON.parse(manifestData);
        
        // Add signed URLs to the manifest
        return await addSignedUrlsToManifest(manifest);
    } catch (error) {
        if (error.name === 'NoSuchKey') {
            throw new Error('Manifest not found');
        }
        throw error;
    }
}

/**
 * Creates or updates an individual manifest and adds it to the master manifest
 * @param {Object} manifest - The individual manifest to save
 */
export async function saveManifest(manifest) {
    try {
        console.log('Saving manifest:', manifest);
        
        // Remove signed URLs if they exist
        const { id, mogrtFile, name, previewFile, uploadDate } = manifest;
        const manifestToSave = { id, mogrtFile, name, previewFile, uploadDate };

        // Save individual manifest
        await uploadToS3(
            `${manifest.id}/manifest.json`, // Key for individual manifest.id,
            Buffer.from(JSON.stringify(manifestToSave, null, 2)),
            'application/json'
        );
        console.log('Individual manifest saved');

        // Add to master manifest
        await addToMasterManifest(manifestToSave);
        console.log('Added to master manifest');
    } catch (error) {
        console.error('Error saving manifest:', error);
        throw error;
    }
}

/**
 * Saves a glossary ID to S3 with versioning
 * @param {string} glossaryId - The glossary ID to save
 * @param {string} langPair - The language pair for the glossary (e.g., 'en-es')
 * @param {string} name - Optional name for the glossary
 * @returns {Promise<{key: string, location: string, versionId: string}>}
 */
export async function saveGlossaryId(glossaryId, langPair, name = '') {
    if (!glossaryId) {
        throw new Error('Glossary ID is required');
    }
    if (!langPair) {
        throw new Error('Language pair is required');
    }

    const key = `glossaries/${langPair}/${glossaryId}.txt`;
    const metadata = {
        'glossary-id': glossaryId,
        'language-pair': langPair
    };
    
    if (name) {
        metadata['glossary-name'] = name;
    }

    const uploadParams = {
        Bucket: BUCKET_NAME,
        Key: key,
        Body: glossaryId,
        ContentType: 'text/plain',
        Metadata: metadata
    };

    try {
        console.log(`💾 Saving glossary ID ${glossaryId} to S3: ${key}`);
        const response = await getS3Client().send(new PutObjectCommand(uploadParams));
        console.log(`✅ Glossary ID saved with version: ${response.VersionId}`);
        
        return {
            key,
            location: `s3://${BUCKET_NAME}/${key}`,
            versionId: response.VersionId
        };
    } catch (error) {
        console.error(`❌ Error saving glossary ID to S3:`, error);
        throw error;
    }
}

/**
 * Gets all versions of a glossary
 * @param {string} glossaryId - The ID of the glossary to get versions for
 * @param {string} langPair - The language pair for the glossary
 * @param {string} name - Optional name of the glossary
 * @returns {Promise<Array>} - Array of glossary versions with metadata
 */
export async function getGlossaryVersions(glossaryId, langPair, name = '') {
    const keyPrefix = `glossaries/${langPair}/`;
    const key = `${keyPrefix}${glossaryId}.txt`;
    
    try {
        console.log(`🔍 Getting versions for glossary ${glossaryId} from S3...`);
        const response = await getS3Client().send(new ListObjectVersionsCommand({
            Bucket: BUCKET_NAME,
            Prefix: key
        }));
        
        console.log(`📥 Retrieved ${response.Versions?.length || 0} versions`);
        
        if (!response.Versions || response.Versions.length === 0) {
            return [];
        }
        
        // Map versions to a more user-friendly format
        const versions = await Promise.all(response.Versions.map(async (version) => {
            try {
                // Get the object to retrieve the actual glossary ID content
                const objectResponse = await getS3Client().send(new GetObjectCommand({
                    Bucket: BUCKET_NAME,
                    Key: version.Key,
                    VersionId: version.VersionId
                }));
                
                const glossaryId = await objectResponse.Body.transformToString();
                
                return {
                    versionId: version.VersionId,
                    glossaryId: glossaryId,
                    lastModified: version.LastModified,
                    isLatest: version.IsLatest,
                    metadata: objectResponse.Metadata || {}
                };
            } catch (error) {
                console.error(`❌ Error retrieving version ${version.VersionId}:`, error);
                return {
                    versionId: version.VersionId,
                    lastModified: version.LastModified,
                    isLatest: version.IsLatest,
                    error: 'Failed to retrieve version details'
                };
            }
        }));
        
        return versions;
    } catch (error) {
        console.error(`❌ Error getting glossary versions:`, error);
        throw error;
    }
}

/**
 * Gets a specific version of a glossary
 * @param {string} glossaryId - The glossary ID
 * @param {string} langPair - The language pair
 * @param {string} versionId - The specific version ID to retrieve
 * @param {string} name - Optional name of the glossary
 * @returns {Promise<Object>} - The glossary version details
 */
export async function getGlossaryVersion(glossaryId, langPair, versionId, name = '') {
    const key = `glossaries/${langPair}/${glossaryId}.txt`;
    
    try {
        console.log(`🔍 Getting version ${versionId} for glossary ${glossaryId}...`);
        const response = await getS3Client().send(new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            VersionId: versionId
        }));
        
        const content = await response.Body.transformToString();
        
        return {
            versionId: versionId,
            glossaryId: content,
            lastModified: response.LastModified,
            metadata: response.Metadata || {}
        };
    } catch (error) {
        console.error(`❌ Error getting glossary version ${versionId}:`, error);
        throw error;
    }
}

// Export for testing
export { getS3Client };

// Reset function for testing
export function resetS3Client() {
    s3Client = null;
}
