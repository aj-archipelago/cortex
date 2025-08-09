#!/usr/bin/env python3
"""
Azure Blob Storage tools for uploading task files and generating SAS URLs.
"""
import os
import json
import logging
from datetime import datetime, timedelta
from urllib.parse import urlparse, parse_qs
from azure.storage.blob import BlobServiceClient, generate_blob_sas, BlobSasPermissions
from azure.core.exceptions import AzureError

logger = logging.getLogger(__name__)

def _validate_sas_url(url: str) -> bool:
    """Private helper to validate an Azure blob SAS URL."""
    try:
        parsed = urlparse(url)
        if not parsed.hostname or 'blob.core.windows.net' not in parsed.hostname:
            return False
        if not parsed.query:
            return False
        
        query_params = parse_qs(parsed.query)
        required_params = ['se', 'sp', 'sv', 'sr', 'sig']
        if not all(param in query_params for param in required_params):
            return False
        
        expiry_str_decoded = query_params['se'][0].replace('%3A', ':')
        expiry_time = datetime.fromisoformat(expiry_str_decoded.replace('Z', '+00:00'))
        if expiry_time <= datetime.now().replace(tzinfo=expiry_time.tzinfo):
            return False

        logger.info(f"✅ Valid SAS URL with proper expiry: {url[:100]}...")
        return True
    except Exception as e:
        logger.error(f"Error validating SAS URL: {e}")
        return False

class AzureBlobUploader:
    """A centralized class for handling uploads and SAS URL generation for Azure Blob Storage."""
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super(AzureBlobUploader, cls).__new__(cls)
            cls._instance._initialized = False
        return cls._instance

    def __init__(self):
        if self._initialized:
            return
        
        self.connection_string = os.getenv("AZURE_STORAGE_CONNECTION_STRING")
        self.container_name = os.getenv("AZURE_BLOB_CONTAINER", "autogentempfiles")
        
        if not self.connection_string:
            raise ValueError("AZURE_STORAGE_CONNECTION_STRING environment variable is required")

        try:
            self.blob_service_client = BlobServiceClient.from_connection_string(self.connection_string)
            parts = {k: v for k, v in (item.split('=', 1) for item in self.connection_string.split(';') if '=' in item)}
            self.account_name = parts.get('AccountName')
            self.account_key = parts.get('AccountKey')
            if not self.account_name or not self.account_key:
                raise ValueError("Connection string must contain AccountName and AccountKey")
            self._initialized = True
            self.ensure_container_exists()
        except Exception as e:
            raise ValueError(f"Invalid Azure Storage connection string or configuration error: {e}")

    def ensure_container_exists(self):
        """Ensures the blob container exists, creating it if necessary."""
        try:
            self.blob_service_client.create_container(self.container_name)
            logger.info(f"Container '{self.container_name}' created.")
        except AzureError as e:
            if "ContainerAlreadyExists" not in str(e):
                raise

    def generate_sas_url(self, blob_name: str) -> str:
        """Generates a 30-day read-only SAS URL for a specific blob."""
        sas_token = generate_blob_sas(
            account_name=self.account_name,
            container_name=self.container_name,
            blob_name=blob_name,
            account_key=self.account_key,
            permission=BlobSasPermissions(read=True),
            expiry=datetime.utcnow() + timedelta(days=30)
        )
        return f"https://{self.account_name}.blob.core.windows.net/{self.container_name}/{blob_name}?{sas_token}"

    def upload_file(self, file_path: str, blob_name: str = None) -> dict:
        """Uploads a local file and returns a dictionary with the SAS URL."""
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"File not found: {file_path}")

        if blob_name is None:
            blob_name = os.path.basename(file_path)

        blob_client = self.blob_service_client.get_blob_client(container=self.container_name, blob=blob_name)
        with open(file_path, "rb") as data:
            blob_client.upload_blob(data, overwrite=True)
        
        logger.info(f"Uploaded file: {file_path} -> {blob_name}")
        
        sas_url = self.generate_sas_url(blob_name)
        
        if not _validate_sas_url(sas_url):
            raise Exception("Generated SAS URL failed validation.")
        
        return {"blob_name": blob_name, "download_url": sas_url}

# Keep a single function for external calls to use the singleton uploader
def upload_file_to_azure_blob(file_path: str, blob_name: str = None) -> str:
    """
    Uploads a file to Azure Blob Storage and returns a JSON string with the download URL.
    This function uses the singleton AzureBlobUploader instance.

    Reference local files in absolute path.

    """
    try:
        uploader = AzureBlobUploader()
        result = uploader.upload_file(file_path, blob_name)
        logger.info(f"✅ Successfully uploaded and got SAS URL for {file_path}")
        return json.dumps(result)
    except Exception as e:
        logger.error(f"❌ Failed to upload {file_path}. Error: {e}", exc_info=True)
        return json.dumps({"error": str(e)})

# This function is no longer needed as the class handles text uploads if necessary,
# and direct calls should go through the singleton.
# def upload_text_to_azure_blob(content: str, blob_name: str) -> dict:
#     ... 