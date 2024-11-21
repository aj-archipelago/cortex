from config import prompts
from datetime import datetime

def process_helper_results(helper_decider_result, original_request_message, context, chat):
    def add_to_context(result, prefix):
        nonlocal context
        context += f"\n\n{prefix}: {result}"

    if helper_decider_result.get("sql"):
        sql_message = f"Use SQL to help solving task, provide any related data and code that may help: {original_request_message}."
        result = chat(prompts.get("SQL_PROMPT"), sql_message, return_type="all_as_str")
        add_to_context(result, "SQL results")

    return context
