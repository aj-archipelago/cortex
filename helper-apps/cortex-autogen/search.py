from azure.search.documents import SearchClient
from azure.core.credentials import AzureKeyCredential
import os
import requests
import uuid
from datetime import datetime, timezone
import logging

def search_index(keywords):
    search_client = SearchClient(
        endpoint=os.getenv("AZURE_COGNITIVE_API_URL"),
        index_name="index-autogen",
        credential=AzureKeyCredential(os.getenv("AZURE_COGNITIVE_API_KEY"))
    )

    results = search_client.search(search_text=keywords, top=5)
    return [dict(result) for result in results]

def search_cognitive_index(keywords, index_name, context_id=None):
    search_url = os.environ.get('AZURE_COGNITIVE_API_URL')
    api_key = os.environ.get('AZURE_COGNITIVE_API_KEY')
    
    headers = {
        'Content-Type': 'application/json',
        'api-key': api_key
    }
    
    query = {
        'search': keywords,
        'orderby': 'date desc',
        'top': 50,
        'select': 'title,date,content,url'
    }
    
    if index_name == "indexcortex" and context_id:
        query['filter'] = f"owner eq '{context_id}'"
    
    response = requests.post(f"{search_url}/indexes/{index_name}/docs/search?api-version=2020-06-30", 
                             headers=headers, json=query)
    
    if response.status_code == 200:
        return response.json()['value']
    else:
        print(f"Error searching cognitive index: {response.status_code}")
        return []

def search_all_indexes(keywords, context_id=None):
    #read indexes from the environment variables
    try:
        indexes = os.getenv("AZURE_COGNITIVE_INDEXES").split(",")
    except Exception as e:
        logging.error(f"Error reading indexes: {e}")
        indexes = []
    
    all_results = []
    
    for index in indexes:
        results = search_cognitive_index(keywords, index, context_id)
        all_results.extend(results)
    
    return all_results


def index_message(message):
    search_client = SearchClient(
        endpoint=os.getenv("AZURE_COGNITIVE_API_URL"),
        index_name="index-autogen",
        credential=AzureKeyCredential(os.getenv("AZURE_COGNITIVE_API_KEY_WRITE"))
    )

    document = {
        "id": str(uuid.uuid4()),
        "date": datetime.now(timezone.utc).isoformat(),
        "content": message.get("content"),
        "task": message.get("task"),
    }

    try:
        result = search_client.upload_documents([document])
    except Exception as e:
        logging.error(f"Error indexing message: {e}")
        result = None
    return result
