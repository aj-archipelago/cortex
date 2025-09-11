import os
import subprocess
import sys
import tempfile
from azure.storage.blob import BlobServiceClient, BlobClient, ContainerClient
from pathlib import Path

# --- Conversion Function (Adapted from key_to_pdf.py) ---
class ConversionError(Exception):
    """Custom exception for conversion failures."""
    pass

def convert_key_to_pdf(key_path, pdf_path):
    """
    Converts a Keynote file (.key) to PDF using AppleScript.
    Raises FileNotFoundError if input doesn't exist.
    Raises ConversionError if AppleScript execution fails.
    """
    if not os.path.exists(key_path):
        raise FileNotFoundError(f"Input Keynote file not found: {key_path}")

    # Ensure the output directory exists
    output_dir = os.path.dirname(pdf_path)
    if output_dir and not os.path.exists(output_dir):
        try:
            os.makedirs(output_dir)
        except OSError as e:
            # Raise an error if we can't create the output dir
            raise ConversionError(f"Cannot create output directory {output_dir}: {e}") 

    # Check if output PDF exists and delete it (optional, might be handled by caller)
    # if os.path.exists(pdf_path):
    #     try:
    #         os.remove(pdf_path)
    #     except OSError as e:
    #         raise ConversionError(f"Cannot remove existing output file {pdf_path}: {e}")

    applescript = f'''
    tell application "Keynote"
        try
            set theDocument to open POSIX file "{key_path}"
            if not (exists theDocument) then error "Failed to open document."

            set pdf_export_settings to {{PDF image quality:Good}} -- Define settings as record (escaped braces)

            with timeout of 1200 seconds -- Allow 20 minutes for export
                 export theDocument to POSIX file "{pdf_path}" as PDF with properties pdf_export_settings -- Use settings record
            end timeout

            close theDocument saving no
            -- log "Successfully exported {key_path} to {pdf_path}" -- Logging handled by caller
        on error errMsg number errNum
            -- log "AppleScript Error: " & errMsg & " (Number: " & errNum & ")" -- Log detail in exception
            -- Try to quit Keynote even if there was an error during export/close
            try
                if exists theDocument then
                    close theDocument saving no
                end if
            end try
            error "Keynote conversion failed: " & errMsg number errNum
        end try
        -- Optional: Quit Keynote after conversion
        -- quit
    end tell
    '''

    try:
        # Using osascript to run the AppleScript
        process = subprocess.run(['osascript', '-e', applescript], 
                                 capture_output=True, text=True, check=False, timeout=1260) # check=False
        
        if process.returncode != 0:
            # Raise an error with details from AppleScript failure
            raise ConversionError(f"AppleScript execution failed (Code {process.returncode}) for {key_path}. stderr: {process.stderr.strip()}")

        # Final check if PDF exists after successful run
        if not os.path.exists(pdf_path):
            raise ConversionError(f"Conversion reported success but output PDF not found: {pdf_path}")

    except subprocess.TimeoutExpired:
        raise ConversionError(f"AppleScript execution timed out for {key_path}")
    except Exception as e:
        # Catch any other unexpected Python errors during subprocess handling
        raise ConversionError(f"An unexpected error occurred during conversion process for {key_path}: {e}")

# --- Main Azure Processing Logic ---

def main():
    # --- Configuration ---
    try:
        connection_string = os.environ["AZURE_STORAGE_CONNECTION_STRING"]
        container_name = os.environ["AZURE_STORAGE_CONTAINER"]
    except KeyError as e:
        print(f"Error: Required environment variable {e} is not set.", file=sys.stderr)
        sys.exit(1)
        

    print(f"Connecting to Azure Blob Storage container: {container_name}")
    try:
        blob_service_client = BlobServiceClient.from_connection_string(connection_string)
        container_client = blob_service_client.get_container_client(container_name)
        # Check if container exists by trying to get properties
        container_client.get_container_properties() 
    except Exception as e:
        print(f"Error connecting to or accessing container '{container_name}': {e}", file=sys.stderr)
        sys.exit(1)

    print("Listing blobs...")
    all_blob_names = set()
    try:
        blob_list = container_client.list_blobs()
        for blob in blob_list:
            all_blob_names.add(blob.name)
        print(f"Found {len(all_blob_names)} blobs in total.")
    except Exception as e:
        print(f"Error listing blobs in container '{container_name}': {e}", file=sys.stderr)
        sys.exit(1)

    print("Starting processing...")
    processed_count = 0
    skipped_count = 0
    error_count = 0

    for blob_name in all_blob_names:
        if blob_name.lower().endswith(".key"):
            print(f"Found Keynote file: {blob_name}")
            pdf_blob_name = Path(blob_name).with_suffix(".pdf").as_posix() # Generate corresponding PDF name

            if pdf_blob_name in all_blob_names:
                print(f"  -> PDF version already exists: {pdf_blob_name}. Skipping.")
                skipped_count += 1
                continue
            
            print(f"  -> PDF version not found. Attempting conversion.")
            
            # Use a temporary directory for download and conversion
            with tempfile.TemporaryDirectory() as temp_dir:
                local_key_path = os.path.join(temp_dir, os.path.basename(blob_name))
                local_pdf_path = Path(local_key_path).with_suffix(".pdf").as_posix()
                
                try:
                    # 1. Download .key file
                    print(f"    Downloading {blob_name} to {local_key_path}...")
                    blob_client = container_client.get_blob_client(blob_name)
                    with open(local_key_path, "wb") as download_file:
                        download_stream = blob_client.download_blob()
                        download_file.write(download_stream.readall())
                    print("    Download complete.")

                    # 2. Convert .key to .pdf (using local function)
                    print(f"    Converting {local_key_path} to {local_pdf_path}...")
                    try:
                        convert_key_to_pdf(local_key_path, local_pdf_path)
                        print("    Conversion successful.")
                    except (FileNotFoundError, ConversionError) as convert_err:
                        print(f"    ERROR: Conversion failed for {local_key_path}: {convert_err}", file=sys.stderr)
                        error_count += 1
                        continue # Skip upload if conversion failed
                    
                    # 3. Upload .pdf file
                    print(f"    Uploading {local_pdf_path} to {pdf_blob_name}...")
                    pdf_blob_client = container_client.get_blob_client(pdf_blob_name)
                    with open(local_pdf_path, "rb") as upload_file:
                        pdf_blob_client.upload_blob(upload_file, overwrite=True, timeout=600) # Increased timeout to 10 mins
                    print("    Upload complete.")
                    processed_count += 1

                except Exception as e:
                    print(f"    ERROR processing file {blob_name}: {e}", file=sys.stderr)
                    error_count += 1
                
                # Temporary directory and its contents are automatically cleaned up here

    print("-"*30)
    print("Processing complete.")
    print(f"Successfully converted and uploaded: {processed_count}")
    print(f"Skipped (PDF already exists):      {skipped_count}")
    print(f"Errors encountered:                 {error_count}")

if __name__ == "__main__":
    main() 