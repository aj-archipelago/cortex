"""
Model Configuration and Client Factory

Provides centralized model configuration and client creation for all LLM interactions.
Model configuration utilities.
"""

import os
from autogen_core.models import ModelInfo
from autogen_ext.models.openai import OpenAIChatCompletionClient


class ModelConfig:
    """Centralized model configuration and client factory."""

    # Model configurations
    MODEL_INFOS = {
        "o3": ModelInfo(
            model="o3",
            name="Cortex o3",
            max_tokens=128000,
            cost_per_token=0.0,
            vision=False,
            function_calling=True,
            json_output=False,
            family="openai",
            structured_output=False
        ),
        "o4-mini": ModelInfo(
            model="o4-mini",
            name="Cortex o4-mini",
            max_tokens=128000,
            cost_per_token=0.0,
            vision=False,
            function_calling=True,
            json_output=False,
            family="openai",
            structured_output=False
        ),
        "gpt-4.1": ModelInfo(
            model="gpt-4.1",
            name="Cortex gpt-4.1",
            max_tokens=32000,
            cost_per_token=0.0,
            vision=False,
            function_calling=True,
            json_output=False,
            family="openai",
            structured_output=False
        ),
        "gpt-5": ModelInfo(
            model="gpt-5",
            name="Cortex gpt-5",
            max_tokens=128000,
            cost_per_token=0.0,
            vision=False,
            function_calling=True,
            json_output=False,
            family="openai",
            structured_output=False
        ),
        "gpt-5-mini": ModelInfo(
            model="gpt-5-mini",
            name="Cortex gpt-5-mini",
            max_tokens=128000,
            cost_per_token=0.0,
            vision=False,
            function_calling=True,
            json_output=False,
            family="openai",
            structured_output=False
        ),
        "claude-4-sonnet": ModelInfo(
            model="claude-4-sonnet",
            name="Cortex claude-4-sonnet",
            max_tokens=128000,
            cost_per_token=0.0,
            vision=False,
            function_calling=True,
            json_output=False,
            family="openai",
            structured_output=False
        )
    }

    @classmethod
    def get_api_config(cls):
        """Get API configuration from environment."""
        return {
            "api_base_url": os.getenv("CORTEX_API_BASE_URL", "http://localhost:4000/v1"),
            "api_key": os.getenv("CORTEX_API_KEY")
        }

    @classmethod
    def create_model_client(cls, model_name: str, timeout: int = 900):
        """Create a wrapped model client for the specified model."""
        config = cls.get_api_config()

        if not config["api_key"]:
            raise ValueError("CORTEX_API_KEY environment variable is required")

        if model_name not in cls.MODEL_INFOS:
            raise ValueError(f"Unknown model: {model_name}")

        model_info = cls.MODEL_INFOS[model_name]

        # Create base client
        base_client = OpenAIChatCompletionClient(
            model=model_name,
            api_key=config["api_key"],
            base_url=config["api_base_url"],
            model_info=model_info,
            timeout=timeout
        )

        return base_client

    @classmethod
    def create_progress_model_client(cls):
        """Create a model client specifically for progress message generation."""
        config = cls.get_api_config()

        if not config["api_key"]:
            # Return None for progress generation - it will create its own client
            return None

        model_info = cls.MODEL_INFOS["gpt-4.1"]

        # Create base client with shorter timeout for progress
        base_client = OpenAIChatCompletionClient(
            model="gpt-4.1",
            api_key=config["api_key"],
            base_url=config["api_base_url"],
            model_info=model_info,
            timeout=30  # Shorter timeout for progress messages
        )

        return base_client

