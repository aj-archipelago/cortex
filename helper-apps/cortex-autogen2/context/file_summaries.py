"""
File summary extraction functionality for context memory system.

Handles extraction of content previews from various file types.
"""
import json
import os
import logging
from typing import Dict, Optional
import pandas as pd

logger = logging.getLogger(__name__)


class FileSummarizer:
    """
    Handles extraction of file summaries and content previews.
    """
    
    def __init__(self, work_dir: str):
        """
        Initialize FileSummarizer.
        
        Args:
            work_dir: Working directory for this request
        """
        self.work_dir = work_dir
    
    def get_file_summaries(self) -> dict:
        """
        Extract and summarize all created files with content previews.
        
        Returns:
            Dict mapping file paths to summary dicts with metadata and previews
        """
        file_summaries = {}
        
        # Scan work_dir for deliverable files
        deliverable_extensions = ['.csv', '.json', '.png', '.jpg', '.jpeg', '.pdf', '.pptx', '.xlsx', '.txt']
        
        for root, dirs, files in os.walk(self.work_dir):
            # Skip logs directory
            if 'logs' in root:
                continue
            
            for file in files:
                file_path = os.path.join(root, file)
                _, ext = os.path.splitext(file)
                
                if ext.lower() in deliverable_extensions:
                    try:
                        summary = self._extract_file_summary(file_path, ext.lower())
                        if summary:
                            file_summaries[file_path] = summary
                    except Exception as e:
                        logger.warning(f"Failed to summarize file {file_path}: {e}")
        
        return file_summaries
    
    def _extract_file_summary(self, file_path: str, ext: str) -> Optional[dict]:
        """Extract content preview for a specific file."""
        try:
            file_stat = os.stat(file_path)
            file_size = file_stat.st_size
            
            summary = {
                "file_path": file_path,
                "file_name": os.path.basename(file_path),
                "file_type": ext[1:] if ext.startswith('.') else ext,
                "file_size": file_size,
                "content_preview": None
            }
            
            if ext == '.csv':
                # CSV: Extract column names, row count, sample data
                try:
                    df = pd.read_csv(file_path, nrows=15)
                    columns = list(df.columns)
                    row_count = len(pd.read_csv(file_path))
                    
                    # Create markdown table preview
                    preview_df = df.head(10)
                    markdown_table = preview_df.to_markdown(index=False)
                    
                    summary["content_preview"] = {
                        "columns": columns,
                        "row_count": row_count,
                        "sample_data": markdown_table,
                        "column_types": {col: str(df[col].dtype) for col in columns}
                    }
                except Exception as e:
                    summary["content_preview"] = {"error": f"Failed to read CSV: {e}"}
            
            elif ext == '.json':
                # JSON: Parse structure, show schema/keys, sample data
                try:
                    with open(file_path, 'r', encoding='utf-8') as f:
                        data = json.load(f)
                    
                    if isinstance(data, list) and len(data) > 0:
                        sample = data[:3] if len(data) >= 3 else data
                        keys = list(data[0].keys()) if isinstance(data[0], dict) else []
                        summary["content_preview"] = {
                            "type": "array",
                            "length": len(data),
                            "sample_records": sample,
                            "keys": keys
                        }
                    elif isinstance(data, dict):
                        summary["content_preview"] = {
                            "type": "object",
                            "keys": list(data.keys()),
                            "sample_data": {k: str(v)[:100] for k, v in list(data.items())[:5]}
                        }
                    else:
                        summary["content_preview"] = {
                            "type": type(data).__name__,
                            "value": str(data)[:200]
                        }
                except Exception as e:
                    summary["content_preview"] = {"error": f"Failed to read JSON: {e}"}
            
            elif ext in ['.png', '.jpg', '.jpeg']:
                # Image: File metadata, description
                try:
                    from PIL import Image
                    with Image.open(file_path) as img:
                        width, height = img.size
                        summary["content_preview"] = {
                            "dimensions": f"{width}x{height}",
                            "format": img.format,
                            "mode": img.mode
                        }
                except ImportError:
                    summary["content_preview"] = {"note": "PIL not available for image analysis"}
                except Exception as e:
                    summary["content_preview"] = {"error": f"Failed to read image: {e}"}
            
            else:
                # Other files: File type, size, purpose
                summary["content_preview"] = {
                    "note": f"File type: {ext}, Size: {file_size} bytes"
                }
            
            return summary
            
        except Exception as e:
            logger.warning(f"Failed to extract file summary for {file_path}: {e}")
            return None

