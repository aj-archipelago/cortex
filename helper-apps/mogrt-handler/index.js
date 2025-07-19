import { uploadToS3, getManifest, saveManifest, removeFromMasterManifest } from './s3Handler.js';
import Busboy from 'busboy';
import { v4 as uuidv4 } from 'uuid';
import path from 'path';

const ALLOWED_EXTENSIONS = {
    MOGRT: '.mogrt',
    PREVIEW: ['.gif', '.mp4']
};

const validateFiles = (files) => {
    const hasMogrt = files.some(f => path.extname(f.filename).toLowerCase() === ALLOWED_EXTENSIONS.MOGRT);
    const hasPreview = files.some(f => ALLOWED_EXTENSIONS.PREVIEW.includes(path.extname(f.filename).toLowerCase()));
    console.log('Validating files:', hasMogrt, hasPreview);
    if (!hasMogrt || !hasPreview) {
        throw new Error('Both MOGRT and preview files (GIF or MP4) are required');
    }
};

async function MogrtHandler(context, req) {
    const { method } = req;
    const { manifestId } = req.query;
    const id = req.params?.id;

    try {
        // GET request to fetch manifest
        if (method === 'GET') {
            const manifest = await getManifest(manifestId || 'master');
            context.res = {
                status: 200,
                body: manifest
            };
            return;
        }

        // DELETE request to remove MOGRT item
        if (method === 'DELETE' && id) {
            console.log(`Attempting to delete MOGRT with ID: ${id} from manifest: ${manifestId || 'master'}`);
            try {
                // Use the new removeFromMasterManifest function
                const removed = await removeFromMasterManifest(id);
                
                // If the item was not found
                if (!removed) {
                    console.log(`MOGRT with ID ${id} not found in manifest`);
                    context.res = {
                        status: 404,
                        body: { error: `MOGRT with ID ${id} not found` }
                    };
                    return;
                }
                
                console.log(`Successfully deleted MOGRT with ID: ${id}`);
                
                context.res = {
                    status: 200,
                    body: {
                        success: true,
                        message: `MOGRT with ID ${id} successfully deleted`
                    }
                };
                return;
            } catch (error) {
                console.error(`Error deleting MOGRT with ID ${id}:`, error);
                context.res = {
                    status: 500,
                    body: { error: `Failed to delete MOGRT: ${error.message}` }
                };
                return;
            }
        }
        
        // POST request to upload files
        if (method === 'POST') {
            const files = [];
            const uploadId = uuidv4();
            let name = null;
            console.log('Generated uploadId:', uploadId);

            const busboy = Busboy({ 
                headers: {
                    'content-type': req.headers['content-type']
                },
                limits: {
                    fileSize: 50 * 1024 * 1024, // 50MB limit
                    files: 2 // Expect exactly 2 files
                }
            });

            return new Promise((resolve, reject) => {
                busboy.on('file', (fieldname, file, fileInfo) => {
                    console.log('Processing file:', fieldname, fileInfo.filename);
                    const ext = path.extname(fileInfo.filename).toLowerCase();
                    
                    if (ext !== ALLOWED_EXTENSIONS.MOGRT && !ALLOWED_EXTENSIONS.PREVIEW.includes(ext)) {
                        const error = new Error('Invalid file type. Only .mogrt, .gif and .mp4 files are allowed.');
                        file.resume(); // Drain this file
                        reject(error);
                        return;
                    }

                    const chunks = [];
                    file.on('data', chunk => {
                        console.log('Received chunk of size:', chunk.length);
                        chunks.push(chunk);
                    });

                    file.on('end', () => {
                        console.log('File upload complete:', fileInfo.filename);
                        const buffer = Buffer.concat(chunks);
                        files.push({
                            fieldname,
                            filename: fileInfo.filename,
                            buffer
                        });
                    });
                });

                busboy.on('field', (fieldname, value) => {
                    console.log('Received field:', fieldname, value);
                    if (fieldname === 'name') {
                        name = value;
                    }
                });

                busboy.on('finish', async () => {
                    console.log('All files processed, total files:', files.length);
                    try {
                        validateFiles(files);

                        const uploadPromises = files.map(file => {
                            const key = `${uploadId}/${file.filename}`;
                            const ext = path.extname(file.filename).toLowerCase();
                            let contentType;
                            if (ext === '.mogrt') {
                                contentType = 'application/octet-stream';
                            } else if (ext === '.gif') {
                                contentType = 'image/gif';
                            } else if (ext === '.mp4') {
                                contentType = 'video/mp4';
                            } else {
                                contentType = 'application/octet-stream';
                            }
                            return uploadToS3(key, file.buffer, contentType);
                        });

                        const uploadResults = await Promise.all(uploadPromises);
                        console.log('Upload results:', uploadResults);

                        const manifest = {
                            id: uploadId,
                            name: name || uploadId, // Use uploadId as fallback if name not provided
                            mogrtFile: uploadResults.find(r => path.extname(r.key).toLowerCase() === ALLOWED_EXTENSIONS.MOGRT)?.key,
                            previewFile: uploadResults.find(r => ALLOWED_EXTENSIONS.PREVIEW.includes(path.extname(r.key).toLowerCase()))?.key,
                            uploadDate: new Date().toISOString()
                        };

                        await saveManifest(manifest);
                        console.log('Manifest saved:', manifest);

                        const masterManifest = await getManifest('master');
                        context.res = {
                            status: 200,
                            body: {
                                manifest,
                                masterManifest
                            }
                        };
                        resolve();
                    } catch (error) {
                        console.error('Error processing files:', error);
                        context.res = {
                            status: 500,
                            body: { error: error.message }
                        };
                        reject(error);
                    }
                });

                busboy.on('error', (error) => {
                    console.error('Busboy error:', error);
                    reject(error);
                });

                // Handle the request data
                try {
                    if (typeof req.body === 'string') {
                        busboy.end(Buffer.from(req.body));
                    } else if (req.body instanceof Buffer) {
                        busboy.end(req.body);
                    } else if (req.rawBody) {
                        busboy.end(req.rawBody);
                    } else {
                        req.pipe(busboy);
                    }
                } catch (error) {
                    console.error('Error handling request:', error);
                    reject(error);
                }
            });
        }

        throw new Error('Method not allowed');
    } catch (error) {
        console.error('Handler error:', error);
        context.res = {
            status: error.status || 500,
            body: { error: error.message }
        };
    }
}

export default MogrtHandler;
