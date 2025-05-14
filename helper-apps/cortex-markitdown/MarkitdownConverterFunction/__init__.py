import logging
import azure.functions as func
from markitdown import MarkItDown
import json

# Initialize MarkItDown converter (do this once, outside the function handler if possible)
# This is a global instance to be reused across invocations for efficiency.
# For LLM-based image description, you might need to configure llm_client and llm_model
# e.g., md = MarkItDown(llm_client=OpenAI(), llm_model="gpt-4o")
# For simplicity, we'll use the basic setup here.
md = MarkItDown(enable_plugins=True)

def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Python HTTP trigger function processed a request.')

    uri = req.params.get('uri')
    if not uri:
        try:
            req_body = req.get_json()
        except ValueError:
            pass
        else:
            uri = req_body.get('uri')

    if uri:
        try:
            logging.info(f"Processing URI: {uri}")
            # The MarkItDown library's convert method can take a URI directly.
            # It can also handle local file paths if the function has access to them,
            # but for a typical HTTP-triggered Azure Function, a web URI is expected.
            result = md.convert(uri)
            
            # The result object has a text_content attribute
            markdown_content = result.text_content

            # Return the markdown content
            # We'll return it as JSON for easier consumption by clients
            response_data = {
                "uri": uri,
                "markdown": markdown_content
            }
            return func.HttpResponse(
                 json.dumps(response_data),
                 mimetype="application/json",
                 status_code=200
            )
        except Exception as e:
            logging.error(f"Error converting URI {uri}: {str(e)}")
            error_response = {
                "error": "Failed to convert URI to Markdown.",
                "details": str(e)
            }
            return func.HttpResponse(
                 json.dumps(error_response),
                 mimetype="application/json",
                 status_code=500
            )
    else:
        logging.warning("No URI provided in the request.")
        return func.HttpResponse(
             "Please pass a URI on the query string or in the request body",
             status_code=400
        ) 
    