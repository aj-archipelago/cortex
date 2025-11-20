from datetime import datetime
import os

def create_request_context_vars(request_id: str, work_dir: str) -> str:
    """
    Create Python variables for request context that agents can use.
    Includes current date and time to ensure agents are temporally aware.
    """
    now = datetime.now()
    current_date = now.strftime("%Y-%m-%d")
    current_time = now.strftime("%H:%M:%S")
    current_year = now.strftime("%Y")
    
    return f"""
# Request context - DO NOT MODIFY
request_id = '{request_id}'
work_dir = '{work_dir}'
current_date = '{current_date}'
current_time = '{current_time}'
current_year = '{current_year}'
# End context
"""
