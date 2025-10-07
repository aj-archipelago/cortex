import os
import subprocess
import logging
from pathlib import Path
from typing import Optional, List

class DocumentConverter:
    """
    Converts various document formats to PDF using LibreOffice.
    
    Supports:
    - Microsoft Office: .doc, .docx, .xls, .xlsx, .ppt, .pptx
    - OpenDocument: .odt, .ods, .odp, .odg
    - Text formats: .txt, .rtf, .csv
    - Web formats: .html, .htm
    - And many more formats supported by LibreOffice
    """
    
    # Comprehensive list of supported document formats
    SUPPORTED_FORMATS = {
        # Microsoft Word
        '.doc', '.docx', '.docm', '.dot', '.dotx', '.dotm',
        # Microsoft Excel
        '.xls', '.xlsx', '.xlsm', '.xlt', '.xltx', '.xltm', '.csv',
        # Microsoft PowerPoint
        '.ppt', '.pptx', '.pptm', '.pot', '.potx', '.potm', '.pps', '.ppsx', '.ppsm',
        # OpenDocument formats
        '.odt', '.ott', '.ods', '.ots', '.odp', '.otp', '.odg', '.otg', '.odf',
        # Text formats
        '.txt', '.rtf',
        # Web formats
        '.html', '.htm', '.xhtml',
        # Other formats
        '.xml', '.wpd', '.wps',
        # Legacy formats
        '.wk1', '.wks', '.123', '.dif', '.dbf',
    }
    
    def __init__(self, libreoffice_path: Optional[str] = None):
        """
        Initialize the document converter.
        
        Args:
            libreoffice_path: Path to LibreOffice executable. If None, will search common locations.
        """
        self.libreoffice_path = libreoffice_path or self._find_libreoffice()
        if not self.libreoffice_path:
            raise RuntimeError(
                "LibreOffice not found. Please install LibreOffice or provide the path to the executable."
            )
        logging.info(f"Using LibreOffice at: {self.libreoffice_path}")
    
    def _find_libreoffice(self) -> Optional[str]:
        """
        Find LibreOffice installation on the system.
        
        Returns:
            Path to LibreOffice executable or None if not found.
        """
        # Common LibreOffice paths on different systems
        common_paths = [
            # Linux
            '/usr/bin/libreoffice',
            '/usr/bin/soffice',
            '/usr/local/bin/libreoffice',
            '/usr/local/bin/soffice',
            # macOS
            '/Applications/LibreOffice.app/Contents/MacOS/soffice',
            '/Applications/OpenOffice.app/Contents/MacOS/soffice',
            # Windows (if running in WSL or similar)
            'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
            'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
            # Docker/Container common installation
            '/opt/libreoffice/program/soffice',
        ]
        
        # Check if 'soffice' or 'libreoffice' is in PATH
        for cmd in ['soffice', 'libreoffice']:
            try:
                result = subprocess.run(
                    ['which', cmd],
                    capture_output=True,
                    text=True,
                    timeout=5
                )
                if result.returncode == 0 and result.stdout.strip():
                    return result.stdout.strip()
            except Exception:
                pass
        
        # Check common installation paths
        for path in common_paths:
            if os.path.exists(path):
                return path
        
        return None
    
    def is_supported_format(self, file_extension: str) -> bool:
        """
        Check if a file extension is supported for conversion.
        
        Args:
            file_extension: File extension (with or without leading dot)
        
        Returns:
            True if format is supported, False otherwise
        """
        if not file_extension.startswith('.'):
            file_extension = '.' + file_extension
        return file_extension.lower() in self.SUPPORTED_FORMATS
    
    def get_supported_formats(self) -> List[str]:
        """
        Get list of all supported file formats.
        
        Returns:
            List of supported file extensions
        """
        return sorted(list(self.SUPPORTED_FORMATS))
    
    def convert_to_pdf(
        self,
        input_file: str,
        output_dir: Optional[str] = None,
        timeout: int = 300
    ) -> Optional[str]:
        """
        Convert a document to PDF using LibreOffice.
        
        Args:
            input_file: Path to the input document
            output_dir: Directory to save the PDF (defaults to same directory as input)
            timeout: Timeout in seconds for the conversion process (default: 300)
        
        Returns:
            Path to the converted PDF file, or None if conversion failed
        """
        if not os.path.exists(input_file):
            raise FileNotFoundError(f"Input file not found: {input_file}")
        
        input_path = Path(input_file)
        if output_dir is None:
            output_dir = str(input_path.parent)
        
        # Expected output PDF path
        pdf_filename = input_path.stem + ".pdf"
        output_path = os.path.join(output_dir, pdf_filename)
        
        logging.info(f"Converting {input_file} to PDF...")
        logging.info(f"Output directory: {output_dir}")
        
        try:
            # LibreOffice command for headless PDF conversion
            # --headless: Run without GUI
            # --convert-to pdf: Convert to PDF format
            # --outdir: Specify output directory
            cmd = [
                self.libreoffice_path,
                '--headless',
                '--invisible',
                '--nodefault',
                '--nofirststartwizard',
                '--nolockcheck',
                '--nologo',
                '--norestore',
                '--convert-to', 'pdf',
                '--outdir', output_dir,
                input_file
            ]
            
            logging.info(f"Running command: {' '.join(cmd)}")
            
            # Run LibreOffice conversion
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                env={**os.environ, 'HOME': output_dir}  # Set HOME to avoid user profile issues
            )
            
            # Log output
            if result.stdout:
                logging.info(f"LibreOffice output: {result.stdout}")
            if result.stderr:
                logging.warning(f"LibreOffice errors: {result.stderr}")
            
            # Check if conversion was successful
            if result.returncode != 0:
                logging.error(f"LibreOffice conversion failed with code {result.returncode}")
                return None
            
            # Verify the PDF was created
            if not os.path.exists(output_path):
                logging.error(f"PDF file was not created: {output_path}")
                return None
            
            logging.info(f"Successfully converted to PDF: {output_path}")
            return output_path
            
        except subprocess.TimeoutExpired:
            logging.error(f"Conversion timed out after {timeout} seconds")
            return None
        except Exception as e:
            logging.error(f"Error during conversion: {str(e)}", exc_info=True)
            return None
