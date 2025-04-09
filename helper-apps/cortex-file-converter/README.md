# Keynote to PDF Conversion Utilities

This directory contains utilities related to converting Apple Keynote (`.key`) files to PDF format, particularly focusing on processing files stored in Azure Blob Storage.

## `process_azure_keynotes.py`

### Purpose

This script connects to an Azure Blob Storage container (specified by the `AZURE_STORAGE_CONTAINER` environment variable), searches for Keynote (`.key`) files, converts them to PDF format if a PDF version doesn't already exist, and uploads the resulting PDF back to the same location in the container.

### Functionality

1.  **Connects** to the Azure Blob Storage account specified by the `AZURE_STORAGE_CONNECTION_STRING` environment variable.
2.  **Lists** all blobs within the container specified by the `AZURE_STORAGE_CONTAINER` environment variable.
3.  **Identifies** `.key` files.
4.  **Checks** if a corresponding `.pdf` file (with the same base name) already exists in the container.
5.  **Skips** processing if the `.pdf` file already exists.
6.  **Downloads** the `.key` file to a temporary local directory if no `.pdf` exists.
7.  **Converts** the downloaded `.key` file to PDF using an embedded AppleScript function (adapted from `key_to_pdf.py`). This conversion uses the "Good" image quality setting to potentially reduce file size.
8.  **Uploads** the generated `.pdf` file back to the original path within the Azure container, replacing the `.key` extension with `.pdf`.
9.  **Logs** progress, skips, and any errors encountered during the process.
10. **Prints** a summary report upon completion.

### Prerequisites

*   **macOS:** The script relies on AppleScript to interact with the Keynote application.
*   **Keynote Application:** Apple Keynote must be installed.
*   **Python 3.x:** The script is written for Python 3.
*   **Python Libraries:** Requires the `azure-storage-blob` library. Install dependencies using the main `requirements.txt` file in the project root: `pip install -r ../../requirements.txt` (adjust path as necessary relative to the main project root).
*   **Azure Connection String:** The environment variable `AZURE_STORAGE_CONNECTION_STRING` must be set to a valid connection string for the Azure Storage account containing the target container.
*   **Azure Container Name:** The environment variable `AZURE_STORAGE_CONTAINER` must be set to the name of the target container.
*   **Automation Permissions:** You might need to grant permission for your terminal application (e.g., Terminal, iTerm) or Python itself to control Keynote. Check `System Settings` > `Privacy & Security` > `Automation`.

### Usage

1.  Ensure all prerequisites are met.
2.  Navigate to the main project root directory in your terminal.
3.  Set the Azure connection string environment variable:
    ```bash
    export AZURE_STORAGE_CONNECTION_STRING="<your_azure_storage_connection_string>"
    export AZURE_STORAGE_CONTAINER="<your_target_container_name>"
    ```
4.  Run the script:
    ```bash
    python helper-apps/cortex-file-converter/process_azure_keynotes.py
    ```

## `key_to_pdf.py`

This is a standalone command-line utility for converting a single local Keynote file to PDF using AppleScript. It was the basis for the conversion logic now embedded within `process_azure_keynotes.py`.

### Usage (Standalone)

```bash
python helper-apps/cortex-file-converter/key_to_pdf.py <input_keynote_file.key> [-o <output_pdf_file.pdf>]
```

If the output path (`-o`) is omitted, the PDF will be saved in the same directory as the input file with a `.pdf` extension.

## `list_blob_extensions.py`

### Purpose

This script connects to an Azure Blob Storage container (specified by the `AZURE_STORAGE_CONTAINER` environment variable), lists all the blobs within it, and reports the unique file extensions found. It also marks extensions known to be typically unsupported for content cracking by the default Azure Cognitive Search indexer configuration.

### Functionality

1.  **Connects** to the Azure Blob Storage account specified by the `AZURE_STORAGE_CONNECTION_STRING` environment variable and the container specified by `AZURE_STORAGE_CONTAINER`.
2.  **Lists** all blobs within the specified container.
3.  **Extracts** the file extension from each blob name.
4.  **Collects** all unique extensions found.
5.  **Prints** a list of unique extensions, marking those present in its predefined `UNSUPPORTED_EXTENSIONS_KNOWN` set.

### Prerequisites

*   **Python 3.x:** The script is written for Python 3.
*   **Python Libraries:** Requires the `azure-storage-blob` library. Install dependencies using: `pip install -r requirements.txt`.
*   **Azure Connection String:** The environment variable `AZURE_STORAGE_CONNECTION_STRING` must be set.
*   **Azure Container Name:** The environment variable `AZURE_STORAGE_CONTAINER` must be set to the name of the target container.

### Usage

1.  Ensure all prerequisites are met.
2.  Navigate to the `helper-apps/cortex-file-converter` directory in your terminal.
3.  Set the required environment variables:
    ```bash
    export AZURE_STORAGE_CONNECTION_STRING="<your_azure_storage_connection_string>"
    export AZURE_STORAGE_CONTAINER="<your_target_container_name>"
    ```
4.  Run the script:
    ```bash
    python list_blob_extensions.py
    ``` 