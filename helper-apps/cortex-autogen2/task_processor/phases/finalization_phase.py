"""
Upload and presentation phase handler.
"""
import json
import logging

from agents.util.workflow_utils import run_agent_with_timeout, extract_json_from_response
from context.logging_utils import log_phase_start
from .presenter_phase import PresenterPhase

logger = logging.getLogger(__name__)


class DeliveryPhase:
    """Handles upload phase followed by presentation phase."""

    def __init__(self, context_memory, progress_handler, logger=None):
        self.context_memory = context_memory
        self.progress_handler = progress_handler
        self.presenter_phase = PresenterPhase(context_memory, logger)
        self.logger = logger or logging.getLogger(__name__)

    async def run_upload_phase(self, task_id: str, task: str, work_dir: str,
                              uploader_agent, execution_context: str = "", plan_text: str = "") -> dict:
        """Run the upload phase - decide and upload files."""
        await self.progress_handler.handle_progress_update(task_id, 0.94, "📤 Processing deliverables...")

        # Upload Phase - let uploader_agent decide and upload files
        upload_response = await self._execute_uploader_agent(uploader_agent, task, work_dir, plan_text, task_id)

        await self.progress_handler.handle_progress_update(task_id, 0.96, "✅ Files uploaded successfully")
        return upload_response

    async def run_present_phase(self, task_id: str, task: str, work_dir: str,
                               presenter_agent, execution_context: str = "", plan_text: str = "") -> str:
        """Run the presentation phase - create final presentation."""
        await self.progress_handler.handle_progress_update(task_id, 0.97, "✨ Finalizing your results...")

        # Get the latest upload results from context memory
        upload_response = {}
        if self.context_memory:
            # Get the most recent upload results
            file_summaries = self.context_memory.get_file_summaries()
            if file_summaries:
                # Look for upload results in the summaries
                for summary in file_summaries.values():
                    if isinstance(summary, dict) and "uploads" in summary:
                        upload_response = summary
                        break

        # Generate comprehensive context for presenter using ContextMemory
        if self.context_memory:
            presenter_context = await self.context_memory.get_presenter_context(
                task, upload_response, plan_text
            )
        else:
            # Fallback to simple context
            upload_json = json.dumps(upload_response)
            presenter_context = f"Task: {task}\n\nUpload Results:\n{upload_json}\n\nPlan: {plan_text}"

        final_result = await self.presenter_phase.run_presenter_agent(presenter_agent, presenter_context, work_dir, task_id)

        await self.progress_handler.handle_progress_update(task_id, 1.0, "🎉 Your task is complete!", data=final_result)
        return final_result

    # Keep the old method for backward compatibility
    async def run_upload_and_present_phase(self, task_id: str, task: str, work_dir: str,
                                         uploader_agent, presenter_agent, execution_context: str = "", plan_text: str = "") -> str:
        """Legacy method - runs both upload and present phases."""
        await self.run_upload_phase(task_id, task, work_dir, uploader_agent, execution_context, plan_text)
        return await self.run_present_phase(task_id, task, work_dir, presenter_agent, execution_context, plan_text)

    async def _execute_uploader_agent(self, uploader_agent, task: str, work_dir: str, plan_text: str, task_id: str) -> dict:
        """Execute the uploader agent to decide which files to upload, then upload them."""
        file_summaries = self.context_memory.get_file_summaries() if self.context_memory else {}

        # Pre-list all files in work directory
        available_files = self._list_all_files(work_dir)

        uploader_task = f"""You are the Upload Decision Agent. Analyze the task and decide which files should be uploaded.

TASK: {task}

EXECUTION PLAN: {plan_text}

WORK DIRECTORY: {work_dir}

ALL AVAILABLE FILES (already discovered):
{json.dumps(available_files, indent=2)}

CONTEXT FROM EXECUTION:
{json.dumps(file_summaries, indent=2) if file_summaries else "No execution context available"}

DECISION CRITERIA:
- Upload ONLY final deliverable files that users actually need
- Include: CSVs, PNGs, PDFs, PPTX, XLSX (final results)
- Skip: temporary files (tmp_*), hidden files (.*), logs/, intermediate files
- Skip: preview images unless they are the main deliverable
- Focus on files that represent completed work/results

OUTPUT FORMAT - Return ONLY valid JSON:
{{
  "files_to_upload": ["filename1.csv", "filename2.png", "filename3.pdf"],
  "reasoning": "Brief explanation of why these files were selected"
}}

Select the minimum necessary files that fully satisfy the user's request.
"""

        try:
            # Get decision from uploader agent
            uploader_result = await run_agent_with_timeout(uploader_agent, uploader_task, 60, self.logger)
            decision_text = str(uploader_result.messages[-1].content) if uploader_result.messages else "{}"
            decision = extract_json_from_response(decision_text)

            files_to_upload = decision.get("files_to_upload", [])
            self.logger.info(f"Uploader agent selected {len(files_to_upload)} files to upload: {files_to_upload}")

            # Now actually upload the selected files
            if files_to_upload:
                upload_result = await self._upload_selected_files(files_to_upload, work_dir)

                # Log upload results for learning and debugging
                if self.context_memory:
                    uploads = upload_result.get("uploads", [])
                    self.context_memory.record_upload_result(
                        uploads=uploads,
                        message=json.dumps(upload_result),
                        task_id=task_id,
                        metadata={"phase": "upload", "upload_count": len(uploads)}
                    )

                return upload_result
            else:
                self.logger.info("Uploader agent decided no files need uploading")
                return {"success": True, "uploads": [], "total_uploaded": 0, "total_failed": 0, "message": "No files selected for upload"}

        except Exception as e:
            self.logger.error(f"❌ Uploader agent failed: {e}")
            return {"success": False, "error": str(e), "uploads": [], "total_uploaded": 0, "total_failed": 0}

    def _list_all_files(self, work_dir: str) -> list:
        """List all files in work directory, excluding logs and temp files."""
        import os
        files = []

        if not os.path.exists(work_dir):
            return files

        for root, dirs, filenames in os.walk(work_dir):
            # Skip logs directory
            if 'logs' in dirs:
                dirs.remove('logs')

            for filename in filenames:
                # Skip hidden files, temp files
                if filename.startswith('.') or filename.startswith('tmp_'):
                    continue

                rel_path = os.path.relpath(os.path.join(root, filename), work_dir)
                files.append(rel_path)

        return files

    async def _upload_selected_files(self, files_to_upload: list, work_dir: str) -> dict:
        """Upload the selected files using the Azure upload tools."""
        try:
            # Convert relative paths to absolute paths
            abs_paths = []
            for filename in files_to_upload:
                if os.path.isabs(filename):
                    abs_paths.append(filename)
                else:
                    abs_paths.append(os.path.join(work_dir, filename))

            # Use the unified upload tool
            from tools.upload_tools import upload_files_unified
            result = upload_files_unified(abs_paths, work_dir)
            upload_result = json.loads(result) if isinstance(result, str) else result

            self.logger.info(f"Successfully uploaded {upload_result.get('total_uploaded', 0)} files")
            return upload_result

        except Exception as e:
            self.logger.error(f"File upload failed: {e}")
            return {"success": False, "error": str(e), "uploads": [], "total_uploaded": 0, "total_failed": len(files_to_upload)}
