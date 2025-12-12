"""
Cognitive Analysis Utilities for LLM-powered content analysis.

Provides deep cognitive analysis for walkthroughs and light awareness for progress messages.
"""
import logging
from typing import Dict, Any, Optional, List
from datetime import datetime

logger = logging.getLogger(__name__)


class CognitiveAnalyzer:
    """
    LLM-powered cognitive content analysis for agent messages.

    Provides both deep analysis (for walkthroughs) and light awareness (for progress).
    """

    def __init__(self, model_client):
        self.model_client = model_client
        self._cognitive_history: Dict[str, List[Dict]] = {}  # Track cognitive history per agent

    async def analyze_deep_cognitive(self, content: Any, agent_name: str, task_id: str) -> Dict[str, Any]:
        """
        Deep cognitive analysis using advanced LLM prompts for true brain-like understanding.
        """
        try:
            # Robust content extraction - handle dict objects gracefully
            if isinstance(content, dict):
                content_str = str(content.get('content', content))
            else:
                content_str = str(content)

            content_str = await self._extract_meaningful_content(content_str)

            # Import advanced prompts
            from .advanced_cognitive_prompts import DEEP_COGNITIVE_ANALYSIS_PROMPT

            # Prepare the analysis prompt
            message_type = await self._determine_message_type(content_str)

            analysis_prompt = DEEP_COGNITIVE_ANALYSIS_PROMPT.format(
                message_content=content_str,
                agent_name=agent_name,
                task_id=task_id,
                message_type=message_type,
                phase="execution"
            )

            # Create LLM messages
            messages = [
                {
                    "role": "system",
                    "content": "You are a master cognitive psychologist analyzing AI agent behavior. Provide deep, insightful analysis of cognitive processes, reasoning patterns, and behavioral characteristics. Always respond with valid JSON."
                },
                {
                    "role": "user",
                    "content": analysis_prompt
                }
            ]

            # Call the LLM for deep analysis
            response = await self.model_client.create(messages)

            # Parse the JSON response
            analysis_result = self._parse_llm_json_response(response.content)

            # Enhance with metadata
            analysis_result.update({
                "timestamp": datetime.now().isoformat(),
                "agent_name": agent_name,
                "task_id": task_id,
                "analysis_method": "advanced_llm_brain",
                "content_sample": content_str[:200] + "..." if len(content_str) > 200 else content_str,
                "is_cognitive": True  # Mark as cognitive content for walkthrough logging
            })

            # Update cognitive journey tracking
            from .cognitive_journey_mapper import get_cognitive_journey_mapper
            journey_mapper = get_cognitive_journey_mapper()
            journey_mapper.update_journey_state(task_id, agent_name, analysis_result, content_str)

            # Perform meta-cognitive analysis (how agent thinks about its own thinking)
            try:
                from .meta_cognitive_analyzer import get_meta_cognitive_analyzer
                meta_analyzer = get_meta_cognitive_analyzer(self.model_client)

                # Get recent cognitive history for context
                recent_history = []
                if hasattr(self, '_cognitive_history') and agent_name in self._cognitive_history:
                    recent_history = self._cognitive_history[agent_name][-5:]

                meta_analysis = await meta_analyzer.analyze_meta_cognition(
                    agent_name, task_id, content_str, recent_history
                )

                # Merge meta-cognitive insights into main analysis
                analysis_result["meta_cognitive"] = {
                    "self_awareness_level": meta_analysis.get("self_awareness_level"),
                    "strategy_evaluation": meta_analysis.get("strategy_evaluation"),
                    "cognitive_monitoring": meta_analysis.get("cognitive_monitoring"),
                    "learning_metacognition": meta_analysis.get("learning_metacognition"),
                    "meta_insights": meta_analysis.get("meta_cognitive_insights", [])
                }

            except Exception as meta_error:
                logger.warning(f"Meta-cognitive analysis failed: {str(meta_error)}")
                analysis_result["meta_cognitive"] = {"error": "Meta-cognitive analysis unavailable"}

            # Store cognitive analysis for future meta-analysis
            self._store_cognitive_history(agent_name, analysis_result)

            # Record in learning memory system
            from .learning_memory_system import get_learning_memory
            learning_memory = get_learning_memory()

            # Extract task type from task_id (simple heuristic)
            task_type = self._extract_task_type(task_id)

            # Record based on cognitive assessment
            decision_score = analysis_result.get("decision_quality_score", 5)

            if decision_score >= 7:
                # Record success pattern
                learning_memory.record_success_pattern(
                    task_type=task_type,
                    agent_name=agent_name,
                    strategy=analysis_result.get("decision_model", "unknown"),
                    context={
                        "cognitive_depth": analysis_result.get("cognitive_depth"),
                        "confidence_level": analysis_result.get("confidence_level"),
                        "journey_stage": analysis_result.get("journey_stage")
                    },
                    outcome_metrics={
                        "decision_quality": decision_score,
                        "reasoning_quality": analysis_result.get("reasoning_sophistication_score", 5),
                        "completed": True,
                        "duration_seconds": 0  # Would be filled from actual timing
                    }
                )
            elif decision_score <= 3:
                # Record failure pattern
                learning_memory.record_failure_pattern(
                    task_type=task_type,
                    agent_name=agent_name,
                    failed_strategy=analysis_result.get("decision_model", "unknown"),
                    context={
                        "cognitive_depth": analysis_result.get("cognitive_depth"),
                        "confidence_level": analysis_result.get("confidence_level")
                    },
                    failure_reason=f"Poor decision quality (score: {decision_score})",
                    recovery_strategy=analysis_result.get("recommendations", ["Review approach"])[0] if analysis_result.get("recommendations") else None
                )

            # Record task insights
            key_insights = analysis_result.get("key_insights", [])
            if key_insights:
                for insight in key_insights[:2]:  # Top 2 insights
                    learning_memory.record_task_insight(
                        task_type=task_type,
                        insight_type="cognitive_pattern",
                        insight_content=insight,
                        context={"agent": agent_name, "analysis_type": "deep_cognitive"},
                        applicability_score=min(10, max(1, analysis_result.get("decision_quality_score", 5)))
                    )

            return analysis_result

        except Exception as e:
            logger.error(f"Critical cognitive analysis failure: {str(e)} for {agent_name}")
            # Absolute emergency fallback
            return {
                "is_cognitive": False,
                "cognitive_type": "unknown",
                "journey_stage": "execution",
                "confidence_score": 5.0,
                "emotional_tone": "neutral",
                "learning_value": "none",
                "reasoning_depth": "unknown",
                "key_insights": ["Analysis system failure"],
                "decision_points": [],
                "challenges_identified": ["system_failure"],
                "solutions_attempted": ["emergency_fallback"],
                "analysis_method": "emergency_fallback",
                "timestamp": datetime.now().isoformat(),
                "agent_name": agent_name,
                "task_id": task_id,
                "content_sample": content_str[:100] + "..." if len(content_str) > 100 else content_str
            }

        # Add predictive analysis
        try:
            from .predictive_analyzer import get_predictive_analyzer
            from .learning_memory_system import get_learning_memory

            learning_memory = get_learning_memory()
            predictive_analyzer = get_predictive_analyzer(learning_memory)

            predictive_insights = await predictive_analyzer.analyze_predictive_risks(
                agent_name, task_id, analysis, {"task_type": self._extract_task_type(task_id)}
            )

            analysis["predictive_analysis"] = {
                "risk_level": predictive_insights.get("risk_level"),
                "predicted_issues": predictive_insights.get("predicted_issues", []),
                "preventive_actions": predictive_insights.get("preventive_actions", []),
                "alternative_strategies": predictive_insights.get("alternative_strategies", [])
            }

        except Exception as pred_error:
            logger.warning(f"Predictive analysis failed: {str(pred_error)}")
            analysis["predictive_analysis"] = {"error": "Predictive analysis unavailable"}

        return analysis

    def _store_cognitive_history(self, agent_name: str, analysis: Dict[str, Any]) -> None:
        """Store cognitive analysis results for future meta-cognitive analysis."""
        if agent_name not in self._cognitive_history:
            self._cognitive_history[agent_name] = []
        self._cognitive_history[agent_name].append({
            "timestamp": analysis.get("timestamp"),
            "cognitive_type": analysis.get("cognitive_type"),
            "confidence": analysis.get("confidence_score"),
            "key_insights": analysis.get("key_insights", [])
        })

    async def _determine_message_type(self, content: str) -> str:
        """Use LLM to determine message type - no static patterns."""
        try:
            prompt = f"""Classify this message type: "{content[:200]}..."

Return one word: function_call, function_result, error_message, success_message, planning_message, or communication_message."""

            messages = [
                {"role": "system", "content": "Classify agent messages. Return only one word from the allowed types."},
                {"role": "user", "content": prompt}
            ]

            response = await self.model_client.create(messages)
            result = response.content.strip().lower()

            allowed_types = ["function_call", "function_result", "error_message", "success_message", "planning_message", "communication_message"]
            return result if result in allowed_types else "communication_message"

        except Exception as e:
            # Pure LLM-powered - no static fallback patterns
            # Return safe default on any error to prevent system failures
            return "communication_message"
            return "communication_message"

    def _parse_llm_json_response(self, response_content: str) -> Dict[str, Any]:
        """Parse JSON response from LLM, with fallback handling."""
        from util.json_extractor import extract_json_from_llm_response
        
        result = extract_json_from_llm_response(response_content, expected_type=dict, log_errors=True)
        if result:
            return result
        
        # Fallback: return empty dict if extraction fails
        print(f"⚠️ JSON PARSING FAILED, content: {response_content[:200]}")
        # Return a structured fallback
        return {
            "cognitive_depth": "unknown",
            "reasoning_quality": "unknown",
            "decision_model": "unknown",
            "confidence_level": "unknown",
            "emotional_tone": "neutral",
            "cognitive_load": "unknown",
                "journey_stage": "execution",
                "progress_direction": "unknown",
                "learning_evidence": "unknown",
                "adaptation_level": "unknown",
                "key_insights": ["LLM response parsing failed"],
                "cognitive_patterns": ["analysis_error"],
                "decision_quality_score": 5,
                "reasoning_sophistication_score": 5,
                "behavioral_assessment": "Unable to analyze due to parsing error",
                "recommendations": ["Retry analysis", "Check LLM response format"]
            }

        # LLM provides all analysis - no static pattern matching
        analysis.update({
                "timestamp": datetime.now().isoformat(),
                "agent_name": agent_name,
                "task_id": task_id,
            "content_sample": content[:200] + "..." if len(content) > 200 else content,
            "behavioral_assessment": f"Agent {agent_name} showing {analysis['cognitive_depth']} cognitive processing with {analysis['emotional_tone']} tone",
            "recommendations": ["Monitor for pattern consistency", "Note effective strategies"]
        })

        # Store key cognitive metrics for historical analysis
        history_entry = {
            "timestamp": datetime.now().isoformat(),
            "cognitive_depth": analysis.get("cognitive_depth"),
            "reasoning_quality": analysis.get("reasoning_quality"),
            "confidence_level": analysis.get("confidence_level"),
            "emotional_tone": analysis.get("emotional_tone"),
            "cognitive_load": analysis.get("cognitive_load"),
            "journey_stage": analysis.get("journey_stage"),
            "decision_quality_score": analysis.get("decision_quality_score"),
            "reasoning_sophistication_score": analysis.get("reasoning_sophistication_score")
        }

        self._cognitive_history[agent_name].append(history_entry)

        # Keep only recent history (last 20 entries per agent)
        if len(self._cognitive_history[agent_name]) > 20:
            self._cognitive_history[agent_name] = self._cognitive_history[agent_name][-20:]

    def _extract_task_type(self, task_id: str) -> str:
        """Extract task type from task ID for learning categorization."""

        # Simple heuristics based on common task patterns
        task_lower = task_id.lower()

        if "csv" in task_lower or "data" in task_lower:
            return "data_processing"
        elif "image" in task_lower or "chart" in task_lower or "plot" in task_lower:
            return "visualization"
        elif "search" in task_lower or "find" in task_lower:
            return "information_retrieval"
        elif "code" in task_lower or "program" in task_lower:
            return "code_generation"
        elif "plan" in task_lower or "strategy" in task_lower:
            return "planning"
        elif "write" in task_lower or "article" in task_lower:
            return "content_creation"
        elif "analyze" in task_lower or "analysis" in task_lower:
            return "data_analysis"
        elif "report" in task_lower or "summary" in task_lower:
            return "reporting"
        else:
            return "general_task"


    async def _extract_meaningful_content(self, content: str) -> str:
        """
        Use LLM to extract cognitively meaningful content - no static parsing.
        """
        try:
            if not content or len(str(content).strip()) < 5:
                return str(content).strip()

            prompt = f"""Extract the core cognitive essence from this message. Focus on thinking, decisions, problems, solutions, and key information:

"{str(content)[:600]}"

Return only the meaningful cognitive content, no boilerplate."""

            messages = [
                {"role": "system", "content": "Extract cognitive content from agent messages. Remove noise, focus on thinking and decisions."},
                {"role": "user", "content": prompt}
            ]

            response = await self.model_client.create(messages)
            result = response.content.strip()

            return result if result else str(content).strip()

        except Exception:
            # Fallback to simple extraction
            content_str = str(content).strip()
            if len(content_str) > 1000:
                return content_str[:1000] + "..."
            return content_str

    async def analyze_light_cognitive(self, content: str, agent_name: str) -> Dict[str, Any]:
        """
        Brain-powered cognitive awareness using LLM analysis.
        No static patterns - pure LLM intelligence.
        """
        try:
            # Use LLM to analyze content for progress context
            prompt = f"""Analyze this agent message for progress reporting context. Respond with JSON:

Message: "{content}"
Agent: {agent_name}

Return JSON with:
- has_cognitive_content (boolean): true if message shows thinking/reasoning
- content_type: "planning", "execution", "problem_solving", "success", "error", or "communication"
- urgency: "high", "medium", or "low" based on importance/timeline
- key_themes: array of 1-3 main topics/concepts
- emotional_tone: "confident", "frustrated", "analytical", "urgent", or "neutral"

JSON format only."""

            messages = [
                {"role": "system", "content": "You are an expert at analyzing agent communications for progress reporting. Return only valid JSON."},
                {"role": "user", "content": prompt}
            ]

            response = await self.model_client.create(messages)

            # Parse LLM response
            import json
            result = json.loads(response.content.strip())

            return {
                "has_cognitive_content": result.get("has_cognitive_content", False),
                "content_type": result.get("content_type", "general"),
                "urgency": result.get("urgency", "medium"),
                "cognitive_indicators": result.get("key_themes", []),
                "analysis_method": "llm_brain_analysis",
                "content_length": len(content),
                "agent_type": agent_name,
                "emotional_tone": result.get("emotional_tone", "neutral")
            }

        except Exception as e:
            logger.error(f"LLM brain analysis failed: {e}")
            return {
                "has_cognitive_content": False,
                "content_type": "unknown",
                "urgency": "low",
                "cognitive_indicators": [],
                "analysis_method": "llm_error_fallback",
                "content_length": len(content),
                "agent_type": agent_name
            }



# Global instance for reuse
_cognitive_analyzer = None

def get_cognitive_analyzer(model_client) -> CognitiveAnalyzer:
    """Get or create cognitive analyzer instance."""
    global _cognitive_analyzer
    if _cognitive_analyzer is None or _cognitive_analyzer.model_client != model_client:
        _cognitive_analyzer = CognitiveAnalyzer(model_client)
    return _cognitive_analyzer
