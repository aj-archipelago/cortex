import os
import subprocess
import logging
import time
from pathlib import Path
from typing import Optional, List

class DocumentConverter:
    """
    Optimized document converter using LibreOffice via unoserver.
    """

    SUPPORTED_FORMATS = {
        '.doc', '.docx', '.docm', '.dot', '.dotx', '.dotm',
        '.xls', '.xlsx', '.xlsm', '.xlt', '.xltx', '.xltm', '.csv',
        '.ppt', '.pptx', '.pptm', '.pot', '.potx', '.potm', '.pps', '.ppsx', '.ppsm',
        '.odt', '.ott', '.ods', '.ots', '.odp', '.otp', '.odg', '.otg', '.odf',
        '.txt', '.rtf',
        '.html', '.htm', '.xhtml',
        '.xml', '.wpd', '.wps',
        '.wk1', '.wks', '.123', '.dif', '.dbf',
    }

    def __init__(self, libreoffice_path: Optional[str] = None):
        self.libreoffice_path = libreoffice_path or self._find_libreoffice()
        if not self.libreoffice_path:
            raise RuntimeError("LibreOffice not found!")
        logging.info(f"Using LibreOffice at: {self.libreoffice_path}")

    def _find_libreoffice(self) -> Optional[str]:
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

        common_paths = [
            '/usr/bin/libreoffice',
            '/usr/bin/soffice',
            '/Applications/LibreOffice.app/Contents/MacOS/soffice',
        ]

        for path in common_paths:
            if os.path.exists(path):
                return path

        return None

    def is_supported_format(self, file_extension: str) -> bool:
        if not file_extension.startswith('.'):
            file_extension = '.' + file_extension
        return file_extension.lower() in self.SUPPORTED_FORMATS

    def get_supported_formats(self) -> List[str]:
        return sorted(list(self.SUPPORTED_FORMATS))

    def convert_to_pdf(
        self,
        input_file: str,
        output_dir: Optional[str] = None,
        timeout: int = 60
    ) -> Optional[str]:
        if not os.path.exists(input_file):
            raise FileNotFoundError(f"Input file not found: {input_file}")

        input_path = Path(input_file)
        if output_dir is None:
            output_dir = str(input_path.parent)

        pdf_filename = input_path.stem + ".pdf"
        output_path = os.path.join(output_dir, pdf_filename)

        start_time = time.time()
        logging.info(f"Converting {input_file} to PDF via unoserver...")

        try:
            rpc_port = os.environ.get('UNOSERVER_RPC_PORT', os.environ.get('UNOSERVER_PORT', '2003'))
            uno_env = {
                **os.environ,
                'UNO_PROFILE_DIR': os.environ.get('UNO_PROFILE_DIR', '/tmp/uno-profile'),
            }

            cmd = [
                'unoconvert',
                '--host-location', 'local',
                '--port', str(rpc_port),
                '--convert-to', 'pdf',
                '--filter-options', 'ReduceImageResolution=true',
                '--filter-options', 'MaxImageResolution=120',
                '--filter-options', 'Quality=85',
                '--filter-options', 'UseTaggedPDF=false',
                input_file,
                output_path
            ]

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=uno_env
            )

            elapsed = time.time() - start_time

            if result.returncode != 0:
                logging.error(f"unoconvert failed ({elapsed:.2f}s): {result.stderr}")
                return None

            if not os.path.exists(output_path):
                logging.error(f"PDF not created ({elapsed:.2f}s): {output_path}")
                return None

            file_size = os.path.getsize(output_path)
            logging.info(f"✓ Converted in {elapsed:.2f}s ({file_size/1024:.1f}KB): {output_path}")
            return output_path

        except subprocess.TimeoutExpired:
            elapsed = time.time() - start_time
            logging.error(f"Conversion timed out after {elapsed:.2f}s")
            return None
        except Exception as e:
            elapsed = time.time() - start_time
            logging.error(f"Conversion error ({elapsed:.2f}s): {e}", exc_info=True)
            return None
