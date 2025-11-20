"""
Entity API tools for fetching images and data for specific entity types.
"""

import json
import logging
from typing import List, Optional
from autogen_core.tools import FunctionTool

logger = logging.getLogger(__name__)

# Load entity API registry
try:
    with open("tools/entity_api_registry.json", "r") as f:
        ENTITY_REGISTRY = json.load(f)
except Exception as e:
    logger.error(f"Failed to load entity registry: {e}")
    ENTITY_REGISTRY = {}

def list_available_entity_types() -> str:
    """List all available entity types for image fetching."""
    return json.dumps(list(ENTITY_REGISTRY.keys()), indent=2)

async def fetch_entity_images(
    entities: List[str],
    entity_type: str,
    count_per_entity: int = 1,
    force_web_search: bool = False
) -> str:
    """
    Fetch images for structured entities using APIs with web search fallback.

    Args:
        entities: List of entity names to fetch images for
        entity_type: Type of entity (pokemon, country, movie, etc.)
        count_per_entity: Number of images to fetch per entity
        force_web_search: Force web search instead of API

    Returns:
        JSON string with fetched images
    """
    try:
        import aiohttp
        import asyncio
        from tools.search_tools import collect_images

        results = []

        for entity in entities[:5]:  # Limit to 5 entities
            entity_results = []

            if not force_web_search and entity_type in ENTITY_REGISTRY:
                # Try API first
                config = ENTITY_REGISTRY[entity_type]
                if config.get("enabled", True):
                    try:
                        url = config["url_pattern"].format(entity=entity.lower() if config.get("entity_transform") == "lowercase" else entity)
                        async with aiohttp.ClientSession() as session:
                            async with session.get(url, timeout=10) as response:
                                if response.status == 200:
                                    data = await response.json()
                                    # Extract images from API response
                                    for field_path in config.get("image_fields", []):
                                        try:
                                            value = data
                                            for part in field_path.split('.'):
                                                if part.startswith('[') and part.endswith(']'):
                                                    index = int(part[1:-1])
                                                    value = value[index]
                                                else:
                                                    value = value[part]
                                            if value and isinstance(value, str) and value.startswith('http'):
                                                entity_results.append({
                                                    "url": value,
                                                    "title": f"{entity} {entity_type}",
                                                    "source": "api"
                                                })
                                        except (KeyError, IndexError, TypeError):
                                            continue
                    except Exception as e:
                        logger.warning(f"API fetch failed for {entity}: {e}")

            # Fallback to web search if no API results or forced
            if len(entity_results) < count_per_entity:
                try:
                    search_query = config.get("fallback_search_query", f"{entity} {entity_type}").format(entity=entity)
                    search_results = await collect_images(search_query, count=count_per_entity - len(entity_results))
                    search_data = json.loads(search_results)
                    if isinstance(search_data, list):
                        for item in search_data:
                            if isinstance(item, dict) and item.get("url"):
                                entity_results.append({
                                    "url": item["url"],
                                    "title": item.get("title", f"{entity} {entity_type}"),
                                    "source": "web_search"
                                })
                except Exception as e:
                    logger.warning(f"Web search fallback failed for {entity}: {e}")

            results.extend(entity_results[:count_per_entity])

        return json.dumps(results, indent=2)

    except Exception as e:
        return json.dumps({"error": f"Entity image fetch failed: {str(e)}"})

# Create FunctionTool instances
list_entity_types_tool = FunctionTool(
    list_available_entity_types,
    description="List all available entity types that can be used with fetch_entity_images() for structured data like Pokemon, countries, movies, etc."
)

fetch_entity_images_tool = FunctionTool(
    fetch_entity_images,
    description="Fetch images for structured entities using specialized APIs with automatic web search fallback. Works for categorized items like characters, countries, or any entity with known data sources."
)
