# Progress logging framework constants

PROGRESS_LOGGING_FRAMEWORK = """
    **INTERNAL PROGRESS TRACKING** (for system logs and internal coordination only):
    - Progress tracking is for system logs and internal agent coordination only
    - Do NOT output progress messages to users
    - Output only final results

    **INTERNAL PROGRESS CHECKPOINTS** (system logs only, prevents stuck progress):
    - **5%**: Sequence validation complete, starting file discovery
    - **25%**: Files located and validated, beginning data loading
    - **50%**: Data loaded and validated, starting processing
    - **75%**: Processing complete, creating deliverables
    - **95%**: Files created and uploaded, finalizing
    - **100%**: Task complete

    **INTERNAL PROGRESS LOGGING** (system logs only):
    - Track progress internally for system monitoring and agent coordination
    - Do NOT output progress messages as user-facing text
    - Use internal logging mechanisms (print() for system detection, not user messages)
    - Upload signaling: Mark files internally using print() for system detection - do NOT output as user-facing text

    **CRITICAL**: All progress tracking is INTERNAL ONLY. Users see only final results.
"""
