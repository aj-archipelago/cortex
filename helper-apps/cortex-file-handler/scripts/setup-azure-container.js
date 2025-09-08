import { BlobServiceClient } from "@azure/storage-blob";

async function createContainers() {
  try {
    // Check if required environment variables are set
    const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
    const containerNames = process.env.AZURE_STORAGE_CONTAINER_NAME;
    
    if (!connectionString) {
      throw new Error("AZURE_STORAGE_CONNECTION_STRING environment variable is required");
    }
    
    if (!containerNames) {
      throw new Error("AZURE_STORAGE_CONTAINER_NAME environment variable is required");
    }

    const blobServiceClient = BlobServiceClient.fromConnectionString(connectionString);
    
    // Parse container names from environment variable
    const containers = containerNames.split(',').map(name => name.trim());
    console.log(`Creating containers: ${containers.join(', ')}`);

    // Create each container
    for (const containerName of containers) {
      if (!containerName) continue; // Skip empty names
      
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
