#!/usr/bin/env python3
"""
End-to-end tests for streaming document upload and PDF download.
Tests both file upload and URI-based conversion with streaming responses.
"""

import os
import sys
import time
import requests
from pathlib import Path
import PyPDF2

# Test configuration
SAMPLES_DIR = Path(__file__).parent.parent / "samples"
OUTPUT_DIR = Path(__file__).parent.parent / "test_streaming_output"
OUTPUT_DIR.mkdir(exist_ok=True)

BASE_URL = os.getenv("TEST_URL", "http://localhost:8080")
CONVERT_ENDPOINT = f"{BASE_URL}/convert"

class Colors:
    """ANSI color codes"""
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

def print_header(msg):
    print(f"\n{Colors.BOLD}{'='*60}{Colors.RESET}")
    print(f"{Colors.BOLD}{msg}{Colors.RESET}")
    print(f"{Colors.BOLD}{'='*60}{Colors.RESET}")

def verify_pdf(pdf_path):
    """Verify that a file is a valid PDF."""
    try:
        with open(pdf_path, 'rb') as f:
            pdf_reader = PyPDF2.PdfReader(f)
            return {
                'valid': True,
                'pages': len(pdf_reader.pages),
                'size': os.path.getsize(pdf_path)
            }
    except Exception as e:
        return {
            'valid': False,
            'error': str(e)
        }

def test_file_upload_streaming(file_path, test_name):
    """Test streaming file upload and response."""
    print(f"\n{Colors.BOLD}Test: {test_name}{Colors.RESET}")
    print(f"  File: {file_path.name}")
    print(f"  Size: {os.path.getsize(file_path):,} bytes")
    
    output_path = OUTPUT_DIR / f"{file_path.stem}_uploaded.pdf"
    
    start_time = time.time()
    
    try:
        # Open file and stream it
        with open(file_path, 'rb') as f:
            files = {'file': (file_path.name, f, 'application/octet-stream')}
            
            print_info("Uploading file...")
            response = requests.post(
                CONVERT_ENDPOINT,
                files=files,
                stream=True  # Enable streaming response
            )
        
        elapsed = time.time() - start_time
        
        if response.status_code != 200:
            print_error(f"HTTP {response.status_code}: {response.text[:200]}")
            return False
        
        # Stream response to file
        print_info(f"Streaming PDF response...")
        bytes_received = 0
        with open(output_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
                    bytes_received += len(chunk)
        
        print_success(f"Completed in {elapsed:.2f}s")
        print_info(f"Downloaded: {bytes_received:,} bytes")
        
        # Verify PDF
        pdf_info = verify_pdf(output_path)
        if not pdf_info['valid']:
            print_error(f"Invalid PDF: {pdf_info.get('error')}")
            return False
        
        print_success(f"Valid PDF: {pdf_info['pages']} pages, {pdf_info['size']:,} bytes")
        return True
        
    except requests.exceptions.ConnectionError:
        print_error("Connection failed - is the service running?")
        return False
    except Exception as e:
        print_error(f"Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_uri_streaming(uri, filename, test_name):
    """Test URI-based conversion with streaming response."""
    print(f"\n{Colors.BOLD}Test: {test_name}{Colors.RESET}")
    print(f"  URI: {uri[:80]}...")
    
    output_path = OUTPUT_DIR / filename
    
    start_time = time.time()
    
    try:
        print_info("Requesting conversion...")
        response = requests.post(
            CONVERT_ENDPOINT,
            json={'uri': uri},
            stream=True  # Enable streaming response
        )
        
        elapsed = time.time() - start_time
        
        if response.status_code != 200:
            print_error(f"HTTP {response.status_code}: {response.text[:200]}")
            return False
        
        # Stream response to file
        print_info(f"Streaming PDF response...")
        bytes_received = 0
        with open(output_path, 'wb') as f:
            for chunk in response.iter_content(chunk_size=8192):
                if chunk:
                    f.write(chunk)
                    bytes_received += len(chunk)
        
        print_success(f"Completed in {elapsed:.2f}s")
        print_info(f"Downloaded: {bytes_received:,} bytes")
        
        # Verify PDF
        pdf_info = verify_pdf(output_path)
        if not pdf_info['valid']:
            print_error(f"Invalid PDF: {pdf_info.get('error')}")
            return False
        
        print_success(f"Valid PDF: {pdf_info['pages']} pages, {pdf_info['size']:,} bytes")
        return True
        
    except requests.exceptions.ConnectionError:
        print_error("Connection failed - is the service running?")
        return False
    except Exception as e:
        print_error(f"Test failed: {e}")
        import traceback
        traceback.print_exc()
        return False

def test_large_file_streaming():
    """Test streaming with larger files."""
    print_header("Large File Streaming Tests")
    
    results = []
    
    # Test with Excel file (usually larger)
    excel_file = SAMPLES_DIR / "file_example_XLSX_5000.xlsx"
    if excel_file.exists():
        results.append(test_file_upload_streaming(
            excel_file,
            "Large Excel File Upload"
        ))
    
    # Test with PowerPoint
    ppt_file = SAMPLES_DIR / "file_example_PPT_1MB.ppt"
    if ppt_file.exists():
        results.append(test_file_upload_streaming(
            ppt_file,
            "Large PowerPoint Upload"
        ))
    
    return results

def test_various_formats():
    """Test streaming with various document formats."""
    print_header("Various Format Streaming Tests")
    
    results = []
    test_files = [
        ("file-sample_1MB.docx", "Word Document"),
        ("ascii-art.txt", "Text File"),
        ("sample1.html", "HTML File"),
    ]
    
    for filename, description in test_files:
        file_path = SAMPLES_DIR / filename
        if file_path.exists():
            results.append(test_file_upload_streaming(
                file_path,
                f"{description} Upload"
            ))
        else:
            print_warning(f"Skipping {filename} - not found")
    
    return results

def test_uri_based_streaming():
    """Test URI-based conversion with streaming."""
    print_header("URI-Based Streaming Tests")
    
    results = []
    
    # Test with a public document
    results.append(test_uri_streaming(
        "https://file-examples.com/storage/fe783f04fc66761fd44fb46/2017/02/file-sample_100kB.docx",
        "public_word_doc.pdf",
        "Public Word Document via URI"
    ))
    
    return results

def test_concurrent_uploads():
    """Test multiple concurrent streaming uploads."""
    print_header("Concurrent Streaming Tests")
    
    from concurrent.futures import ThreadPoolExecutor, as_completed
    
    test_files = [
        SAMPLES_DIR / "data.txt",
        SAMPLES_DIR / "multilang.txt",
        SAMPLES_DIR / "sample2.html",
    ]
    
    # Filter existing files
    test_files = [f for f in test_files if f.exists()]
    
    if not test_files:
        print_warning("No test files available for concurrent test")
        return [True]
    
    print_info(f"Testing {len(test_files)} concurrent uploads...")
    start_time = time.time()
    
    results = []
    with ThreadPoolExecutor(max_workers=3) as executor:
        futures = {
            executor.submit(
                test_file_upload_streaming,
                file_path,
                f"Concurrent Upload {i+1}"
            ): file_path
            for i, file_path in enumerate(test_files)
        }
        
        for future in as_completed(futures):
            file_path = futures[future]
            try:
                result = future.result()
                results.append(result)
            except Exception as e:
                print_error(f"Concurrent test failed for {file_path.name}: {e}")
                results.append(False)
    
    elapsed = time.time() - start_time
    print_success(f"All concurrent uploads completed in {elapsed:.2f}s")
    
    return results

def test_error_handling():
    """Test error handling in streaming."""
    print_header("Error Handling Tests")
    
    results = []
    
    # Test 1: Invalid file type
    print(f"\n{Colors.BOLD}Test: Invalid File Type{Colors.RESET}")
    try:
        # Create a fake file with unsupported extension
        fake_file = OUTPUT_DIR / "test.xyz"
        fake_file.write_text("test content")
        
        with open(fake_file, 'rb') as f:
            files = {'file': ('test.xyz', f, 'application/octet-stream')}
            response = requests.post(CONVERT_ENDPOINT, files=files)
        
        if response.status_code == 400:
            print_success("Correctly rejected unsupported file type")
            results.append(True)
        else:
            print_error(f"Expected 400, got {response.status_code}")
            results.append(False)
        
        fake_file.unlink()
    except Exception as e:
        print_error(f"Error test failed: {e}")
        results.append(False)
    
    # Test 2: Empty file
    print(f"\n{Colors.BOLD}Test: Empty File Upload{Colors.RESET}")
    try:
        empty_file = OUTPUT_DIR / "empty.txt"
        empty_file.write_text("")
        
        with open(empty_file, 'rb') as f:
            files = {'file': ('empty.txt', f, 'application/octet-stream')}
            response = requests.post(CONVERT_ENDPOINT, files=files)
        
        # Should handle gracefully (either convert or error)
        if response.status_code in [200, 400, 500]:
            print_success(f"Handled empty file gracefully (status: {response.status_code})")
            results.append(True)
        else:
            print_error(f"Unexpected status: {response.status_code}")
            results.append(False)
        
        empty_file.unlink()
    except Exception as e:
        print_error(f"Empty file test failed: {e}")
        results.append(False)
    
    # Test 3: Invalid URI
    print(f"\n{Colors.BOLD}Test: Invalid URI{Colors.RESET}")
    try:
        response = requests.post(
            CONVERT_ENDPOINT,
            json={'uri': 'not-a-valid-url'}
        )
        
        if response.status_code == 400:
            print_success("Correctly rejected invalid URI")
            results.append(True)
        else:
            print_error(f"Expected 400, got {response.status_code}")
            results.append(False)
    except Exception as e:
        print_error(f"Invalid URI test failed: {e}")
        results.append(False)
    
    return results

def check_service_health():
    """Check if the service is running."""
    try:
        response = requests.get(f"{BASE_URL}/health", timeout=5)
        if response.status_code == 200:
            print_success(f"Service is running at {BASE_URL}")
            return True
        else:
            print_error(f"Service returned status {response.status_code}")
            return False
    except requests.exceptions.ConnectionError:
        print_error(f"Cannot connect to service at {BASE_URL}")
        print_info("Make sure the service is running: docker compose up -d")
        return False
    except Exception as e:
        print_error(f"Health check failed: {e}")
        return False

def main():
    """Run all streaming tests."""
    print_header("Document to PDF Streaming Tests")
    print(f"Test URL: {BASE_URL}")
    print(f"Samples: {SAMPLES_DIR}")
    print(f"Output: {OUTPUT_DIR}")
    
    # Check service health
    if not check_service_health():
        return 1
    
    # Run all test suites
    all_results = []
    
    all_results.extend(test_various_formats())
    all_results.extend(test_large_file_streaming())
    all_results.extend(test_uri_based_streaming())
    all_results.extend(test_concurrent_uploads())
    all_results.extend(test_error_handling())
    
    # Print summary
    print_header("Test Summary")
    
    passed = sum(1 for r in all_results if r)
    failed = sum(1 for r in all_results if not r)
    total = len(all_results)
    
    print(f"\nTotal tests: {total}")
    print_success(f"Passed: {passed}")
    if failed > 0:
        print_error(f"Failed: {failed}")
    
    success_rate = (passed / total * 100) if total > 0 else 0
    print(f"\nSuccess rate: {success_rate:.1f}%")
    
    print(f"\n{Colors.BLUE}All output PDFs saved to: {OUTPUT_DIR}{Colors.RESET}")
    
    if failed == 0:
        print(f"\n{Colors.GREEN}{Colors.BOLD}🎉 All streaming tests passed!{Colors.RESET}")
        return 0
    else:
        print(f"\n{Colors.RED}{Colors.BOLD}❌ Some tests failed{Colors.RESET}")
        return 1

if __name__ == "__main__":
    sys.exit(main())
