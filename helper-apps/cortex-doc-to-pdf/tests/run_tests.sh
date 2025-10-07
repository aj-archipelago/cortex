#!/bin/bash
# Run end-to-end conversion tests

echo "🧪 Running Document to PDF Conversion Tests"
echo "============================================="
echo ""

# Check if LibreOffice is installed
if ! command -v soffice &> /dev/null && ! command -v libreoffice &> /dev/null; then
    echo "❌ Error: LibreOffice not found!"
    echo "Please install LibreOffice:"
    echo "  - macOS: brew install --cask libreoffice"
    echo "  - Ubuntu/Debian: sudo apt-get install libreoffice"
    exit 1
fi

# Check if Python requirements are installed
if ! python3 -c "import PyPDF2" 2>/dev/null; then
    echo "📦 Installing Python dependencies..."
    pip3 install -r requirements.txt
fi

# Run tests
python3 test_conversion.py

exit $?
