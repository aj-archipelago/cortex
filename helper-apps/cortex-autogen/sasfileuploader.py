import os
import sys
from datetime import datetime, timedelta

def install_azure_storage_blob():
    print("Installing azure-storage-blob...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "azure-storage-blob"])
    print("azure-storage-blob installed successfully.")

try:
    from azure.storage.blob import BlobServiceClient, BlobClient, generate_blob_sas, BlobSasPermissions
except ImportError:
    install_azure_storage_blob()
    from azure.storage.blob import BlobServiceClient, BlobClient, generate_blob_sas, BlobSasPermissions

def generate_sas_url(blob_service_client, container_name, blob_name):
    """
    Generates a SAS URL for a blob.
    """
    sas_token = generate_blob_sas(
        account_name=blob_service_client.account_name,
        container_name=container_name,
        blob_name=blob_name,
        account_key=blob_service_client.credential.account_key,
        permission=BlobSasPermissions(read=True, write=True),
        expiry=datetime.utcnow() + timedelta(hours=1)
    )
    return f"https://{blob_service_client.account_name}.blob.core.windows.net/{container_name}/{blob_name}?{sas_token}"

def upload_file_to_blob(file_path, sas_url):
    """
    Uploads a single file to Azure Blob Storage using a SAS URL.
    """
    try:
        blob_client = BlobClient.from_blob_url(sas_url)
        with open(file_path, "rb") as data:
            blob_client.upload_blob(data, overwrite=True)
        print(f"Successfully uploaded {os.path.basename(file_path)} to Azure Blob Storage.")
        return True
    except Exception as e:
        print(f"Error uploading file: {e}")
        return False

def main():
    # Get Azure Storage connection string from environment variable
    connect_str = os.environ.get('AZURE_STORAGE_CONNECTION_STRING')
    if not connect_str:
        print("Error: AZURE_STORAGE_CONNECTION_STRING is not set in environment variables.")
        sys.exit(1)

    # Create the BlobServiceClient object
    blob_service_client = BlobServiceClient.from_connection_string(connect_str)

    # Get the container name from environment variable or use a default
    container_name = os.environ.get('AZURE_BLOB_CONTAINER', 'testcontainer')

    # Test file details
    file_path = "/tmp/test_file.txt"
    blob_name = "test_file.txt"

    # Create a test file
    with open(file_path, "w") as f:
        f.write("This is a test file for Azure Blob Storage upload.")

    print(f"Test file created at: {file_path}")

    # Generate SAS URL
    sas_url = generate_sas_url(blob_service_client, container_name, blob_name)
    print(f"Generated SAS URL: {sas_url}")

    # Upload file
    if upload_file_to_blob(file_path, sas_url):
        print("File upload completed successfully.")
    else:
        print("File upload failed.")

    # Clean up the test file
    os.remove(file_path)
    print(f"Test file removed: {file_path}")

    # Upload this script to Azure Blob Storage
    script_path = os.path.abspath(__file__)
    script_name = os.path.basename(script_path)
    script_sas_url = generate_sas_url(blob_service_client, container_name, script_name)
    
    if upload_file_to_blob(script_path, script_sas_url):
        print(f"Script uploaded successfully. You can access it at: {script_sas_url}")
    else:
        print("Failed to upload the script.")

if __name__ == "__main__":
    main()