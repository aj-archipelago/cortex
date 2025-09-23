"""
Universal File Tools for Cortex-AutoGen2
Enhanced file handling system that works across all file types.
"""

import asyncio
import logging
import os
import json
import mimetypes
from pathlib import Path
from typing import List, Optional, Dict, Any, Union
from autogen_core.tools import FunctionTool

logger = logging.getLogger(__name__)


class UniversalFileHandler:
    """Universal file handler that intelligently processes any file type."""
    
    @staticmethod
    def detect_file_type(file_path: str) -> Dict[str, Any]:
        """
        Intelligently detect file type and characteristics.
        
        Args:
            file_path: Path to the file
            
        Returns:
            Dictionary with file type information
        """
        if not os.path.exists(file_path):
            return {"error": "File not found", "exists": False}
        
        filename = os.path.basename(file_path)
        extension = os.path.splitext(filename)[1].lower()
        size = os.path.getsize(file_path)
        
        # MIME type detection
        mime_type, _ = mimetypes.guess_type(file_path)
        
        # Category classification
        categories = {
            "document": [".pdf", ".doc", ".docx", ".txt", ".md", ".rtf"],
            "spreadsheet": [".xls", ".xlsx", ".csv", ".tsv"],
            "presentation": [".ppt", ".pptx"],
            "image": [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".svg", ".webp"],
            "data": [".json", ".xml", ".yaml", ".yml"],
            "code": [".py", ".js", ".html", ".css", ".sql", ".r"],
            "archive": [".zip", ".tar", ".gz", ".rar", ".7z"],
            "media": [".mp4", ".mp3", ".avi", ".mov", ".wav"]
        }
        
        category = "unknown"
        for cat, extensions in categories.items():
            if extension in extensions:
                category = cat
                break
        
        return {
            "filename": filename,
            "extension": extension,
            "size": size,
            "mime_type": mime_type,
            "category": category,
            "exists": True,
            "is_deliverable": not filename.startswith(("tmp_", "temp_", ".")),
            "is_readable": category in ["document", "data", "code"] or extension in [".txt", ".csv", ".json"],
            "description": _get_file_description(extension, category)
        }
    
    @staticmethod
    def read_file_intelligently(file_path: str, max_length: int = 5000) -> Dict[str, Any]:
        """
        Intelligently read file content based on file type.
        
        Args:
            file_path: Path to the file
            max_length: Maximum characters to read for text files
            
        Returns:
            Dictionary with file content and metadata
        """
        file_info = UniversalFileHandler.detect_file_type(file_path)
        
        if not file_info["exists"]:
            return file_info
        
        try:
            content_info = {
                **file_info,
                "content": None,
                "preview": None,
                "metadata": {}
            }
            
            if file_info["category"] == "image":
                content_info["preview"] = f"Image file: {file_info['filename']} ({file_info['size']} bytes)"
                content_info["metadata"]["viewable"] = True
                
            elif file_info["category"] == "document" and file_info["extension"] == ".pdf":
                content_info["preview"] = f"PDF document: {file_info['filename']} ({file_info['size']} bytes)"
                content_info["metadata"]["pages"] = "Unknown"
                content_info["metadata"]["viewable"] = True
                
            elif file_info["is_readable"]:
                # Try to read as text
                encodings = ['utf-8', 'utf-16', 'latin-1', 'cp1252']
                content = None
                
                for encoding in encodings:
                    try:
                        with open(file_path, 'r', encoding=encoding) as f:
                            content = f.read(max_length)
                        break
                    except (UnicodeDecodeError, UnicodeError):
                        continue
                
                if content is not None:
                    content_info["content"] = content
                    content_info["preview"] = content[:500] + "..." if len(content) > 500 else content
                    content_info["metadata"]["encoding"] = encoding
                    content_info["metadata"]["truncated"] = len(content) >= max_length
                    
                    # Special handling for structured data
                    if file_info["extension"] == ".json":
                        try:
                            json_data = json.loads(content)
                            content_info["metadata"]["json_valid"] = True
                            content_info["metadata"]["json_type"] = type(json_data).__name__
                            if isinstance(json_data, list):
                                content_info["metadata"]["json_length"] = len(json_data)
                        except json.JSONDecodeError:
                            content_info["metadata"]["json_valid"] = False
                            
                    elif file_info["extension"] == ".csv":
                        lines = content.split('\n')
                        content_info["metadata"]["csv_rows"] = len(lines)
                        content_info["metadata"]["csv_columns"] = len(lines[0].split(',')) if lines else 0
                else:
                    content_info["preview"] = "Binary file - cannot preview as text"
            else:
                content_info["preview"] = f"Binary file: {file_info['filename']} ({file_info['size']} bytes)"
                content_info["metadata"]["binary"] = True
            
            return content_info
            
        except Exception as e:
            return {
                **file_info,
                "error": f"Error reading file: {str(e)}",
                "content": None,
                "preview": None
            }


def _get_file_description(extension: str, category: str) -> str:
    """Get a human-readable description of the file type."""
    descriptions = {
        ".pdf": "PDF Document",
        ".txt": "Text File",
        ".csv": "CSV Data File", 
        ".json": "JSON Data File",
        ".png": "PNG Image",
        ".jpg": "JPEG Image",
        ".jpeg": "JPEG Image",
        ".gif": "GIF Image",
        ".svg": "SVG Vector Image",
        ".html": "HTML Document",
        ".xml": "XML Document",
        ".docx": "Word Document",
        ".xlsx": "Excel Spreadsheet",
        ".pptx": "PowerPoint Presentation",
        ".zip": "ZIP Archive",
        ".py": "Python Script",
        ".js": "JavaScript File",
        ".css": "CSS Stylesheet",
        ".md": "Markdown Document",
        ".sql": "SQL Script",
        ".yaml": "YAML Configuration",
        ".yml": "YAML Configuration"
    }
    
    return descriptions.get(extension, f"{category.title()} File" if category != "unknown" else "Unknown File Type")


async def download_image(url: str, filename: str, work_dir: Optional[str] = None) -> str:
    """
    Downloads an image from a URL and saves it to the working directory.

    Args:
        url: The URL of the image to download.
        filename: The local filename to save the image as.
        work_dir: Optional working directory path.

    Returns:
        A JSON string indicating success or failure.
    """
    if not work_dir:
        work_dir = os.getcwd()
    
    file_path = os.path.join(work_dir, filename)
    
    try:
        import requests
        BROWSER_UA = (
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/125.0.0.0 Safari/537.36"
        )
        session = requests.Session()
        session.headers.update({
            "User-Agent": BROWSER_UA,
            "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Referer": "https://duckduckgo.com/",
            "Cache-Control": "no-cache",
        })

        # Attempt to derive an original Wikimedia URL if this is a thumbnail
        wm_orig = None
        try:
            if "upload.wikimedia.org" in url and "/thumb/" in url:
                parts = url.split("/thumb/")
                if len(parts) == 2:
                    tail = parts[1]
                    segs = tail.split("/")
                    if len(segs) >= 3:
                        wm_orig = parts[0] + "/" + segs[0] + "/" + segs[1] + "/" + segs[2]
        except Exception:
            wm_orig = None

        candidates = []
        if wm_orig:
            candidates.append(wm_orig)
        candidates.append(url)

        last_err = None
        for candidate in candidates:
            try:
                with session.get(candidate, stream=True, timeout=25, allow_redirects=True) as response:
                    response.raise_for_status()

                    content_type = (response.headers.get("Content-Type") or "").lower()

                    # Peek first few bytes to validate image magic if header is missing/misleading
                    first_chunk = next(response.iter_content(chunk_size=4096), b"")

                    def looks_like_image(buf: bytes) -> bool:
                        if not buf or len(buf) < 4:
                            return False
                        sigs = [
                            b"\x89PNG\r\n\x1a\n",  # PNG
                            b"\xff\xd8\xff",        # JPEG
                            b"GIF87a", b"GIF89a",    # GIF
                            b"RIFF"                    # WEBP starts with RIFF
                        ]
                        return any(buf.startswith(sig) for sig in sigs)

                    if not (content_type.startswith("image/") or looks_like_image(first_chunk)):
                        last_err = f"Non-image content-type: {content_type} for {candidate}"
                        continue

                    # Write first chunk then stream the rest
                    with open(file_path, 'wb') as f:
                        if first_chunk:
                            f.write(first_chunk)
                        for chunk in response.iter_content(chunk_size=8192):
                            if chunk:
                                f.write(chunk)

                logger.info(f"✅ Successfully downloaded image from {candidate} to {file_path}")
                return json.dumps({"status": "success", "file_path": file_path})
            except Exception as e:
                last_err = str(e)
                continue

        logger.error(f"❌ Failed to download image after candidates. Last error: {last_err}")
        return json.dumps({"status": "error", "message": last_err or "download_failed"})
    except Exception as e:
        logger.error(f"❌ Failed to download image from {url}: {e}")
        return json.dumps({"status": "error", "message": str(e)})


# Enhanced file tools
async def list_files_in_work_dir(work_dir: Optional[str] = None) -> str:
    """
    Intelligently list and categorize all files in the working directory.
    
    Args:
        work_dir: Optional working directory path
    
    Returns:
        String containing categorized file listing with metadata
    """
    if not work_dir or not os.path.exists(work_dir):
        return "❌ Working directory not found or not specified"
    
    try:
        all_files = []
        categories = {
            "deliverable": [],
            "temporary": [],
            "data": [],
            "documents": [],
            "images": [],
            "code": [],
            "other": []
        }
        
        for item in os.listdir(work_dir):
            item_path = os.path.join(work_dir, item)
            if os.path.isfile(item_path):
                file_info = UniversalFileHandler.detect_file_type(item_path)
                all_files.append(file_info)
                
                # Categorize for display
                if not file_info["is_deliverable"]:
                    categories["temporary"].append(file_info)
                elif file_info["category"] == "document":
                    categories["documents"].append(file_info)
                elif file_info["category"] == "image":
                    categories["images"].append(file_info)
                elif file_info["category"] == "data":
                    categories["data"].append(file_info)
                elif file_info["category"] == "code":
                    categories["code"].append(file_info)
                else:
                    categories["deliverable"].append(file_info)
        
        if not all_files:
            return f"📁 No files found in working directory: {work_dir}"
        
        # Sort each category by size (largest first)
        for category in categories.values():
            category.sort(key=lambda x: x["size"], reverse=True)
        
        result = f"📁 **UNIVERSAL FILE DISCOVERY**\n"
        result += f"Directory: {work_dir}\n"
        result += f"Total Files: {len(all_files)}\n\n"
        
        # Show deliverable files first
        deliverable_count = sum(len(cat) for cat_name, cat in categories.items() if cat_name != "temporary")
        
        if deliverable_count > 0:
            result += f"🎯 **DELIVERABLE FILES** ({deliverable_count} files):\n\n"
            
            if categories["documents"]:
                result += f"📄 **Documents** ({len(categories['documents'])}):\n"
                for file_info in categories["documents"]:
                    result += f"  ✅ {file_info['filename']} ({file_info['size']} bytes) - {file_info['description']}\n"
                result += "\n"
            
            if categories["images"]:
                result += f"🖼️ **Images** ({len(categories['images'])}):\n"
                for file_info in categories["images"]:
                    result += f"  ✅ {file_info['filename']} ({file_info['size']} bytes) - {file_info['description']}\n"
                result += "\n"
            
            if categories["data"]:
                result += f"📊 **Data Files** ({len(categories['data'])}):\n"
                for file_info in categories["data"]:
                    result += f"  ✅ {file_info['filename']} ({file_info['size']} bytes) - {file_info['description']}\n"
                result += "\n"
            
            if categories["deliverable"]:
                result += f"📦 **Other Deliverables** ({len(categories['deliverable'])}):\n"
                for file_info in categories["deliverable"]:
                    result += f"  ✅ {file_info['filename']} ({file_info['size']} bytes) - {file_info['description']}\n"
                result += "\n"
        
        if categories["temporary"]:
            result += f"🗂️ **Temporary Files** ({len(categories['temporary'])}):\n"
            for file_info in categories["temporary"]:
                result += f"  - {file_info['filename']} ({file_info['size']} bytes)\n"
            result += "\n"
        
        if categories["code"]:
            result += f"💻 **Code Files** ({len(categories['code'])}):\n"
            for file_info in categories["code"]:
                result += f"  📝 {file_info['filename']} ({file_info['size']} bytes) - {file_info['description']}\n"
        
        # Add recommendations
        if deliverable_count > 0:
            result += f"\n🚀 **NEXT ACTIONS**:\n"
            result += f"1. Read and analyze deliverable files\n"
            result += f"2. Upload all deliverables to Azure\n"
            result += f"3. Provide download links to user\n"
        else:
            result += f"\n⚠️ **WARNING**: No deliverable files found!\n"
            result += f"Check if the task was completed successfully.\n"
        
        return result
        
    except Exception as e:
        return f"❌ Error listing files: {str(e)}"

async def create_file(filename: str, content: str, work_dir: Optional[str] = None) -> str:
    """
    Creates a new file with the given content in the specified working directory.

    Args:
        filename: The name of the file to create.
        content: The content to write to the file.
        work_dir: Optional working directory path. If not provided, uses the current directory.

    Returns:
        A JSON string confirming the file creation or an error message.
    """
    dir_path = work_dir or os.getcwd()
    file_path = os.path.join(dir_path, filename)

    try:
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        with open(file_path, "w", encoding="utf-8") as f:
            f.write(content)
        return json.dumps({"status": "success", "message": f"File '{filename}' created successfully in '{dir_path}'."})
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})

async def read_file_from_work_dir(filename: str, work_dir: Optional[str] = None, max_length: int = 5000) -> str:
    """
    Intelligently read and analyze any file type.
    
    Args:
        filename: Name of the file to read
        work_dir: Optional working directory path
        max_length: Maximum characters to read for text files
    
    Returns:
        String containing file analysis and content
    """
    if not work_dir or not os.path.exists(work_dir):
        return "❌ Working directory not found or not specified"
    
    file_path = os.path.join(work_dir, filename)
    
    if not os.path.exists(file_path):
        return f"❌ File not found: {filename}"
    
    try:
        content_info = UniversalFileHandler.read_file_intelligently(file_path, max_length)
        
        if "error" in content_info:
            return f"❌ {content_info['error']}"
        
        result = f"📄 **UNIVERSAL FILE ANALYSIS: {filename}**\n"
        result += f"Type: {content_info['description']}\n"
        result += f"Category: {content_info['category'].title()}\n"
        result += f"Size: {content_info['size']} bytes\n"
        result += f"MIME Type: {content_info['mime_type'] or 'Unknown'}\n"
        result += f"Deliverable: {'✅ Yes' if content_info['is_deliverable'] else '❌ No'}\n"
        
        if content_info["metadata"]:
            result += f"\n📊 **Metadata**:\n"
            for key, value in content_info["metadata"].items():
                result += f"  {key}: {value}\n"
        
        if content_info["preview"]:
            result += f"\n📝 **Content Preview**:\n"
            if content_info["content"] and content_info["is_readable"]:
                result += f"```\n{content_info['preview']}\n```\n"
                
                if content_info["metadata"].get("truncated"):
                    result += f"\n📏 **Note**: Content truncated at {max_length} characters\n"
            else:
                result += f"{content_info['preview']}\n"
        
        # Add recommendations
        result += f"\n💡 **Recommendations**:\n"
        if content_info["is_deliverable"]:
            result += f"✅ Upload this file to Azure for user download\n"
            if content_info["category"] == "document":
                result += f"📋 This appears to be a document - perfect for user delivery\n"
            elif content_info["category"] == "image":
                result += f"🖼️ This is an image file - should be viewable after upload\n"
            elif content_info["category"] == "data":
                result += f"📊 This contains data - useful for analysis or download\n"
        else:
            result += f"🗂️ This appears to be a temporary file\n"
        
        return result
        
    except Exception as e:
        return f"❌ Error reading file {filename}: {str(e)}"


async def get_file_info(filename: str, work_dir: Optional[str] = None) -> str:
    """
    Get comprehensive metadata about any file type.
    
    Args:
        filename: Name of the file to analyze
        work_dir: Optional working directory path
    
    Returns:
        String containing detailed file metadata
    """
    if not work_dir or not os.path.exists(work_dir):
        return "❌ Working directory not found or not specified"
    
    file_path = os.path.join(work_dir, filename)
    
    if not os.path.exists(file_path):
        return f"❌ File not found: {filename}"
    
    try:
        import time
        stat = os.stat(file_path)
        file_info = UniversalFileHandler.detect_file_type(file_path)
        
        result = f"📊 **COMPREHENSIVE FILE METADATA: {filename}**\n"
        result += f"Full Path: {file_path}\n"
        result += f"Size: {stat.st_size} bytes ({stat.st_size / 1024:.1f} KB)\n"
        result += f"Created: {time.ctime(stat.st_ctime)}\n"
        result += f"Modified: {time.ctime(stat.st_mtime)}\n"
        result += f"Extension: {file_info['extension'] or 'None'}\n"
        result += f"MIME Type: {file_info['mime_type'] or 'Unknown'}\n"
        result += f"Category: {file_info['category'].title()}\n"
        result += f"Description: {file_info['description']}\n"
        result += f"Readable: {'✅ Yes' if file_info['is_readable'] else '❌ No'}\n"
        result += f"Deliverable: {'✅ Yes' if file_info['is_deliverable'] else '❌ No'}\n"
        
        # File permissions
        result += f"\n🔐 **Permissions**:\n"
        result += f"Readable: {'✅' if os.access(file_path, os.R_OK) else '❌'}\n"
        result += f"Writable: {'✅' if os.access(file_path, os.W_OK) else '❌'}\n"
        result += f"Executable: {'✅' if os.access(file_path, os.X_OK) else '❌'}\n"
        
        return result
        
    except Exception as e:
        return f"❌ Error getting file info for {filename}: {str(e)}"


def get_file_tools(executor_work_dir: Optional[str] = None) -> List[FunctionTool]:
    """
    Get universal file tools for any agent.
    
    Args:
        executor_work_dir: Working directory for file operations
        
    Returns:
        List of file management tools
    """
    tools = []
    
    # Create partial functions with work_dir bound
    def bound_list_files():
        return asyncio.run(list_files_in_work_dir(executor_work_dir))
    
    def bound_read_file(filename: str, max_length: int = 5000):
        return asyncio.run(read_file_from_work_dir(filename, executor_work_dir, max_length))
    
    def bound_get_file_info(filename: str):
        return asyncio.run(get_file_info(filename, executor_work_dir))
    
    # Add tools
    tools.append(FunctionTool(
        bound_list_files,
        name="list_files_in_work_dir",
        description="Intelligently discover and categorize all files in the working directory with comprehensive metadata"
    ))
    
    tools.append(FunctionTool(
        bound_read_file,
        name="read_file_from_work_dir", 
        description="Intelligently read and analyze any file type with automatic content detection and preview generation"
    ))
    
    tools.append(FunctionTool(
        bound_get_file_info,
        name="get_file_info",
        description="Get comprehensive metadata and analysis for any file type including permissions and recommendations"
    ))
    
    logger.info(f"✅ Universal file tools created for work_dir: {executor_work_dir}")
    return tools 