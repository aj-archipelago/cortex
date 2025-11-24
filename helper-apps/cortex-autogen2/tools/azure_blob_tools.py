#!/usr/bin/env python3
"""
Azure Blob Storage tools for uploading task files and generating SAS URLs.
"""
import os
import json
import logging
import mimetypes
import uuid
import time
import hashlib
import re
import unicodedata
from datetime import datetime, timedelta
from typing import List, Union
from urllib.parse import urlparse, parse_qs, quote
from azure.storage.blob import BlobServiceClient, generate_blob_sas, BlobSasPermissions, ContentSettings
from azure.core.exceptions import AzureError, ServiceResponseError
import requests

logger = logging.getLogger(__name__)

def _sanitize_blob_name(filename: str) -> str:
    """
    Sanitize filename to be Azure Blob Storage safe.
    Removes special characters and converts to ASCII-safe format.
    """
    # Normalize unicode characters (e.g., é -> e)
    normalized = unicodedata.normalize('NFKD', filename)
    # Remove accents/diacritics
    ascii_str = normalized.encode('ascii', 'ignore').decode('ascii')
    # Replace any remaining problematic characters with underscore
    # Keep only: alphanumeric, dots, dashes, underscores
    safe_name = re.sub(r'[^a-zA-Z0-9._-]', '_', ascii_str)
    # Remove consecutive underscores
    safe_name = re.sub(r'_+', '_', safe_name)
    # Remove leading/trailing underscores or dots
    safe_name = safe_name.strip('_.')
    # Prevent empty filename (e.g., if all chars were special)
    if not safe_name:
        return "file"
    return safe_name

# Ensure correct MIME types for Office files, especially PPT/PPTX, for proper downloads in browsers
try:
    mimetypes.add_type("application/vnd.openxmlformats-officedocument.presentationml.presentation", ".pptx", strict=False)
    mimetypes.add_type("application/vnd.ms-powerpoint", ".ppt", strict=False)
except Exception:
    pass

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

        # Removed verbose SAS URL validation logging
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
        # In-memory deduplication cache: sha256 -> blob_name
        self._sha256_to_blob: dict = {}
        
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
        # Ensure blob_name has no leading slashes
        clean_name = blob_name.lstrip('/')
        
        # Validate inputs
        if not clean_name:
            raise ValueError("Blob name cannot be empty")
        if not self.account_name or not self.account_key:
            raise ValueError("Azure Storage account name and key must be set")
        
        try:
            # Use blob client to get the base URL - this ensures correct URL construction
            blob_client = self.blob_service_client.get_blob_client(container=self.container_name, blob=clean_name)
            
            # Generate SAS token using the exact blob name as stored
            sas_token = generate_blob_sas(
                account_name=self.account_name,
                container_name=self.container_name,
                blob_name=clean_name,
                account_key=self.account_key,
                permission=BlobSasPermissions(read=True),
                expiry=datetime.utcnow() + timedelta(days=30)
            )
            
            if not sas_token:
                raise ValueError("Failed to generate SAS token")
            
            # Use blob client's URL property to get the correctly formatted base URL
            # This ensures the blob name is properly handled in the URL path
            base_url = blob_client.url
            # Append SAS token to the base URL
            sas_url = f"{base_url}?{sas_token}"
            
            # Validate the generated URL
            if not _validate_sas_url(sas_url):
                logger.error(f"❌ Generated SAS URL failed validation: {sas_url[:100]}...")
                raise ValueError("Generated SAS URL failed validation")
            
            logger.info(f"✅ Generated SAS URL for blob: {clean_name[:50]}...")
            return sas_url
        except Exception as e:
            logger.error(f"❌ Error generating SAS URL for blob '{clean_name}': {e}", exc_info=True)
            raise

    def upload_file(self, file_path: str, blob_name: str = None) -> dict:
        """Uploads a local file and returns a dictionary with the SAS URL. Retries on transient errors."""
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"File not found: {file_path}")

        # Determine if we should preserve the exact filename or add timestamp/UUID
        preserve = (os.getenv("PRESERVE_BLOB_FILENAME", "false").lower() in ("1", "true", "yes"))
        prefix = (os.getenv("AZURE_BLOB_PREFIX") or "").strip().strip("/")

        if blob_name is None:
            # Use original filename from file_path
            original_base = os.path.basename(file_path)
            name, ext = os.path.splitext(original_base)
        else:
            # Use provided blob_name (might have path components)
            # Extract just the filename part
            blob_base = os.path.basename(blob_name)
            name, ext = os.path.splitext(blob_base)
            # Keep any directory prefix from blob_name
            blob_dir = os.path.dirname(blob_name).strip('/')
            if blob_dir:
                prefix = f"{prefix}/{blob_dir}" if prefix else blob_dir

        # Sanitize filename to be Azure Blob safe (remove special chars like é, ñ, etc.)
        name = _sanitize_blob_name(name)
        # Extension already starts with dot, just sanitize the part after the dot
        if ext:
            ext_without_dot = ext.lstrip('.')
            sanitized_ext = _sanitize_blob_name(ext_without_dot)
            ext = f".{sanitized_ext}" if sanitized_ext else ext

        # Add timestamp+UUID suffix unless preserve flag is set
        if preserve:
            final_name = f"{name}{ext}"
        else:
            timestamp = datetime.utcnow().strftime("%Y%m%dT%H%M%SZ")
            short_id = uuid.uuid4().hex[:8]
            final_name = f"{name}__{timestamp}_{short_id}{ext}"

        # Construct final blob_name with prefix if provided
        blob_name = f"{prefix}/{final_name}" if prefix else final_name

        # Normalize any accidental leading slashes in blob path
        normalized_blob_name = blob_name.lstrip("/")
        blob_client = self.blob_service_client.get_blob_client(container=self.container_name, blob=normalized_blob_name)

        # Detect content type for better browser handling
        content_type, _ = mimetypes.guess_type(file_path)
        if not content_type:
            content_type = "application/octet-stream"
        content_settings = ContentSettings(content_type=content_type)

        # Hint SDK to use smaller single-put and block sizes to avoid timeouts on moderate networks
        try:
            if hasattr(blob_client, "_config"):
                if hasattr(blob_client._config, "max_single_put_size"):
                    blob_client._config.max_single_put_size = 4 * 1024 * 1024  # 4 MB
                if hasattr(blob_client._config, "max_block_size"):
                    blob_client._config.max_block_size = 4 * 1024 * 1024  # 4 MB
        except Exception:
            pass

        # Compute sha256 to deduplicate repeat uploads during same process lifetime
        sha256_hex = None
        try:
            hasher = hashlib.sha256()
            with open(file_path, "rb") as fh:
                for chunk in iter(lambda: fh.read(1024 * 1024), b""):
                    hasher.update(chunk)
            sha256_hex = hasher.hexdigest()
            if sha256_hex in self._sha256_to_blob:
                # Return prior URL for identical content
                prior_blob = self._sha256_to_blob[sha256_hex]
                sas_url = self.generate_sas_url(prior_blob)
                return {"blob_name": prior_blob, "download_url": sas_url, "deduplicated": True}
        except Exception:
            sha256_hex = None

        # Simple upload; SDK will handle block uploads automatically for large blobs
        with open(file_path, "rb") as data:
            blob_client.upload_blob(
                data,
                overwrite=True,
                content_settings=content_settings,
                max_concurrency=4,
                timeout=900,
            )
        # Removed individual file upload logging
        sas_url = self.generate_sas_url(normalized_blob_name)
        if not _validate_sas_url(sas_url):
            raise Exception("Generated SAS URL failed validation.")
        if sha256_hex:
            try:
                self._sha256_to_blob[sha256_hex] = normalized_blob_name
            except Exception:
                pass
        # CRITICAL: Return normalized_blob_name (what was actually uploaded) not the original blob_name variable
        return {"blob_name": normalized_blob_name, "download_url": sas_url}

# Keep a single function for external calls to use the singleton uploader
def upload_file_to_azure_blob(file_path: str, blob_name: str = None) -> str:
    """
    Uploads a file to Azure Blob Storage with automatic retry on transient failures.
    Returns a JSON string with the download URL.
    """
    max_attempts = 3
    retry_delay = 3

    for attempt in range(1, max_attempts + 1):
        try:
            uploader = AzureBlobUploader()
            result = uploader.upload_file(file_path, blob_name)
            # Removed individual upload logging - use batch upload for summary logging
            return json.dumps(result)
        except Exception as e:
            if attempt < max_attempts:
                logger.warning(f"⚠️ Upload attempt {attempt}/{max_attempts} failed for {file_path}: {e}. Retrying in {retry_delay}s...")
                time.sleep(retry_delay)
            else:
                logger.error(f"❌ Upload failed after {max_attempts} attempts for {file_path}: {e}", exc_info=True)
                return json.dumps({"error": str(e)})

def upload_files(file_paths: Union[str, List[str]], work_dir: str = None) -> dict:
    """
    Unified file upload function - handles single files or multiple files.

    Args:
        file_paths: Single file path (str) or list of file paths to upload
        work_dir: Optional working directory for resolving relative paths

    Returns:
        Dict with upload results containing local filenames and download URLs
    """
    # Handle single file case - convert to list
    if isinstance(file_paths, str):
        file_paths = [file_paths]

    if not file_paths:
        return {"success": False, "error": "No file paths provided", "uploads": [], "failed": []}

    results = []
    failed = []

    for file_path in file_paths:
        try:
            # Resolve relative paths using work_dir if provided
            resolved_path = file_path
            if work_dir and not os.path.isabs(file_path):
                # Try different path resolution strategies
                candidate_path = os.path.join(work_dir, file_path)
                if os.path.exists(candidate_path):
                    resolved_path = candidate_path
                else:
                    # Try just the filename in work_dir
                    filename = os.path.basename(file_path)
                    candidate_path = os.path.join(work_dir, filename)
                    if os.path.exists(candidate_path):
                        resolved_path = candidate_path
                    else:
                        # Search work_dir for the file
                        if os.path.exists(work_dir):
                            for root, dirs, files in os.walk(work_dir):
                                if filename in files:
                                    resolved_path = os.path.join(root, filename)
                                    break

            # Validate file exists and is readable
            if not os.path.exists(resolved_path):
                error_msg = f"File not found: {file_path}"
                logger.error(f"❌ {error_msg}")
                failed.append({"file": file_path, "error": error_msg})
                continue

            if not os.access(resolved_path, os.R_OK):
                error_msg = f"File not readable: {file_path}"
                logger.error(f"❌ {error_msg}")
                failed.append({"file": file_path, "error": error_msg})
                continue

            # Upload file
            uploader = AzureBlobUploader()
            result = uploader.upload_file(resolved_path)

            if result and "download_url" in result:
                results.append({
                    "local_filename": os.path.basename(resolved_path),
                    "local_path": resolved_path,
                    "blob_name": result.get("blob_name", os.path.basename(resolved_path)),
                    "download_url": result["download_url"]
                })
                logger.info(f"✅ Uploaded {os.path.basename(resolved_path)}")
            else:
                error_msg = f"Upload failed: {result.get('error', 'Unknown error')}"
                logger.error(f"❌ {error_msg}")
                failed.append({"file": file_path, "error": error_msg})

        except Exception as e:
            error_msg = f"Upload error: {str(e)[:100]}"
            logger.error(f"❌ {error_msg}")
            failed.append({"file": file_path, "error": error_msg})

    # Summary logging
    success_count = len(results)
    fail_count = len(failed)

    if success_count > 0:
        logger.info(f"📦 Upload complete: {success_count} succeeded, {fail_count} failed")

    return {
        "success": success_count > 0,
        "uploads": results,
        "failed": failed,
        "total_uploaded": success_count,
        "total_failed": fail_count
    }

# This function is no longer needed as the class handles text uploads if necessary,
# and direct calls should go through the singleton.
# def upload_text_to_azure_blob(content: str, blob_name: str) -> dict:
#     ... 