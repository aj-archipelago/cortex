# Markitdown Azure Function Converter

This Azure Function App provides an HTTP endpoint to convert various file formats (specified by a URI) to Markdown using the `microsoft/markitdown` Python library.

## Function: MarkitdownConverterFunction

*   **Trigger**: HTTP (GET, POST)
*   **Route**: `/api/convert` (or as configured by your Azure Function host settings)
*   **Authentication**: Anonymous (can be changed in `function.json`)

### Input

The function expects a `uri` parameter, either in the query string (for GET requests) or in the JSON body (for POST requests).

**Example GET Request:**
```
GET /api/convert?uri=https://www.example.com/somefile.pdf
```

**Example POST Request:**
```
POST /api/convert
Content-Type: application/json

{
  "uri": "https://www.example.com/somefile.docx"
}
```

### Output

*   **Success (200 OK):** Returns a JSON object containing the original URI and the converted Markdown content.
    ```json
    {
      "uri": "https://www.example.com/somefile.pdf",
      "markdown": "# Converted Markdown Content\n..."
    }
    ```
*   **Bad Request (400):** If the `uri` parameter is missing.
*   **Internal Server Error (500):** If an error occurs during the conversion process. The response will contain an error message and details.
    ```json
    {
        "error": "Failed to convert URI to Markdown.",
        "details": "<specific error message from the library>"
    }
    ```

## Project Structure

```
cortex-markitdown/
├── MarkitdownConverterFunction/
│   ├── __init__.py       # The Python code for the Azure Function
│   └── function.json     # Configuration file for the Azure Function (bindings, triggers)
├── .gitignore            # Standard Python .gitignore
├── host.json             # Configuration for the Azure Functions host
├── requirements.txt      # Python package dependencies
└── README.md             # This file
```

## Prerequisites

*   Azure Functions Core Tools
*   Python 3.8+ (check Azure Functions Python version compatibility)
*   An Azure account (for deployment)

## Setup and Local Development

1.  **Clone the repository (if applicable).**
2.  **Create and activate a virtual environment:**
    ```bash
    python -m venv .venv
    source .venv/bin/activate  # On Windows use `.venv\Scripts\activate`
    ```
3.  **Install dependencies:**
    ```bash
    pip install -r requirements.txt
    ```
4.  **Run the Azure Function locally:**
    ```bash
    func start
    ```
    The function should be available at `http://localhost:7071/api/convert` (the port might vary).

## Dependencies

*   `azure-functions`: For creating Azure Functions.
*   `markitdown[all]`: The core library used for file conversion to Markdown. The `[all]` option installs all optional dependencies for handling various file types.

## Notes

*   The `MarkItDown` instance in `__init__.py` is initialized with `enable_plugins=True` to allow for extended file format support through plugins.
*   For handling images that require OCR or descriptions, the `markitdown` library might need an LLM client (e.g., OpenAI) configured. This is not included in the basic setup provided but can be added by modifying the `MarkItDown()` instantiation in `__init__.py` and ensuring the necessary environment variables (like API keys) are available to the function.
*   Ensure that the URIs provided to the function are publicly accessible or accessible from the environment where the Azure Function is running. 