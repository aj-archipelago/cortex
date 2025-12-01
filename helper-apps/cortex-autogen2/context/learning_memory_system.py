"""
Learning Memory System

Stores successful strategies, failure patterns, and insights for continuous learning
and improvement of agent behavior across tasks.
"""

import logging
from typing import Dict, List, Any, Optional, Tuple
from datetime import datetime, timedelta
from collections import defaultdict
import json

logger = logging.getLogger(__name__)


class LearningMemory:
    """
    A comprehensive learning memory system that stores and retrieves
    successful strategies, failure patterns, and cognitive insights.
    """

    def __init__(self):
        self.success_patterns: Dict[str, List[Dict]] = defaultdict(list)
        self.failure_patterns: Dict[str, List[Dict]] = defaultdict(list)
        self.task_insights: Dict[str, List[Dict]] = defaultdict(list)
        self.agent_profiles: Dict[str, Dict] = {}
        self.strategy_effectiveness: Dict[str, Dict] = defaultdict(dict)

    def record_success_pattern(self, task_type: str, agent_name: str,
                             strategy: str, context: Dict[str, Any],
                             outcome_metrics: Dict[str, Any]) -> None:
        """Record a successful strategy pattern for future reference."""

        pattern = {
            "timestamp": datetime.now().isoformat(),
            "task_type": task_type,
            "agent_name": agent_name,
            "strategy": strategy,
            "context": context,
            "outcome_metrics": outcome_metrics,
            "success_score": self._calculate_success_score(outcome_metrics),
            "lessons_learned": self._extract_lessons_from_success(context, outcome_metrics)
        }

        self.success_patterns[task_type].append(pattern)

        # Update strategy effectiveness
        strategy_key = f"{agent_name}:{strategy}"
        if strategy_key not in self.strategy_effectiveness:
            self.strategy_effectiveness[strategy_key] = {
                "success_count": 0,
                "failure_count": 0,
                "avg_success_score": 0,
                "last_used": None,
                "task_types": set()
            }

        stats = self.strategy_effectiveness[strategy_key]
        stats["success_count"] += 1
        stats["task_types"].add(task_type)
        stats["last_used"] = pattern["timestamp"]

        # Recalculate average success score
        total_score = stats["avg_success_score"] * (stats["success_count"] - 1) + pattern["success_score"]
        stats["avg_success_score"] = total_score / stats["success_count"]

        logger.info(f"✅ Recorded success pattern: {strategy} for {task_type} (score: {pattern['success_score']:.1f})")

        # Keep only recent patterns (last 50 per task type)
        if len(self.success_patterns[task_type]) > 50:
            self.success_patterns[task_type] = self.success_patterns[task_type][-50:]

    def record_failure_pattern(self, task_type: str, agent_name: str,
                             failed_strategy: str, context: Dict[str, Any],
                             failure_reason: str, recovery_strategy: Optional[str] = None) -> None:
        """Record a failure pattern with lessons learned."""

        pattern = {
            "timestamp": datetime.now().isoformat(),
            "task_type": task_type,
            "agent_name": agent_name,
            "failed_strategy": failed_strategy,
            "context": context,
            "failure_reason": failure_reason,
            "recovery_strategy": recovery_strategy,
            "lessons_learned": self._extract_lessons_from_failure(failed_strategy, failure_reason, context),
            "preventive_measures": self._suggest_preventive_measures(failed_strategy, failure_reason)
        }

        self.failure_patterns[task_type].append(pattern)

        # Update strategy effectiveness
        strategy_key = f"{agent_name}:{failed_strategy}"
        if strategy_key not in self.strategy_effectiveness:
            self.strategy_effectiveness[strategy_key] = {
                "success_count": 0,
                "failure_count": 0,
                "avg_success_score": 0,
                "last_used": None,
                "task_types": set()
            }

        stats = self.strategy_effectiveness[strategy_key]
        stats["failure_count"] += 1
        stats["task_types"].add(task_type)
        stats["last_used"] = pattern["timestamp"]

        logger.info(f"❌ Recorded failure pattern: {failed_strategy} for {task_type} ({failure_reason})")

        # Keep only recent patterns (last 30 per task type to focus on recent issues)
        if len(self.failure_patterns[task_type]) > 30:
            self.failure_patterns[task_type] = self.failure_patterns[task_type][-30:]

    def record_task_insight(self, task_type: str, insight_type: str,
                          insight_content: str, context: Dict[str, Any],
                          applicability_score: int = 5) -> None:
        """Record a general insight about task handling."""

        insight = {
            "timestamp": datetime.now().isoformat(),
            "task_type": task_type,
            "insight_type": insight_type,
            "content": insight_content,
            "context": context,
            "applicability_score": applicability_score,
            "usage_count": 0,
            "last_applied": None
        }

        self.task_insights[task_type].append(insight)

        # Keep only recent insights (last 40 per task type)
        if len(self.task_insights[task_type]) > 40:
            self.task_insights[task_type] = self.task_insights[task_type][-40:]

    def get_recommended_strategies(self, task_type: str, agent_name: str,
                                 context: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Get recommended strategies for a task type based on learning history."""

        recommendations = []

        # Get successful strategies for this task type
        if task_type in self.success_patterns:
            success_patterns = self.success_patterns[task_type]

            # Filter by agent or similar agents
            relevant_patterns = [
                p for p in success_patterns
                if p["agent_name"] == agent_name or self._are_agents_similar(p["agent_name"], agent_name)
            ]

            # Sort by success score and recency
            relevant_patterns.sort(key=lambda x: (x["success_score"], x["timestamp"]), reverse=True)

            for pattern in relevant_patterns[:5]:  # Top 5
                recommendations.append({
                    "type": "proven_strategy",
                    "strategy": pattern["strategy"],
                    "confidence": pattern["success_score"] / 10.0,
                    "rationale": f"Successfully used by {pattern['agent_name']} with score {pattern['success_score']:.1f}",
                    "context_match": self._calculate_context_similarity(pattern["context"], context)
                })

        # Check for strategies that work well for this agent across task types
        agent_strategies = [
            (strategy_key, stats) for strategy_key, stats in self.strategy_effectiveness.items()
            if strategy_key.startswith(f"{agent_name}:") and stats["success_count"] > 0
        ]

        agent_strategies.sort(key=lambda x: x[1]["avg_success_score"], reverse=True)

        for strategy_key, stats in agent_strategies[:3]:  # Top 3 agent strategies
            strategy_name = strategy_key.split(":", 1)[1]
            recommendations.append({
                "type": "agent_strength",
                "strategy": strategy_name,
                "confidence": stats["avg_success_score"] / 10.0,
                "rationale": f"Your successful strategy (avg score: {stats['avg_success_score']:.1f})",
                "context_match": 0.8  # High match for agent's own strategies
            })

        return recommendations

    def get_failure_warnings(self, task_type: str, agent_name: str,
                           proposed_strategy: str) -> List[Dict[str, Any]]:
        """Get warnings about strategies that have failed in similar contexts."""

        warnings = []

        if task_type in self.failure_patterns:
            failure_patterns = self.failure_patterns[task_type]

            # Look for similar failed strategies
            similar_failures = [
                p for p in failure_patterns
                if self._are_strategies_similar(p["failed_strategy"], proposed_strategy)
            ]

            for failure in similar_failures[-3:]:  # Most recent 3
                warnings.append({
                    "warning_type": "similar_failure",
                    "failed_strategy": failure["failed_strategy"],
                    "failure_reason": failure["failure_reason"],
                    "recovery_strategy": failure["recovery_strategy"],
                    "preventive_measures": failure["preventive_measures"],
                    "recency": self._calculate_recency_days(failure["timestamp"])
                })

        return warnings

    def get_success_patterns(self, task_type: str) -> List[Dict[str, Any]]:
        """Get all success patterns for a task type."""
        return self.success_patterns.get(task_type, [])

    def get_failure_patterns(self, task_type: str) -> List[Dict[str, Any]]:
        """Get all failure patterns for a task type."""
        return self.failure_patterns.get(task_type, [])

    def get_task_insights(self, task_type: str, context: Dict[str, Any] = None) -> List[Dict[str, Any]]:
        """Get relevant insights for a task type."""

        insights = []

        if task_type in self.task_insights:
            task_insights = self.task_insights[task_type]

            # Sort by applicability and recency
            sorted_insights = sorted(
                task_insights,
                key=lambda x: (x["applicability_score"], x["timestamp"]),
                reverse=True
            )

            for insight in sorted_insights[:5]:  # Top 5
                insights.append({
                    "insight_type": insight["insight_type"],
                    "content": insight["content"],
                    "applicability": insight["applicability_score"] / 10.0,
                    "context_relevance": self._calculate_context_similarity(insight["context"], context)
                })

        return insights

    def update_agent_profile(self, agent_name: str, cognitive_profile: Dict[str, Any]) -> None:
        """Update an agent's cognitive profile based on learning history."""

        profile = self.agent_profiles.get(agent_name, {
            "total_tasks": 0,
            "success_rate": 0,
            "strengths": [],
            "weaknesses": [],
            "preferred_strategies": [],
            "cognitive_traits": {}
        })

        # Update profile based on learning history
        agent_strategies = {
            k: v for k, v in self.strategy_effectiveness.items()
            if k.startswith(f"{agent_name}:")
        }

        if agent_strategies:
            # Calculate success rate
            total_attempts = sum(stats["success_count"] + stats["failure_count"] for stats in agent_strategies.values())
            total_successes = sum(stats["success_count"] for stats in agent_strategies.values())

            profile["total_tasks"] = total_attempts
            profile["success_rate"] = total_successes / max(1, total_attempts)

            # Identify strengths (high success strategies)
            strong_strategies = [
                strategy_key.split(":", 1)[1]
                for strategy_key, stats in agent_strategies.items()
                if stats["avg_success_score"] > 7.0
            ]
            profile["strengths"] = strong_strategies

            # Identify preferred strategies (most used successful ones)
            preferred = sorted(
                agent_strategies.items(),
                key=lambda x: (x[1]["success_count"], x[1]["avg_success_score"]),
                reverse=True
            )[:3]
            profile["preferred_strategies"] = [s[0].split(":", 1)[1] for s, _ in preferred]

        # Update cognitive traits
        profile["cognitive_traits"] = cognitive_profile

        self.agent_profiles[agent_name] = profile

        logger.info(f"📊 Updated agent profile for {agent_name}: {profile['success_rate']:.1%} success rate")

    def get_agent_profile(self, agent_name: str) -> Dict[str, Any]:
        """Get an agent's learning profile."""
        return self.agent_profiles.get(agent_name, {
            "error": "No profile available for this agent"
        })

    def _calculate_success_score(self, outcome_metrics: Dict[str, Any]) -> float:
        """Calculate a success score from outcome metrics."""

        score = 5.0  # Base score

        # Time efficiency (faster is better, but not too fast)
        if "duration_seconds" in outcome_metrics:
            duration = outcome_metrics["duration_seconds"]
            if duration < 30:
                score += 1.0  # Very fast
            elif duration < 120:
                score += 2.0  # Good speed
            elif duration > 600:
                score -= 1.0  # Too slow

        # Quality metrics
        if "quality_score" in outcome_metrics:
            quality = outcome_metrics["quality_score"]
            score += (quality - 5.0) * 0.5  # Quality contribution

        # Completion status
        if outcome_metrics.get("completed", False):
            score += 2.0
        else:
            score -= 3.0

        # Error count (fewer errors = better)
        if "error_count" in outcome_metrics:
            errors = outcome_metrics["error_count"]
            score -= min(errors, 3)  # Penalty for errors

        return max(1.0, min(10.0, score))

    def _extract_lessons_from_success(self, context: Dict[str, Any],
                                    outcome_metrics: Dict[str, Any]) -> List[str]:
        """Extract lessons learned from successful outcomes."""

        lessons = []

        if outcome_metrics.get("completed", False):
            lessons.append("Task completion achieved")

        if outcome_metrics.get("duration_seconds", 0) < 180:
            lessons.append("Efficient execution strategy")

        if outcome_metrics.get("error_count", 0) == 0:
            lessons.append("Error-free execution")

        if context.get("strategy_adapted", False):
            lessons.append("Strategy adaptation successful")

        return lessons

    def _extract_lessons_from_failure(self, failed_strategy: str,
                                    failure_reason: str, context: Dict[str, Any]) -> List[str]:
        """Extract lessons learned from failures."""

        lessons = []

        if "timeout" in failure_reason.lower():
            lessons.append("Consider timeout-resistant strategies")
        elif "error" in failure_reason.lower():
            lessons.append("Improve error handling and validation")
        elif "data" in failure_reason.lower():
            lessons.append("Verify data sources and formats first")

        if context.get("first_attempt", False):
            lessons.append("Start with simpler approaches for complex tasks")

        return lessons

    def _suggest_preventive_measures(self, failed_strategy: str, failure_reason: str) -> List[str]:
        """Suggest preventive measures for similar failures."""

        measures = []

        if "timeout" in failure_reason.lower():
            measures.extend([
                "Set appropriate timeouts",
                "Use incremental approaches",
                "Monitor progress continuously"
            ])
        elif "data" in failure_reason.lower():
            measures.extend([
                "Validate data sources first",
                "Check data formats and schemas",
                "Use data quality checks"
            ])
        elif "api" in failure_reason.lower():
            measures.extend([
                "Check API availability",
                "Have fallback data sources",
                "Use rate limiting"
            ])

        return measures

    def _are_agents_similar(self, agent1: str, agent2: str) -> bool:
        """Check if two agents are similar (same type/family)."""

        # Simple similarity based on naming patterns
        agent1_type = agent1.replace("_agent", "").replace("agent", "")
        agent2_type = agent2.replace("_agent", "").replace("agent", "")

        # Same base type
        if agent1_type == agent2_type:
            return True

        # Similar roles (web search vs cognitive search, etc.)
        similar_pairs = [
            ("web_search", "cognitive_search"),
            ("coder", "data_processor"),
            ("planner", "strategy_planner")
        ]

        for pair in similar_pairs:
            if (agent1_type in pair and agent2_type in pair):
                return True

        return False

    def _are_strategies_similar(self, strategy1: str, strategy2: str) -> bool:
        """Check if two strategies are similar."""

        # Simple text similarity
        strategy1_lower = strategy1.lower()
        strategy2_lower = strategy2.lower()

        # Exact match
        if strategy1_lower == strategy2_lower:
            return True

        # Keyword overlap
        words1 = set(strategy1_lower.split())
        words2 = set(strategy2_lower.split())

        overlap = len(words1.intersection(words2))
        total_words = len(words1.union(words2))

        return overlap / total_words > 0.5 if total_words > 0 else False

    def _calculate_context_similarity(self, context1: Dict[str, Any],
                                    context2: Dict[str, Any]) -> float:
        """Calculate similarity between two contexts."""

        similarity = 0.0
        total_factors = 0

        # Compare task complexity
        if "complexity" in context1 and "complexity" in context2:
            if context1["complexity"] == context2["complexity"]:
                similarity += 1.0
            total_factors += 1

        # Compare data types
        if "data_types" in context1 and "data_types" in context2:
            types1 = set(context1["data_types"])
            types2 = set(context2["data_types"])
            if types1 and types2:
                overlap = len(types1.intersection(types2))
                union = len(types1.union(types2))
                similarity += overlap / union if union > 0 else 0
                total_factors += 1

        # Compare agent experience level
        if "agent_experience" in context1 and "agent_experience" in context2:
            if context1["agent_experience"] == context2["agent_experience"]:
                similarity += 1.0
            total_factors += 1

        return similarity / max(1, total_factors)

    def _calculate_recency_days(self, timestamp_str: str) -> int:
        """Calculate how many days ago an event occurred."""

        try:
            event_time = datetime.fromisoformat(timestamp_str)
            now = datetime.now()
            delta = now - event_time
            return delta.days
        except:
            return 999  # Very old if can't parse

    def get_learning_summary(self) -> Dict[str, Any]:
        """Get a comprehensive summary of the learning system."""

        total_success_patterns = sum(len(patterns) for patterns in self.success_patterns.values())
        total_failure_patterns = sum(len(patterns) for patterns in self.failure_patterns.values())
        total_insights = sum(len(insights) for insights in self.task_insights.values())

        return {
            "total_success_patterns": total_success_patterns,
            "total_failure_patterns": total_failure_patterns,
            "total_insights": total_insights,
            "task_types_covered": list(set(
                list(self.success_patterns.keys()) +
                list(self.failure_patterns.keys()) +
                list(self.task_insights.keys())
            )),
            "agents_profiled": len(self.agent_profiles),
            "strategies_tracked": len(self.strategy_effectiveness),
            "most_successful_strategies": self._get_top_strategies(),
            "most_common_failures": self._get_common_failures()
        }

    def _get_top_strategies(self) -> List[Dict[str, Any]]:
        """Get the most successful strategies across all learning."""

        strategy_scores = []
        for strategy_key, stats in self.strategy_effectiveness.items():
            if stats["success_count"] > 0:
                success_rate = stats["success_count"] / (stats["success_count"] + stats["failure_count"])
                strategy_scores.append({
                    "strategy": strategy_key,
                    "success_rate": success_rate,
                    "avg_score": stats["avg_success_score"],
                    "usage_count": stats["success_count"] + stats["failure_count"],
                    "task_types": list(stats["task_types"])
                })

        # Sort by success rate and average score
        strategy_scores.sort(key=lambda x: (x["success_rate"], x["avg_score"]), reverse=True)

        return strategy_scores[:10]  # Top 10

    def _get_common_failures(self) -> List[Dict[str, Any]]:
        """Get the most common failure patterns."""

        failure_counts = defaultdict(int)

        for task_patterns in self.failure_patterns.values():
            for pattern in task_patterns:
                failure_counts[pattern["failure_reason"]] += 1

        # Convert to sorted list
        common_failures = [
            {"reason": reason, "count": count}
            for reason, count in failure_counts.items()
        ]
        common_failures.sort(key=lambda x: x["count"], reverse=True)

        return common_failures[:10]  # Top 10


# Global learning memory instance
_learning_memory = None

def get_learning_memory() -> LearningMemory:
    """Get or create the global learning memory instance."""
    global _learning_memory
    if _learning_memory is None:
        _learning_memory = LearningMemory()
    return _learning_memory
