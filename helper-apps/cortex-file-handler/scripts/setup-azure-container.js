import { BlobServiceClient } from "@azure/storage-blob";

async function createContainer() {
  try {
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      "UseDevelopmentStorage=true",
    );
    const containerClient =
      blobServiceClient.getContainerClient("test-container");

    console.log("Creating container...");
    await containerClient.create();
    console.log("Container created successfully");
  } catch (error) {
    // Ignore if container already exists
    if (error.statusCode === 409) {
      console.log("Container already exists");
    } else {
      console.error("Error creating container:", error);
      process.exit(1);
    }
  }
}

createContainer();
