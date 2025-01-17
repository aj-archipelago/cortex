import { BlobServiceClient } from '@azure/storage-blob';
import { Storage } from '@google-cloud/storage';

async function createAzureContainer() {
    try {
        const blobServiceClient = BlobServiceClient.fromConnectionString("UseDevelopmentStorage=true");
        const containerClient = blobServiceClient.getContainerClient("test-container");
        
        console.log("Creating Azure container...");
        await containerClient.create();
        console.log("Azure container created successfully");
    } catch (error) {
        // Ignore if container already exists
        if (error.statusCode === 409) {
            console.log("Azure container already exists");
        } else {
            console.error("Error creating Azure container:", error);
            process.exit(1);
        }
    }
}

async function createGCSBucket() {
    try {
        const storage = new Storage({
            projectId: "test-project",
            apiEndpoint: "http://localhost:4443",
        });
        
        console.log("Creating GCS bucket...");
        await storage.createBucket("cortextempfiles");
        console.log("GCS bucket created successfully");
    } catch (error) {
        // Ignore if bucket already exists
        if (error.code === 409) {
            console.log("GCS bucket already exists");
        } else {
            console.error("Error creating GCS bucket:", error);
            process.exit(1);
        }
    }
}

async function setup() {
    await createAzureContainer();
    await createGCSBucket();
}

setup(); 