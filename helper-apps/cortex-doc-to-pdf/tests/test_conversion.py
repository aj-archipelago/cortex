#!/usr/bin/env python3
"""
End-to-end tests for document to PDF conversion.
Tests actual conversion of various file formats and verifies PDF content.
"""

import os
import sys
import time
import subprocess
from pathlib import Path
import PyPDF2
from converter import DocumentConverter

# Test configuration
SAMPLES_DIR = Path(__file__).parent.parent / "samples"
OUTPUT_DIR = Path(__file__).parent.parent / "test_output"
OUTPUT_DIR.mkdir(exist_ok=True)

class Colors:
    """ANSI color codes for terminal output"""
    GREEN = '\033[92m'
    RED = '\033[91m'
    YELLOW = '\033[93m'
    BLUE = '\033[94m'
    RESET = '\033[0m'
    BOLD = '\033[1m'

def print_success(msg):
    print(f"{Colors.GREEN}✓{Colors.RESET} {msg}")

def print_error(msg):
    print(f"{Colors.RED}✗{Colors.RESET} {msg}")

def print_info(msg):
    print(f"{Colors.BLUE}ℹ{Colors.RESET} {msg}")

def print_warning(msg):
    print(f"{Colors.YELLOW}⚠{Colors.RESET} {msg}")

def extract_text_from_pdf(pdf_path):
    """Extract text content from a PDF file."""
    try:
        with open(pdf_path, 'rb') as file:
            pdf_reader = PyPDF2.PdfReader(file)
            text = ""
            for page in pdf_reader.pages:
                text += page.extract_text()
            return text.strip()
    except Exception as e:
        print_error(f"Failed to extract text from PDF: {e}")
        return None

def get_pdf_info(pdf_path):
    """Get PDF metadata and page count."""
    try:
        with open(pdf_path, 'rb') as file:
            pdf_reader = PyPDF2.PdfReader(file)
            return {
                'pages': len(pdf_reader.pages),
                'metadata': pdf_reader.metadata,
                'is_encrypted': pdf_reader.is_encrypted
            }
    except Exception as e:
        print_error(f"Failed to get PDF info: {e}")
        return None

def test_file_conversion(input_file, expected_content_snippets=None, min_pages=1):
    """
    Test conversion of a single file.
    
    Args:
        input_file: Path to the input file
        expected_content_snippets: List of strings that should appear in the PDF
        min_pages: Minimum expected number of pages
    
    Returns:
        bool: True if test passed, False otherwise
    """
    file_name = input_file.name
    file_ext = input_file.suffix
    print(f"\n{Colors.BOLD}Testing: {file_name}{Colors.RESET}")
    print(f"  Format: {file_ext}")
    
    # Initialize converter
    try:
        converter = DocumentConverter()
    except RuntimeError as e:
        print_error(f"Converter initialization failed: {e}")
        return False
    
    # Check if format is supported
    if not converter.is_supported_format(file_ext):
        print_warning(f"Format {file_ext} is not supported - SKIPPING")
        return True  # Not a failure, just unsupported
    
    # Convert to PDF
    output_file = OUTPUT_DIR / f"{input_file.stem}.pdf"
    print_info(f"Converting to: {output_file.name}")
    
    start_time = time.time()
    try:
        pdf_path = converter.convert_to_pdf(str(input_file), str(OUTPUT_DIR))
        conversion_time = time.time() - start_time
        
        if not pdf_path or not os.path.exists(pdf_path):
            print_error("Conversion failed - PDF not created")
            return False
        
        print_success(f"Converted in {conversion_time:.2f}s")
        
    except Exception as e:
        print_error(f"Conversion failed: {e}")
        return False
    
    # Verify PDF was created
    file_size = os.path.getsize(pdf_path)
    if file_size == 0:
        print_error("PDF file is empty (0 bytes)")
        return False
    
    print_info(f"PDF size: {file_size:,} bytes")
    
    # Get PDF information
    pdf_info = get_pdf_info(pdf_path)
    if not pdf_info:
        print_error("Failed to read PDF metadata")
        return False
    
    print_info(f"Pages: {pdf_info['pages']}")
    
    # Verify minimum page count
    if pdf_info['pages'] < min_pages:
        print_error(f"Expected at least {min_pages} pages, got {pdf_info['pages']}")
        return False
    
    # Extract and verify content
    if expected_content_snippets:
        print_info("Extracting and verifying content...")
        pdf_text = extract_text_from_pdf(pdf_path)
        
        if not pdf_text:
            print_warning("Could not extract text from PDF (might be image-based)")
        else:
            print_info(f"Extracted {len(pdf_text)} characters")
            
            # Check for expected content
            missing_content = []
            for snippet in expected_content_snippets:
                if snippet.lower() not in pdf_text.lower():
                    missing_content.append(snippet)
            
            if missing_content:
                print_error(f"Missing expected content: {', '.join(missing_content)}")
                return False
            else:
                print_success(f"All {len(expected_content_snippets)} content checks passed")
    
    print_success(f"✓ {file_name} conversion PASSED")
    return True

def test_text_files():
    """Test text file conversions"""
    print(f"\n{Colors.BOLD}{'='*60}{Colors.RESET}")
    print(f"{Colors.BOLD}Testing TEXT Files{Colors.RESET}")
    print(f"{Colors.BOLD}{'='*60}{Colors.RESET}")
    
    tests = [
        ("ascii-art.txt", None),
        ("data.txt", None),
        ("long-doc.txt", None),
        ("multilang.txt", None),
    ]
    
    results = []
    for file_name, expected_content in tests:
        file_path = SAMPLES_DIR / file_name
        if file_path.exists():
            results.append(test_file_conversion(file_path, expected_content))
        else:
            print_warning(f"File not found: {file_name}")
    
    return results

def test_office_documents():
    """Test Microsoft Office document conversions"""
    print(f"\n{Colors.BOLD}{'='*60}{Colors.RESET}")
    print(f"{Colors.BOLD}Testing OFFICE Documents{Colors.RESET}")
    print(f"{Colors.BOLD}{'='*60}{Colors.RESET}")
    
    tests = [
        ("file-sample_1MB.docx", ["document"], 1),
        ("file_example_XLSX_5000.xlsx", None, 1),
        ("file_example_PPT_1MB.ppt", None, 1),
        ("powerful_gen1_pokemon__20251002T065535Z_6ab329cc.pptx", ["pokemon"], 1),
        ("Powerful_Pokemon_Gen1__20251002T054021Z_dbe0091f.pptx", ["pokemon"], 1),
    ]
    
    results = []
    for test_data in tests:
        file_name = test_data[0]
        expected_content = test_data[1] if len(test_data) > 1 else None
        min_pages = test_data[2] if len(test_data) > 2 else 1
        
        file_path = SAMPLES_DIR / file_name
        if file_path.exists():
            results.append(test_file_conversion(file_path, expected_content, min_pages))
        else:
            print_warning(f"File not found: {file_name}")
    
    return results

def test_html_files():
    """Test HTML file conversions"""
    print(f"\n{Colors.BOLD}{'='*60}{Colors.RESET}")
    print(f"{Colors.BOLD}Testing HTML Files{Colors.RESET}")
    print(f"{Colors.BOLD}{'='*60}{Colors.RESET}")
    
    tests = [
        ("sample1.html", None),
        ("sample2.html", None),
    ]
    
    results = []
    for file_name, expected_content in tests:
        file_path = SAMPLES_DIR / file_name
        if file_path.exists():
            results.append(test_file_conversion(file_path, expected_content))
        else:
            print_warning(f"File not found: {file_name}")
    
    return results

def test_pdf_files():
    """Test PDF file handling (should pass through or re-process)"""
    print(f"\n{Colors.BOLD}{'='*60}{Colors.RESET}")
    print(f"{Colors.BOLD}Testing PDF Files{Colors.RESET}")
    print(f"{Colors.BOLD}{'='*60}{Colors.RESET}")
    
    tests = [
        ("quote_of_the_day__20251002T064921Z_af063c8e.pdf", None),
    ]
    
    results = []
    for file_name, expected_content in tests:
        file_path = SAMPLES_DIR / file_name
        if file_path.exists():
            # PDFs might not be supported for conversion (already PDF)
            print_info(f"Testing: {file_name}")
            print_warning("PDF files may not require conversion - SKIPPING")
            results.append(True)
        else:
            print_warning(f"File not found: {file_name}")
    
    return results

def check_libreoffice():
    """Check if LibreOffice is installed"""
    try:
        converter = DocumentConverter()
        print_success(f"LibreOffice found at: {converter.libreoffice_path}")
        return True
    except RuntimeError as e:
        print_error(f"LibreOffice not found: {e}")
        print_info("Please install LibreOffice:")
        print_info("  macOS: brew install --cask libreoffice")
        print_info("  Ubuntu/Debian: sudo apt-get install libreoffice")
        return False

def main():
    """Run all tests"""
    print(f"\n{Colors.BOLD}{'='*60}{Colors.RESET}")
    print(f"{Colors.BOLD}Document to PDF Conversion Tests{Colors.RESET}")
    print(f"{Colors.BOLD}{'='*60}{Colors.RESET}")
    
    # Check prerequisites
    if not check_libreoffice():
        sys.exit(1)
    
    if not SAMPLES_DIR.exists():
        print_error(f"Samples directory not found: {SAMPLES_DIR}")
        sys.exit(1)
    
    print_info(f"Samples directory: {SAMPLES_DIR}")
    print_info(f"Output directory: {OUTPUT_DIR}")
    
    # Run all test suites
    all_results = []
    
    all_results.extend(test_text_files())
    all_results.extend(test_office_documents())
    all_results.extend(test_html_files())
    all_results.extend(test_pdf_files())
    
    # Print summary
    print(f"\n{Colors.BOLD}{'='*60}{Colors.RESET}")
    print(f"{Colors.BOLD}Test Summary{Colors.RESET}")
    print(f"{Colors.BOLD}{'='*60}{Colors.RESET}")
    
    passed = sum(1 for r in all_results if r)
    failed = sum(1 for r in all_results if not r)
    total = len(all_results)
    
    print(f"\nTotal tests: {total}")
    print_success(f"Passed: {passed}")
    if failed > 0:
        print_error(f"Failed: {failed}")
    
    success_rate = (passed / total * 100) if total > 0 else 0
    print(f"\nSuccess rate: {success_rate:.1f}%")
    
    if failed == 0:
        print(f"\n{Colors.GREEN}{Colors.BOLD}🎉 All tests passed!{Colors.RESET}")
        return 0
    else:
        print(f"\n{Colors.RED}{Colors.BOLD}❌ Some tests failed{Colors.RESET}")
        return 1

if __name__ == "__main__":
    sys.exit(main())
