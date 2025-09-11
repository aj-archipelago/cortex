# Cortex Azure Cleaner

This helper app deletes specific data from an Azure Cognitive Search index.

## Configuration

Before running the script, you need to set up your Azure credentials. Create a `.env` file in this directory (`helper-apps/cortex-azure-cleaner`) with the following content:

```
# Azure Cognitive Search configuration
AZURE_COGNITIVE_API_URL=your_azure_search_endpoint
AZURE_COGNITIVE_API_KEY=your_azure_search_api_key
```

Replace `your_azure_search_endpoint` and `your_azure_search_api_key` with your actual Azure Search endpoint and admin key.

## Installation

Navigate to this directory and install the dependencies:

```bash
cd helper-apps/cortex-azure-cleaner
npm install
```

## Usage

The script is pre-configured to delete documents with the title "AJ+ Notes on QA Editorial Guidelines.docx" from the "vector-tony-vision-resource" index.

To run the script:

```bash
npm start
```

The script will search for documents matching the title, log them to the console, and then delete them. 