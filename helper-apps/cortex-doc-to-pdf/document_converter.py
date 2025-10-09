"""Document conversion logic - handles both URI and stream-based conversions."""

import logging
import tempfile
import os
import urllib.request
import urllib.parse
from pathlib import Path
import shutil
from converter import DocumentConverter


async def convert_from_uri(uri: str) -> dict:
    """
    Convert a document from a URI to PDF.
    
    Args:
        uri: URL of the document to convert
        
    Returns:
        dict with 'success', 'data' (PDF bytes), 'filename', or 'error' keys
    """
    try:
        converter = DocumentConverter()
        
        logging.info(f"Downloading document from: {uri}")
        
        # Parse filename from URI
        parsed_url = urllib.parse.urlparse(uri)
        filename = os.path.basename(parsed_url.path)
        if not filename or '.' not in filename:
            filename = "document.pdf"
        
        # Create temporary directory for processing
        temp_dir = tempfile.mkdtemp()
        
        try:
            # Download file
            input_path = os.path.join(temp_dir, filename)
            
            try:
                urllib.request.urlretrieve(uri, input_path)
            except Exception as e:
                logging.error(f"Failed to download file: {str(e)}")
                return {
                    "success": False,
                    "error": "Failed to download document",
                    "details": str(e)
                }
            
            logging.info(f"Document downloaded to: {input_path}")
            
            # Check if file extension is supported
            file_ext = Path(input_path).suffix.lower()
            if not converter.is_supported_format(file_ext):
                return {
                    "success": False,
                    "error": "Unsupported file format",
                    "format": file_ext,
                    "supported_formats": converter.get_supported_formats()
                }
            
            # Convert to PDF
            logging.info(f"Converting {file_ext} document to PDF...")
            pdf_path = converter.convert_to_pdf(input_path, temp_dir)
            
            if not pdf_path or not os.path.exists(pdf_path):
                return {
                    "success": False,
                    "error": "Conversion failed",
                    "message": "The document could not be converted to PDF"
                }
            
            # Read the PDF file
            with open(pdf_path, 'rb') as pdf_file:
                pdf_data = pdf_file.read()
            
            # Generate output filename
            output_filename = Path(filename).stem + ".pdf"
            
            logging.info(f"Conversion successful. PDF size: {len(pdf_data)} bytes")
            
            return {
                "success": True,
                "data": pdf_data,
                "filename": output_filename
            }
        
        finally:
            # Cleanup temp directory
            try:
                shutil.rmtree(temp_dir, ignore_errors=True)
            except Exception as e:
                logging.warning(f"Failed to cleanup temp directory: {e}")
    
    except Exception as e:
        logging.error(f"Error during conversion: {str(e)}", exc_info=True)
        return {
            "success": False,
            "error": "Conversion error",
            "details": str(e)
        }


async def convert_from_stream(file_data: bytes, filename: str) -> dict:
    """
    Convert a document from uploaded file data to PDF.
    
    Args:
        file_data: Binary file data
        filename: Original filename (used to determine format)
        
    Returns:
        dict with 'success', 'data' (PDF bytes), 'filename', or 'error' keys
    """
    try:
        converter = DocumentConverter()
        
        logging.info(f"Converting uploaded file: {filename} ({len(file_data)} bytes)")
        
        # Create temporary directory for processing
        temp_dir = tempfile.mkdtemp()
        
        try:
            # Save uploaded file
            input_path = os.path.join(temp_dir, filename)
            with open(input_path, 'wb') as f:
                f.write(file_data)
            
            logging.info(f"Saved uploaded file to: {input_path}")
            
            # Check if file extension is supported
            file_ext = Path(input_path).suffix.lower()
            if not converter.is_supported_format(file_ext):
                return {
                    "success": False,
                    "error": "Unsupported file format",
                    "format": file_ext,
                    "supported_formats": converter.get_supported_formats()
                }
            
            # Convert to PDF
            logging.info(f"Converting {file_ext} document to PDF...")
            pdf_path = converter.convert_to_pdf(input_path, temp_dir)
            
            if not pdf_path or not os.path.exists(pdf_path):
                return {
                    "success": False,
                    "error": "Conversion failed",
                    "message": "The document could not be converted to PDF"
                }
            
            # Read the PDF file
            with open(pdf_path, 'rb') as pdf_file:
                pdf_data = pdf_file.read()
            
            # Generate output filename
            output_filename = Path(filename).stem + ".pdf"
            
            logging.info(f"Conversion successful. PDF size: {len(pdf_data)} bytes")
            
            return {
                "success": True,
                "data": pdf_data,
                "filename": output_filename
            }
        
        finally:
            # Cleanup temp directory
            try:
                shutil.rmtree(temp_dir, ignore_errors=True)
            except Exception as e:
                logging.warning(f"Failed to cleanup temp directory: {e}")
    
    except Exception as e:
        logging.error(f"Error during conversion: {str(e)}", exc_info=True)
        return {
            "success": False,
            "error": "Conversion error",
            "details": str(e)
        }
