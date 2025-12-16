import { BlobServiceClient } from "@azure/storage-blob";
import { Storage } from "@google-cloud/storage";

async function createAzureContainers() {
  try {
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      "UseDevelopmentStorage=true",
    );
    
    // Create test containers that are actually used in test configurations
    // Note: We only use a single container now (no container scoping)
    const allTestContainers = ["default", "test-container"];
    
    console.log(`Creating Azure containers: ${allTestContainers.join(', ')}`);
    
    for (const containerName of allTestContainers) {
      try {
        const containerClient = blobServiceClient.getContainerClient(containerName);
        await containerClient.create();
        console.log(`✓ Created container: ${containerName}`);
      } catch (error) {
        // Ignore if container already exists
        if (error.statusCode === 409) {
          console.log(`✓ Container already exists: ${containerName}`);
        } else {
          console.error(`Error creating container ${containerName}:`, error);
          process.exit(1);
        }
      }
    }
    
    console.log("All Azure containers created successfully");
  } catch (error) {
    console.error("Error creating Azure containers:", error);
    process.exit(1);
  }
}

async function createGCSBucket() {
  try {
    const storage = new Storage({
      projectId: "test-project",
      apiEndpoint: "http://localhost:4443",
    });

    storage.baseUrl = "http://localhost:4443/storage/v1";

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
  await createAzureContainers();
  await createGCSBucket();
}

setup();
