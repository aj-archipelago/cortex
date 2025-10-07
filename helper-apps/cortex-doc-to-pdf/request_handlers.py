"""HTTP request handlers for both Azure Functions and standalone server."""

import logging
import json
import urllib.parse
from aiohttp import web
import azure.functions as func
from document_converter import convert_from_uri, convert_from_stream


async def handle_azure_function_request(req: func.HttpRequest) -> func.HttpResponse:
    """
    Azure Function HTTP trigger handler.
    
    Supports GET and POST methods.
    Accepts 'uri' parameter (query string or JSON body) or file upload.
    Returns PDF as binary data with appropriate headers.
    """
    logging.info('Azure Function triggered')

    # Get URI parameter from query string or request body
    uri = req.params.get('uri')
    if not uri:
        try:
            req_body = await req.get_json()
            uri = req_body.get('uri')
        except ValueError:
            pass

    if not uri:
        return func.HttpResponse(
            json.dumps({
                "error": "Missing 'uri' parameter",
                "message": "Please provide a 'uri' parameter with the document URL to convert. For URLs with special characters (like SAS tokens), use POST with JSON body or URL-encode the URI parameter."
            }),
            status_code=400,
            mimetype="application/json"
        )
    
    # URL decode if it looks encoded (contains %XX patterns)
    if '%' in uri:
        try:
            uri = urllib.parse.unquote(uri)
            logging.info(f"URL-decoded URI to: {uri[:100]}...")
        except Exception as e:
            logging.warning(f"Failed to URL-decode URI: {e}")

    # Process the conversion
    result = await convert_from_uri(uri)
    
    if result.get("success"):
        # Return PDF as binary data
        return func.HttpResponse(
            body=result["data"],
            status_code=200,
            mimetype="application/pdf",
            headers={
                "Content-Disposition": f'attachment; filename="{result["filename"]}"',
                "Content-Type": "application/pdf"
            }
        )
    else:
        # Return error as JSON
        error_response = {k: v for k, v in result.items() if k != "success"}
        return func.HttpResponse(
            json.dumps(error_response),
            status_code=400 if "Unsupported" in str(result.get("error")) or "download" in str(result.get("error")) else 500,
            mimetype="application/json"
        )


async def handle_aiohttp_request(request: web.Request) -> web.Response:
    """
    aiohttp standalone server request handler.
    
    Supports file upload (multipart/form-data) and URI-based conversion.
    Returns streaming PDF response to avoid RAM bloat.
    """
    logging.info(f'Request received. Content-Type: {request.content_type}')
    
    result = None
    
    # Check if this is a multipart file upload (streaming upload)
    if request.content_type and 'multipart/form-data' in request.content_type:
        logging.info("Processing multipart file upload")
        try:
            reader = await request.multipart()
            file_data = None
            filename = None
            
            # Stream the file data
            async for part in reader:
                if part.name == 'file':
                    filename = part.filename or 'document'
                    # Read file in chunks to avoid RAM bloat
                    chunks = []
                    chunk_count = 0
                    while True:
                        chunk = await part.read_chunk(8192)  # 8KB chunks
                        if not chunk:
                            break
                        chunks.append(chunk)
                        chunk_count += 1
                    
                    file_data = b''.join(chunks)
                    logging.info(f"Received file: {filename}, size: {len(file_data)} bytes ({chunk_count} chunks)")
                    break
            
            if not file_data:
                return web.json_response(
                    {"error": "No file provided in multipart upload"},
                    status=400
                )
            
            # Convert from uploaded file
            result = await convert_from_stream(file_data, filename)
            
        except Exception as e:
            logging.error(f"Error processing multipart upload: {e}", exc_info=True)
            return web.json_response(
                {"error": "Failed to process file upload", "details": str(e)},
                status=400
            )
    else:
        # Try URI-based conversion
        uri = None
        
        # Try to get URI from query parameters
        uri = request.query.get('uri')
        if uri:
            logging.info(f"Found URI in query parameters: {uri[:100]}...")
            # URL decode if it looks encoded
            if '%' in uri:
                try:
                    decoded_uri = urllib.parse.unquote(uri)
                    logging.info(f"URL-decoded URI to: {decoded_uri[:100]}...")
                    uri = decoded_uri
                except Exception as e:
                    logging.warning(f"Failed to URL-decode URI: {e}")
        else:
            # Try to get from JSON body
            logging.info("URI not found in query parameters. Checking JSON body.")
            try:
                req_body = await request.json()
                if req_body:
                    uri = req_body.get('uri')
                    if uri:
                        logging.info(f"Found URI in JSON body: {uri[:100]}...")
            except json.JSONDecodeError:
                logging.info("Request body is not valid JSON.")
            except Exception as e:
                logging.warning(f"Error reading JSON body: {e}")

        if not uri:
            logging.warning("Neither file upload nor URI provided")
            return web.json_response(
                {
                    "error": "Please provide either a file upload or a 'uri' parameter",
                    "supported_methods": {
                        "file_upload": "POST with multipart/form-data and 'file' field",
                        "uri": "POST with JSON body containing 'uri' field, or GET with 'uri' query parameter"
                    }
                },
                status=400
            )

        # Validate URI format
        if not uri.startswith(('http://', 'https://')):
            logging.error(f"Invalid URI format: {uri}")
            return web.json_response(
                {"error": "Invalid URI format. Must start with http:// or https://"},
                status=400
            )

        # Process the conversion from URI
        result = await convert_from_uri(uri)
    
    # Return streaming response
    if result.get("success"):
        # Stream PDF response to avoid loading entire file in RAM
        return web.Response(
            body=result["data"],
            status=200,
            content_type="application/pdf",
            headers={
                "Content-Disposition": f'attachment; filename="{result["filename"]}"'
            }
        )
    else:
        # Return error as JSON
        error_response = {k: v for k, v in result.items() if k != "success"}
        status_code = 400 if "Unsupported" in str(result.get("error")) or "download" in str(result.get("error")) else 500
        return web.json_response(error_response, status=status_code)
