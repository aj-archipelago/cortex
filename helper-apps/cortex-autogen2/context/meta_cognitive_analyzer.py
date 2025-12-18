"""
Meta-Cognitive Analysis Layer

Enables agents to analyze their own thinking patterns, decision-making processes,
and cognitive strategies. Provides self-reflection and cognitive self-awareness.
"""

import logging
from typing import Dict, List, Any, Optional
from datetime import datetime

logger = logging.getLogger(__name__)


class MetaCognitiveAnalyzer:
    """
    Meta-cognitive analysis layer for self-reflective agent behavior.

    Analyzes how agents think about their own cognition, decision-making,
    and problem-solving strategies.
    """

    def __init__(self, model_client):
        self.model_client = model_client
        self.agent_cognitive_history: Dict[str, List[Dict]] = {}
        self.self_reflection_patterns: Dict[str, Dict] = {}

    async def analyze_meta_cognition(self, agent_name: str, task_id: str,
                                   current_message: str, recent_history: List[Dict]) -> Dict[str, Any]:
        """
        Perform meta-cognitive analysis on an agent's thinking about its own cognition.

        Analyzes self-awareness, strategy evaluation, cognitive monitoring, and learning metacognition.
        """

        try:
            # Build context from recent history
            context_summary = self._build_cognitive_context(recent_history)

            # Use meta-cognitive analysis prompt
            from .advanced_cognitive_prompts import META_COGNITIVE_ANALYSIS_PROMPT

            prompt = META_COGNITIVE_ANALYSIS_PROMPT.format(
                message_content=current_message,
                cognitive_context=context_summary
            )

            messages = [
                {
                    "role": "system",
                    "content": "You are a cognitive psychologist specializing in meta-cognition. Analyze how AI agents think about their own thinking processes, decision-making, and learning strategies."
                },
                {
                    "role": "user",
                    "content": prompt
                }
            ]

            response = await self.model_client.create(messages)

            analysis_result = self._parse_meta_cognitive_response(response.content)

            # Enhance with agent-specific patterns
            analysis_result = self._enhance_with_agent_patterns(agent_name, analysis_result)

            # Store for future meta-analysis
            self._store_meta_cognitive_insight(agent_name, task_id, analysis_result)

            logger.info(f"🧠 META-COGNITION: {agent_name} shows {analysis_result.get('self_awareness_level', 'unknown')} self-awareness")

            return analysis_result

        except Exception as e:
            logger.error(f"Meta-cognitive analysis failed for {agent_name}: {str(e)}")
            return self._fallback_meta_analysis(agent_name, task_id, current_message, recent_history)

    def _build_cognitive_context(self, recent_history: List[Dict]) -> str:
        """Build cognitive context from recent agent history."""

        if not recent_history:
            return "No recent cognitive history available."

        context_parts = []

        for entry in recent_history[-5:]:  # Last 5 entries
            timestamp = entry.get('timestamp', 'unknown')
            cognitive_depth = entry.get('cognitive_depth', 'unknown')
            reasoning_quality = entry.get('reasoning_quality', 'unknown')
            confidence = entry.get('confidence_level', 'unknown')

            context_parts.append(
                f"At {timestamp}: {cognitive_depth} cognition, {reasoning_quality} reasoning, {confidence} confidence"
            )

        return "Recent cognitive history:\n" + "\n".join(context_parts)

    def _parse_meta_cognitive_response(self, response_content: str) -> Dict[str, Any]:
        """Parse meta-cognitive analysis response."""

        try:
            from util.json_extractor import extract_json_from_llm_response
            
            result = extract_json_from_llm_response(response_content, expected_type=dict, log_errors=True)
            if result:
                return result
            # Fallback to empty dict
            return {}

        except Exception as parse_error:
            logger.warning(f"Meta-cognitive JSON parsing failed: {str(parse_error)}")
            return {
                "self_awareness_level": "unknown",
                "strategy_evaluation": "unknown",
                "cognitive_monitoring": "unknown",
                "learning_metacognition": "unknown",
                "meta_cognitive_insights": ["Analysis parsing failed"],
                "thinking_improvements": ["Retry analysis"]
            }

    def _enhance_with_agent_patterns(self, agent_name: str, analysis: Dict[str, Any]) -> Dict[str, Any]:
        """Enhance analysis with agent-specific patterns."""

        if agent_name not in self.self_reflection_patterns:
            self.self_reflection_patterns[agent_name] = {
                "typical_self_awareness": "medium",
                "common_weaknesses": [],
                "strengths": [],
                "learning_patterns": []
            }

        patterns = self.self_reflection_patterns[agent_name]

        # Add pattern-based enhancements
        if analysis.get("self_awareness_level") == "high":
            patterns["strengths"].append("strong_self_awareness")
        elif analysis.get("self_awareness_level") == "low":
            patterns["common_weaknesses"].append("limited_self_awareness")

        # Add pattern insights to analysis
        analysis["agent_patterns"] = {
            "typical_self_awareness": patterns["typical_self_awareness"],
            "recurring_strengths": list(set(patterns["strengths"][-3:])),  # Last 3
            "recurring_weaknesses": list(set(patterns["common_weaknesses"][-3:]))
        }

        return analysis

    def _store_meta_cognitive_insight(self, agent_name: str, task_id: str, analysis: Dict[str, Any]) -> None:
        """Store meta-cognitive insights for future analysis."""

        if agent_name not in self.agent_cognitive_history:
            self.agent_cognitive_history[agent_name] = []

        insight = {
            "timestamp": datetime.now().isoformat(),
            "task_id": task_id,
            "self_awareness_level": analysis.get("self_awareness_level"),
            "strategy_evaluation": analysis.get("strategy_evaluation"),
            "cognitive_monitoring": analysis.get("cognitive_monitoring"),
            "learning_metacognition": analysis.get("learning_metacognition"),
            "key_insights": analysis.get("meta_cognitive_insights", []),
            "improvement_suggestions": analysis.get("thinking_improvements", [])
        }

        self.agent_cognitive_history[agent_name].append(insight)

        # Keep only recent history (last 50 entries per agent)
        if len(self.agent_cognitive_history[agent_name]) > 50:
            self.agent_cognitive_history[agent_name] = self.agent_cognitive_history[agent_name][-50:]

    def _fallback_meta_analysis(self, agent_name: str, task_id: str, content: str, recent_history: List[Dict]) -> Dict[str, Any]:
        """Fallback meta-cognitive analysis when LLM fails."""
        return {
            "self_awareness_level": "medium",
            "strategy_evaluation": f"Agent {agent_name} is evaluating their approach to {task_id}",
            "cognitive_monitoring": "Basic monitoring active",
            "learning_metacognition": "Learning from current task execution"
        }

    async def generate_cognitive_improvement_plan(self, agent_name: str) -> Dict[str, Any]:
        """
        Generate a personalized cognitive improvement plan for an agent
        based on their meta-cognitive history.
        """

        if agent_name not in self.agent_cognitive_history:
            return {"error": "No cognitive history available for agent"}

        history = self.agent_cognitive_history[agent_name]

        # Analyze patterns in cognitive performance
        self_awareness_trend = self._analyze_trend([h.get("self_awareness_level") for h in history])
        strategy_evaluation_trend = self._analyze_trend([h.get("strategy_evaluation") for h in history])

        # Generate improvement recommendations
        recommendations = []

        if self_awareness_trend == "declining":
            recommendations.append("Increase self-monitoring during decision-making processes")
        elif self_awareness_trend == "stable_low":
            recommendations.append("Practice explicit self-reflection before key decisions")

        if strategy_evaluation_trend == "declining":
            recommendations.append("Regularly evaluate alternative approaches before committing")
        elif strategy_evaluation_trend == "stable_low":
            recommendations.append("Study successful strategies from other agents")

        # Common improvement areas
        recent_weaknesses = []
        for entry in history[-10:]:  # Last 10 entries
            if entry.get("cognitive_monitoring") == "passive":
                recent_weaknesses.append("Improve active cognitive monitoring")

        if recent_weaknesses:
            recommendations.extend(list(set(recent_weaknesses))[:3])  # Top 3 unique

        return {
            "agent_name": agent_name,
            "analysis_period": f"{len(history)} cognitive assessments",
            "self_awareness_trend": self_awareness_trend,
            "strategy_evaluation_trend": strategy_evaluation_trend,
            "key_recommendations": recommendations,
            "expected_improvements": [
                "Enhanced decision-making quality",
                "Better self-awareness during problem-solving",
                "More effective strategy selection"
            ]
        }

    def _analyze_trend(self, values: List[str]) -> str:
        """Analyze trend in categorical values."""

        if not values:
            return "unknown"

        # Convert to numerical scores for trend analysis
        score_map = {"high": 3, "medium": 2, "low": 1, "unknown": 2}

        scores = [score_map.get(v, 2) for v in values]

        if len(scores) < 2:
            return "insufficient_data"

        # Simple trend analysis
        first_half = sum(scores[:len(scores)//2]) / max(1, len(scores)//2)
        second_half = sum(scores[len(scores)//2:]) / max(1, len(scores) - len(scores)//2)

        if second_half > first_half + 0.3:
            return "improving"
        elif second_half < first_half - 0.3:
            return "declining"
        elif sum(scores) / len(scores) >= 2.5:
            return "stable_high"
        elif sum(scores) / len(scores) <= 1.5:
            return "stable_low"
        else:
            return "stable_medium"

    async def detect_cognitive_dissonance(self, agent_name: str, current_analysis: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Detect cognitive dissonance - when an agent's stated beliefs/actions
        contradict their demonstrated cognitive patterns.
        """

        if agent_name not in self.agent_cognitive_history:
            return None

        history = self.agent_cognitive_history[agent_name]

        # Look for patterns of inconsistency
        recent_self_awareness = [h.get("self_awareness_level") for h in history[-5:]]
        current_self_awareness = current_analysis.get("self_awareness_level")

        # Check for sudden changes that might indicate dissonance
        if recent_self_awareness and current_self_awareness:
            recent_avg = sum([{"high": 3, "medium": 2, "low": 1}.get(sa, 2) for sa in recent_self_awareness]) / len(recent_self_awareness)
            current_score = {"high": 3, "medium": 2, "low": 1}.get(current_self_awareness, 2)

            if abs(current_score - recent_avg) >= 1.5:  # Significant deviation
                return {
                    "dissonance_type": "self_awareness_shift",
                    "severity": "moderate" if abs(current_score - recent_avg) >= 2 else "mild",
                    "description": f"Agent's self-awareness shifted from {recent_avg:.1f} to {current_score}",
                    "possible_causes": ["Task complexity change", "Learning breakthrough", "Fatigue effects"],
                    "recommendations": ["Monitor closely", "Consider cognitive rest", "Review recent decisions"]
                }

        return None

    def get_agent_cognitive_profile(self, agent_name: str) -> Dict[str, Any]:
        """Get a comprehensive cognitive profile for an agent."""

        if agent_name not in self.agent_cognitive_history:
            return {"error": "No cognitive profile available"}

        history = self.agent_cognitive_history[agent_name]

        # Aggregate cognitive metrics
        self_awareness_counts = {}
        strategy_counts = {}
        monitoring_counts = {}
        learning_counts = {}

        for entry in history:
            for metric, counts in [
                ("self_awareness_level", self_awareness_counts),
                ("strategy_evaluation", strategy_counts),
                ("cognitive_monitoring", monitoring_counts),
                ("learning_metacognition", learning_counts)
            ]:
                level = entry.get(metric, "unknown")
                counts[level] = counts.get(level, 0) + 1

        # Find most common patterns
        def get_most_common(counts):
            return max(counts.items(), key=lambda x: x[1])[0] if counts else "unknown"

        return {
            "agent_name": agent_name,
            "total_assessments": len(history),
            "cognitive_profile": {
                "dominant_self_awareness": get_most_common(self_awareness_counts),
                "typical_strategy_evaluation": get_most_common(strategy_counts),
                "cognitive_monitoring_style": get_most_common(monitoring_counts),
                "learning_metacognition_level": get_most_common(learning_counts)
            },
            "cognitive_distribution": {
                "self_awareness": self_awareness_counts,
                "strategy_evaluation": strategy_counts,
                "cognitive_monitoring": monitoring_counts,
                "learning_metacognition": learning_counts
            },
            "recent_trends": self._analyze_recent_trends(history),
            "strengths_weaknesses": self._identify_cognitive_patterns(history)
        }

    def _analyze_recent_trends(self, history: List[Dict]) -> Dict[str, str]:
        """Analyze recent cognitive trends."""

        if len(history) < 3:
            return {"error": "Insufficient data for trend analysis"}

        recent = history[-10:]  # Last 10 assessments

        trends = {}
        for metric in ["self_awareness_level", "strategy_evaluation", "cognitive_monitoring", "learning_metacognition"]:
            values = [h.get(metric) for h in recent if h.get(metric)]
            trends[metric] = self._analyze_trend(values) if values else "unknown"

        return trends

    def _identify_cognitive_patterns(self, history: List[Dict]) -> Dict[str, List[str]]:
        """Identify cognitive strengths and weaknesses patterns."""

        strengths = []
        weaknesses = []

        # Analyze patterns across all history
        self_awareness_levels = [h.get("self_awareness_level") for h in history if h.get("self_awareness_level")]
        strategy_levels = [h.get("strategy_evaluation") for h in history if h.get("strategy_evaluation")]
        monitoring_levels = [h.get("cognitive_monitoring") for h in history if h.get("cognitive_monitoring")]

        # Identify strengths
        if self_awareness_levels.count("high") > len(self_awareness_levels) * 0.6:
            strengths.append("Consistently high self-awareness")
        if strategy_levels.count("sophisticated") > len(strategy_levels) * 0.5:
            strengths.append("Advanced strategy evaluation skills")
        if monitoring_levels.count("active") > len(monitoring_levels) * 0.5:
            strengths.append("Proactive cognitive monitoring")

        # Identify weaknesses
        if self_awareness_levels.count("low") > len(self_awareness_levels) * 0.4:
            weaknesses.append("Limited self-awareness in decision-making")
        if strategy_levels.count("basic") > len(strategy_levels) * 0.4:
            weaknesses.append("Basic approach to strategy evaluation")
        if monitoring_levels.count("passive") > len(monitoring_levels) * 0.4:
            weaknesses.append("Passive cognitive monitoring style")

        return {
            "strengths": strengths,
            "weaknesses": weaknesses
        }


# Global meta-cognitive analyzer instance
_meta_cognitive_analyzer = None

def get_meta_cognitive_analyzer(model_client) -> MetaCognitiveAnalyzer:
    """Get or create the global meta-cognitive analyzer instance."""
    global _meta_cognitive_analyzer
    if _meta_cognitive_analyzer is None or _meta_cognitive_analyzer.model_client != model_client:
        _meta_cognitive_analyzer = MetaCognitiveAnalyzer(model_client)
    return _meta_cognitive_analyzer
