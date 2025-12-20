import { BlobServiceClient } from "@azure/storage-blob";

async function createContainers() {
  try {
    // Check if required environment variables are set
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const containerNames = process.env.AZURE_STORAGE_CONTAINER_NAME;
    
    if (!connectionString) {
      throw new Error("AZURE_STORAGE_CONNECTION_STRING environment variable is required");
    }

    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    
    // Always create test containers that are used in tests
    const testContainers = ["default", "test-container"];
    
    // Also create containers from environment variable if provided
    const envContainers = containerNames 
      ? containerNames.split(',').map(name => name.trim()).filter(name => name)
      : [];
    
    // Combine and deduplicate container names
    const allContainers = [...new Set([...testContainers, ...envContainers])];
    
    console.log(`Creating containers: ${allContainers.join(', ')}`);

    // Create each container
    for (const containerName of allContainers) {
      try {
        const containerClient = blobServiceClient.getContainerClient(containerName);
        await containerClient.create();
        console.log(`✅ Container '${containerName}' created successfully`);
      } catch (error) {
        // Ignore if container already exists
        if (error.statusCode === 409) {
          console.log(`✅ Container '${containerName}' already exists`);
        } else {
          console.error(`❌ Error creating container '${containerName}':`, error.message);
          throw error;
        }
      }
    }
    
    console.log("🎉 All containers setup completed");
  } catch (error) {
    console.error("❌ Container setup failed:", error.message);
    process.exit(1);
  }
}

createContainers();
