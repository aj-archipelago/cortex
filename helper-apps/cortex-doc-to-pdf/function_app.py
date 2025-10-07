"""Main application entry point for Azure Functions and standalone server."""

import azure.functions as func
import logging
import asyncio
from aiohttp import web
import os
from request_handlers import handle_azure_function_request, handle_aiohttp_request

# Azure Functions app
app = func.FunctionApp(http_auth_level=func.AuthLevel.FUNCTION)


@app.route(route="convert")
async def http_convert_trigger(req: func.HttpRequest) -> func.HttpResponse:
    """
    Azure Function HTTP trigger for document to PDF conversion.
    
    Note: For GET requests with URLs containing special characters (like Azure SAS tokens),
    the URI should be URL-encoded, or use POST with JSON body instead.
    """
    return await handle_azure_function_request(req)


# ============================================================================
# Standalone aiohttp server for container deployment
# ============================================================================

async def main_server():
    """Main function to run the standalone aiohttp server."""
    logging.basicConfig(
        level=logging.INFO,
        format='%(asctime)s - %(levelname)s - %(message)s'
    )
    
    port_str = os.environ.get("PORT", "8080")
    try:
        port = int(port_str)
    except ValueError:
        logging.warning(f"Invalid PORT environment variable '{port_str}'. Defaulting to 8080.")
        port = 8080
    
    aiohttp_app = web.Application()
    
    # Conversion endpoints (both /convert and / root)
    aiohttp_app.router.add_post('/convert', handle_aiohttp_request)
    aiohttp_app.router.add_get('/convert', handle_aiohttp_request)
    aiohttp_app.router.add_post('/', handle_aiohttp_request)  # Root path also works
    
    # Health check endpoint
    async def health_check(request):
        return web.json_response({"status": "healthy", "service": "doc-to-pdf-converter"})
    
    aiohttp_app.router.add_get('/health', health_check)
    aiohttp_app.router.add_get('/', health_check)  # GET / returns health check

    runner = web.AppRunner(aiohttp_app)
    await runner.setup()
    site = web.TCPSite(runner, '0.0.0.0', port)
    await site.start()
    
    logging.info(f"🚀 Document to PDF Converter server started on http://0.0.0.0:{port}")
    print(f"======== Running on http://0.0.0.0:{port} ========")
    print(f"======== Convert: POST http://0.0.0.0:{port}/ or /convert ========")
    print(f"======== Health: GET http://0.0.0.0:{port}/health ========")
    print("(Press CTRL+C to quit)")
    
    try:
        while True:
            await asyncio.sleep(3600)
    except KeyboardInterrupt:
        logging.info("Server shutting down...")
    finally:
        await runner.cleanup()
        logging.info("Server stopped.")


if __name__ == "__main__":
    """Run as standalone server when executed directly."""
    try:
        asyncio.run(main_server())
    except KeyboardInterrupt:
        logging.info("Application shut down by user.")
    except Exception as e:
        logging.critical(f"Application failed to start or crashed: {e}")