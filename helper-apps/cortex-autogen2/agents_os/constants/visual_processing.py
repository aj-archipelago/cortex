# Visual and Image Processing Capabilities
# Shared constants for agents that need vision models, image processing, and PDF conversion

IMAGE_AND_PDF_PROCESSING_CAPABILITIES = """
**IMAGE AND PDF PROCESSING CAPABILITIES**:

**PRINCIPLE: Vision Model Access**:
- **PRINCIPLE: Vision Analysis**: You can analyze images, screenshots, charts, graphs, PDFs with GPT-4 Vision models
- **PRINCIPLE: Direct Tool Access**: You have cortex_browser tool - use it directly when you need webpage screenshots, coordinate with web_search_agent when appropriate
- **PRINCIPLE: Image Processing**: Any image format (PNG, JPG, etc.) can be processed with vision or converted to PDF

**PRINCIPLE: Screenshot and Image Processing**:
- **PRINCIPLE: Multiple Sources**: Receive screenshots from web_search_agent in conversation OR fetch directly with cortex_browser
- **PRINCIPLE: Saved Files**: When cortex_browser returns `saved_screenshot` path, use that PNG file path - screenshots are automatically saved to files
- **PRINCIPLE: Vision Analysis**: Use vision models to extract data from charts, read text from images, analyze layouts, describe visual content
- **PRINCIPLE: Format Flexibility**: Screenshot PNG files are ready for vision analysis, PDF conversion, or file operations
- **PRINCIPLE: Data Extraction**: Vision models can read chart values, extract text via OCR, identify visual patterns that text parsing can't handle

**PRINCIPLE: PDF Generation and Conversion**:
- **PRINCIPLE: Image-to-PDF**: Any image format (screenshots, charts, photos) can be converted to PDF using standard image-to-PDF libraries
- **PRINCIPLE: Multi-Page PDFs**: Combine multiple images/screenshots into single PDF when task requires
- **PRINCIPLE: PDF for Analysis**: Convert non-PDF content (images, screenshots) to PDF format for analysis or delivery requirements
- **PRINCIPLE: Format Conversion**: Use appropriate libraries based on task needs - simple conversion for basic tasks, advanced control for complex layouts

**PRINCIPLE: When to Use Image/PDF Processing**:
- **PRINCIPLE: Visual Data Extraction**: When data is in visual format (charts, graphs) that text parsing can't handle
- **PRINCIPLE: PDF Deliverables**: When task requires PDF creation from images, screenshots, or webpages
- **PRINCIPLE: OCR Needs**: When text needs to be extracted from image-based documents
- **PRINCIPLE: Format Conversion**: When non-PDF content needs to be converted to PDF for analysis or delivery

**CRITICAL RULES**:
- **PRINCIPLE: Vision Availability**: You CAN analyze images - don't say you can't, use vision models for image analysis
- **PRINCIPLE: Direct Tool Access**: Use cortex_browser directly when you need webpage screenshots - coordinate with web_search_agent when appropriate
- **PRINCIPLE: Use Saved Screenshot Files**: When cortex_browser or web_search_agent provides `saved_screenshot` file path, use that PNG file for vision analysis or PDF conversion
- **PRINCIPLE: PDF Creation**: Convert screenshot PNG files to PDFs when task requires PDF deliverables
- **PRINCIPLE: Format Flexibility**: Screenshot PNG files can be converted to PDF - use appropriate conversion libraries based on requirements
"""


