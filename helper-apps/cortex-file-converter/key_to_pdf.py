import argparse
import subprocess
import os
import sys

def convert_key_to_pdf(key_path, pdf_path):
    """
    Converts a Keynote file (.key) to PDF using AppleScript.
    """
    if not os.path.exists(key_path):
        print(f"Error: Input file not found: {key_path}", file=sys.stderr)
        sys.exit(1)

    # Ensure the output directory exists
    output_dir = os.path.dirname(pdf_path)
    if output_dir and not os.path.exists(output_dir):
        try:
            os.makedirs(output_dir)
        except OSError as e:
            print(f"Error creating output directory {output_dir}: {e}", file=sys.stderr)
            sys.exit(1)

    # Check if output PDF exists and delete it
    if os.path.exists(pdf_path):
        try:
            os.remove(pdf_path)
            print(f"Removed existing output file: {pdf_path}")
        except OSError as e:
            print(f"Error removing existing output file {pdf_path}: {e}", file=sys.stderr)
            # Decide if this should be fatal or just a warning
            # sys.exit(1) 

    applescript = f'''
    tell application "Keynote"
        try
            set theDocument to open POSIX file "{key_path}"
            if not (exists theDocument) then error "Failed to open document."

            set pdf_export_settings to {{PDF image quality:Good}} -- Define settings as record (escaped braces)

            with timeout of 1200 seconds -- Allow 20 minutes for export
                 export theDocument to POSIX file "{pdf_path}" as PDF with properties pdf_export_settings -- Use settings record
            end timeout

            close theDocument saving no
            log "Successfully exported {key_path} to {pdf_path}"
        on error errMsg number errNum
            log "AppleScript Error: " & errMsg & " (Number: " & errNum & ")"
            # Try to quit Keynote even if there was an error during export/close
            try
                if exists theDocument then
                    close theDocument saving no
                end if
            end try
            error "Keynote conversion failed: " & errMsg number errNum
        end try
        -- Optional: Quit Keynote after conversion
        -- quit
    end tell
    '''

    try:
        # Using osascript to run the AppleScript
        process = subprocess.run(['osascript', '-e', applescript], 
                                 capture_output=True, text=True, check=True, timeout=1260) # Add a slightly longer timeout for the process itself
        print(f"Successfully converted '{key_path}' to '{pdf_path}'")
        # Print Keynote's log messages if needed
        # print("AppleScript Output:\n", process.stdout)
        # print("AppleScript Errors:\n", process.stderr) # osascript might put log messages here too
    except subprocess.CalledProcessError as e:
        print(f"Error executing AppleScript: {e}", file=sys.stderr)
        print(f"stdout:\n{e.stdout}", file=sys.stderr)
        print(f"stderr:\n{e.stderr}", file=sys.stderr)
        sys.exit(1)
    except subprocess.TimeoutExpired:
        print(f"Error: AppleScript execution timed out for {key_path}", file=sys.stderr)
        # It's hard to reliably kill the Keynote process started by AppleScript here,
        # as Keynote might still be hung. Manual intervention might be needed.
        sys.exit(1)
    except Exception as e:
        print(f"An unexpected Python error occurred: {e}", file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Convert Keynote (.key) files to PDF.")
    parser.add_argument("input_key_file", help="Path to the input Keynote file.")
    parser.add_argument("-o", "--output", help="Path for the output PDF file. Defaults to the same name as the input file but with a .pdf extension.")

    args = parser.parse_args()

    input_path = os.path.abspath(args.input_key_file)
    
    if args.output:
        output_path = os.path.abspath(args.output)
    else:
        # Default output path
        base_name = os.path.splitext(input_path)[0]
        output_path = base_name + ".pdf"

    convert_key_to_pdf(input_path, output_path)

if __name__ == "__main__":
    main() 