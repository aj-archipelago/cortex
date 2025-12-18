"""
Dynamic Agent Loader - Unified interface for agent modules.

This module provides a unified interface for loading agents regardless of whether
the internal version (agents/) or open source version (agents_os/) is present.

Priority: agents/ (internal) > agents_os/ (open source)
"""

import os
import importlib
import sys


def get_agent_module():
    """Get agent module based on available folders."""
    current_dir = os.path.dirname(os.path.abspath(__file__))

    # Check for agents/ first (internal version with AJ agents)
    if os.path.exists(os.path.join(current_dir, 'agents')):
        return 'agents'

    # Fall back to agents_os/ (open source version)
    elif os.path.exists(os.path.join(current_dir, 'agents_os')):
        return 'agents_os'

    else:
        raise ImportError("No agent folder found (agents/ or agents_os/)")


# Dynamic module loading
agent_module = get_agent_module()

# Unified interface - same imports regardless of folder
agent_factory = importlib.import_module(f'{agent_module}.util.agent_factory')
constants = importlib.import_module(f'{agent_module}.constants')
helpers = importlib.import_module(f'{agent_module}.util.helpers')

# Convenience functions for backward compatibility
def get_agents(*args, **kwargs):
    """Convenience function for get_agents."""
    return agent_factory.get_agents(*args, **kwargs)
