import os
import sys
from azure.storage.blob import BlobServiceClient
from pathlib import Path

# Set of known extensions typically NOT supported for content cracking by Azure Cognitive Search (default configuration)
# Check Azure docs for the official list of *supported* formats.
# This list focuses on common formats often not processed for text content.
UNSUPPORTED_EXTENSIONS_KNOWN = {
    'key',   # Apple Keynote (as requested)
    'zip',   # Archive formats often need specific skills/configurations
    'rar',
    'gz',   
    'tar',
    '7z',
    'pkg',
    'dmg',   # Disk images
    'iso',
    'exe',   # Executables
    'dll',
    'mp4',   # Video formats
    'mov',
    'avi',
    'wmv',
    'mp3',   # Audio formats
    'wav',
    'aac',
    'pyc',   # Compiled Python
    'class', # Compiled Java
    'o',     # Compiled C/C++ object files
    'a',     # Static libraries
    'so',    # Shared libraries (Linux)
    # Add other known unsupported types if needed
}

def main():
    # --- Configuration ---
    try:
        connection_string = os.environ["AZURE_STORAGE_CONNECTION_STRING"]
    except KeyError:
        print("Error: AZURE_STORAGE_CONNECTION_STRING environment variable not set.", file=sys.stderr)
        sys.exit(1)
        
    container_name = "cortex-entity-indexed"
    # ---------------------

    print(f"Connecting to Azure Blob Storage container: {container_name}")
    try:
        blob_service_client = BlobServiceClient.from_connection_string(connection_string)
        container_client = blob_service_client.get_container_client(container_name)
        # Check if container exists
        container_client.get_container_properties() 
    except Exception as e:
        print(f"Error connecting to or accessing container '{container_name}': {e}", file=sys.stderr)
        sys.exit(1)

    print("Listing blobs and collecting extensions...")
    unique_extensions = set()
    blob_count = 0
    try:
        blob_list = container_client.list_blobs()
        for blob in blob_list:
            blob_count += 1
            suffix = Path(blob.name).suffix.lower()
            if suffix: # Only process if there is an extension
                # Store extension without the leading dot
                extension = suffix[1:]
                unique_extensions.add(extension)
            if blob_count % 10000 == 0:
                 print(f"  Processed {blob_count} blobs...")

        print(f"Finished processing {blob_count} blobs.")
    except Exception as e:
        print(f"Error listing blobs in container '{container_name}': {e}", file=sys.stderr)
        sys.exit(1)

    print("\n" + "-"*30)
    print(f"Found {len(unique_extensions)} unique file extensions:")
    print("" + "-"*30)
    
    # Sort extensions for consistent output
    sorted_extensions = sorted(list(unique_extensions))
    
    for ext in sorted_extensions:
        marker = "(Unsupported by Indexer)" if ext in UNSUPPORTED_EXTENSIONS_KNOWN else ""
        print(f".{ext} {marker}")

if __name__ == "__main__":
    main() 