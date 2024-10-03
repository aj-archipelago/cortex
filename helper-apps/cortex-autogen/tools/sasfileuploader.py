import os
import sys
from datetime import datetime, timedelta
from typing import Annotated
from pydantic import BaseModel, Field

def install_azure_storage_blob():
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "azure-storage-blob"])

try:
    from azure.storage.blob import BlobServiceClient, BlobClient, generate_blob_sas, BlobSasPermissions
except ImportError:
    install_azure_storage_blob()
    from azure.storage.blob import BlobServiceClient, BlobClient, generate_blob_sas, BlobSasPermissions

class SasUploaderInput(BaseModel):
    file_path: Annotated[str, Field(description="Path to the file to upload")]
    container_name: Annotated[str, Field(description="Azure Blob container name")]
    blob_name: Annotated[str, Field(description="Name for the blob in Azure storage")]

def autogen_sas_uploader(file_path: str) -> str:
    """
    Upload a file to Azure Blob Storage and generate a SAS URL.

    This function uploads the specified file to Azure Blob Storage using the container name
    from the AZURE_BLOB_CONTAINER environment variable. It then generates and returns a
    Shared Access Signature (SAS) URL for the uploaded blob.

    Args:
    file_path (str): Path to the local file to be uploaded.

    Returns:
    str: SAS URL of the uploaded blob if successful, or an error message if the upload fails.

    Note: 
    - Requires AZURE_STORAGE_CONNECTION_STRING and AZURE_BLOB_CONTAINER environment variables.
    - The blob name in Azure will be the same as the input file name.
    """
    connect_str = os.environ.get('AZURE_STORAGE_CONNECTION_STRING')
    container_name = os.environ.get('AZURE_BLOB_CONTAINER')
    
    if not connect_str or not container_name:
        return "Error: AZURE_STORAGE_CONNECTION_STRING or AZURE_BLOB_CONTAINER not set."

    blob_service_client = BlobServiceClient.from_connection_string(connect_str)
    blob_client = blob_service_client.get_blob_client(container=container_name, blob=file_path)

    try:
        with open(file_path, "rb") as data:
            blob_client.upload_blob(data, overwrite=True)
        
        sas_token = generate_blob_sas(
            account_name=blob_service_client.account_name,
            container_name=container_name,
            blob_name=file_path,
            account_key=blob_service_client.credential.account_key,
            permission=BlobSasPermissions(read=True),
            expiry=datetime.utcnow() + timedelta(days=30)
        )
        
        sas_url = f"https://{blob_service_client.account_name}.blob.core.windows.net/{container_name}/{file_path}?{sas_token}"
        return sas_url
    except Exception as e:
        return f"Error uploading file: {str(e)}"
    