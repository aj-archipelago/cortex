"""
Predictive Cognitive Analysis

Anticipates potential issues before they occur based on historical patterns,
cognitive indicators, and learning from past experiences.
"""

import logging
from typing import Dict, List, Any, Optional, Tuple
from datetime import datetime, timedelta
from collections import defaultdict

logger = logging.getLogger(__name__)


class PredictiveAnalyzer:
    """
    Analyzes current cognitive patterns to predict potential future issues
    and provide proactive recommendations.
    """

    def __init__(self, learning_memory):
        self.learning_memory = learning_memory
        self.risk_patterns: Dict[str, List[Dict]] = defaultdict(list)
        self.predictive_models: Dict[str, Dict] = {}

    async def analyze_predictive_risks(self, agent_name: str, task_id: str,
                                     current_cognitive_state: Dict[str, Any],
                                     task_context: Dict[str, Any]) -> Dict[str, Any]:
        """
        Analyze current state to predict potential future issues.

        Uses cognitive patterns, historical data, and contextual factors
        to anticipate problems before they occur.
        """

        predictions = {
            "risk_level": "low",
            "predicted_issues": [],
            "preventive_actions": [],
            "confidence_intervals": {},
            "timeline_predictions": {},
            "alternative_strategies": []
        }

        try:
            # Extract task type
            task_type = self._extract_task_type(task_id)

            # Analyze cognitive state for risk indicators
            cognitive_risks = self._analyze_cognitive_state_risks(current_cognitive_state)

            # Analyze historical patterns for this task type
            historical_risks = self._analyze_historical_risks(task_type, agent_name)

            # Analyze agent-specific patterns
            agent_risks = self._analyze_agent_patterns(agent_name, task_type)

            # Combine and prioritize risks
            all_risks = cognitive_risks + historical_risks + agent_risks
            prioritized_risks = self._prioritize_risks(all_risks)

            # Generate predictions
            predictions["risk_level"] = self._calculate_overall_risk_level(prioritized_risks)
            predictions["predicted_issues"] = [risk["issue"] for risk in prioritized_risks[:5]]
            predictions["preventive_actions"] = self._generate_preventive_actions(prioritized_risks[:5])
            predictions["confidence_intervals"] = self._calculate_confidence_intervals(prioritized_risks)
            predictions["timeline_predictions"] = self._predict_timelines(prioritized_risks)
            predictions["alternative_strategies"] = self._suggest_alternative_strategies(task_type, agent_name, prioritized_risks)

            logger.info(f"🔮 Predictive analysis for {agent_name}: {predictions['risk_level']} risk level, {len(predictions['predicted_issues'])} predicted issues")

        except Exception as e:
            logger.error(f"Predictive analysis failed: {str(e)}")
            predictions["error"] = str(e)

        return predictions

    def _analyze_cognitive_state_risks(self, cognitive_state: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Analyze current cognitive state for risk indicators."""

        risks = []

        # Cognitive load risks
        cognitive_load = cognitive_state.get("cognitive_load", "moderate")
        if cognitive_load == "heavy":
            risks.append({
                "type": "cognitive_load",
                "severity": "high",
                "issue": "Agent experiencing heavy cognitive load - risk of decision fatigue",
                "likelihood": 0.8,
                "timeframe": "immediate",
                "indicators": ["heavy cognitive load", "complex reasoning required"]
            })
        elif cognitive_load == "overloaded":
            risks.append({
                "type": "cognitive_overload",
                "severity": "critical",
                "issue": "Agent at risk of cognitive overload - potential breakdown imminent",
                "likelihood": 0.9,
                "timeframe": "immediate",
                "indicators": ["overloaded cognitive state", "decision paralysis possible"]
            })

        # Emotional state risks
        emotional_tone = cognitive_state.get("emotional_tone", "neutral")
        if emotional_tone == "frustrated":
            risks.append({
                "type": "emotional_frustration",
                "severity": "medium",
                "issue": "Frustrated emotional state may lead to suboptimal decisions",
                "likelihood": 0.6,
                "timeframe": "short_term",
                "indicators": ["frustrated emotional tone", "error patterns emerging"]
            })

        # Confidence level risks
        confidence_level = cognitive_state.get("confidence_level", "medium")
        if confidence_level == "low":
            risks.append({
                "type": "low_confidence",
                "severity": "medium",
                "issue": "Low confidence may lead to hesitation or over-cautious decisions",
                "likelihood": 0.7,
                "timeframe": "ongoing",
                "indicators": ["low confidence level", "decision delays possible"]
            })

        # Reasoning quality risks
        reasoning_quality = cognitive_state.get("reasoning_quality", "adequate")
        if reasoning_quality in ["poor", "inadequate"]:
            risks.append({
                "type": "reasoning_quality",
                "severity": "high",
                "issue": "Poor reasoning quality increases risk of incorrect solutions",
                "likelihood": 0.8,
                "timeframe": "immediate",
                "indicators": ["poor reasoning quality", "logic errors likely"]
            })

        return risks

    def _analyze_historical_risks(self, task_type: str, agent_name: str) -> List[Dict[str, Any]]:
        """Analyze historical patterns for risk prediction."""

        risks = []

        # Get failure warnings from learning memory
        failure_warnings = self.learning_memory.get_failure_warnings(task_type, agent_name, "current_strategy")

        for warning in failure_warnings:
            if warning.get("recency", 999) < 30:  # Recent failures (last 30 days)
                risks.append({
                    "type": "historical_failure",
                    "severity": "medium" if warning["recency"] < 7 else "low",
                    "issue": f"Similar strategy failed recently: {warning['failure_reason']}",
                    "likelihood": 0.7 if warning["recency"] < 7 else 0.4,
                    "timeframe": "short_term",
                    "indicators": [warning["failed_strategy"], "historical pattern match"],
                    "historical_context": warning
                })

        # Check for task type patterns
        task_insights = self.learning_memory.get_task_insights(task_type, {})
        for insight in task_insights:
            if "failure" in insight.get("insight_type", "").lower():
                risks.append({
                    "type": "task_pattern_risk",
                    "severity": "medium",
                    "issue": f"Task pattern indicates risk: {insight['content'][:100]}",
                    "likelihood": 0.5,
                    "timeframe": "medium_term",
                    "indicators": ["task type pattern", insight["insight_type"]]
                })

        return risks

    def _analyze_agent_patterns(self, agent_name: str, task_type: str) -> List[Dict[str, Any]]:
        """Analyze agent-specific patterns for risk prediction."""

        risks = []

        # Get agent profile
        agent_profile = self.learning_memory.get_agent_profile(agent_name)

        if "error" not in agent_profile:
            # Check success rate
            success_rate = agent_profile.get("success_rate", 0.5)
            if success_rate < 0.3:
                risks.append({
                    "type": "agent_performance",
                    "severity": "high",
                    "issue": f"Agent has low success rate ({success_rate:.1%}) - high risk of failure",
                    "likelihood": 0.8,
                    "timeframe": "ongoing",
                    "indicators": ["low success rate", "performance concerns"]
                })

            # Check for weaknesses relevant to task type
            weaknesses = agent_profile.get("weaknesses", [])
            task_relevant_weaknesses = [
                w for w in weaknesses
                if any(keyword in task_type.lower() for keyword in w.lower().split())
            ]

            for weakness in task_relevant_weaknesses:
                risks.append({
                    "type": "agent_weakness",
                    "severity": "medium",
                    "issue": f"Agent weakness relevant to task: {weakness}",
                    "likelihood": 0.6,
                    "timeframe": "ongoing",
                    "indicators": ["agent weakness match", weakness]
                })

        return risks

    def _prioritize_risks(self, risks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Prioritize risks by severity and likelihood."""

        # Scoring function for risk prioritization
        def risk_score(risk):
            severity_scores = {"critical": 5, "high": 4, "medium": 3, "low": 2, "minimal": 1}
            severity = severity_scores.get(risk.get("severity", "medium"), 3)
            likelihood = risk.get("likelihood", 0.5)
            return severity * likelihood

        # Sort by risk score
        prioritized = sorted(risks, key=risk_score, reverse=True)
        return prioritized

    def _calculate_overall_risk_level(self, prioritized_risks: List[Dict[str, Any]]) -> str:
        """Calculate overall risk level from prioritized risks."""

        if not prioritized_risks:
            return "low"

        # Calculate weighted risk score
        total_weighted_score = 0
        total_weight = 0

        severity_weights = {"critical": 5, "high": 4, "medium": 3, "low": 2, "minimal": 1}

        for risk in prioritized_risks[:5]:  # Top 5 risks
            severity_weight = severity_weights.get(risk.get("severity", "medium"), 3)
            likelihood = risk.get("likelihood", 0.5)
            weight = severity_weight * likelihood

            total_weighted_score += weight
            total_weight += severity_weight

        if total_weight == 0:
            return "low"

        avg_risk_score = total_weighted_score / total_weight

        if avg_risk_score >= 4.0:
            return "critical"
        elif avg_risk_score >= 3.0:
            return "high"
        elif avg_risk_score >= 2.0:
            return "medium"
        else:
            return "low"

    def _generate_preventive_actions(self, top_risks: List[Dict[str, Any]]) -> List[str]:
        """Generate preventive actions for top risks."""

        actions = []

        for risk in top_risks:
            risk_type = risk.get("type", "")

            if risk_type == "cognitive_load":
                actions.extend([
                    "Break task into smaller subtasks",
                    "Take strategic pauses for cognitive reset",
                    "Use decision-making frameworks to reduce load"
                ])
            elif risk_type == "cognitive_overload":
                actions.extend([
                    "Immediately simplify current approach",
                    "Request human intervention for complex decisions",
                    "Switch to basic, reliable strategies"
                ])
            elif risk_type == "emotional_frustration":
                actions.extend([
                    "Acknowledge frustration and take a step back",
                    "Try alternative approaches to reduce frustration",
                    "Focus on small wins to rebuild confidence"
                ])
            elif risk_type == "historical_failure":
                actions.extend([
                    f"Avoid strategy: {risk.get('historical_context', {}).get('failed_strategy', 'similar approaches')}",
                    "Use recovery strategy from past failure",
                    "Start with simpler approach than previously attempted"
                ])
            elif risk_type == "agent_performance":
                actions.extend([
                    "Switch to higher-performing agent for this task",
                    "Use proven strategies from successful past tasks",
                    "Implement additional validation and checkpoints"
                ])
            else:
                actions.append(f"Address {risk_type} risk through careful monitoring and alternative approaches")

        # Remove duplicates and limit to top 5
        unique_actions = list(dict.fromkeys(actions))
        return unique_actions[:5]

    def _calculate_confidence_intervals(self, risks: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Calculate confidence intervals for risk predictions."""

        if not risks:
            return {"low": 0, "medium": 0, "high": 0}

        # Group risks by likelihood ranges
        low_confidence = sum(1 for r in risks if r.get("likelihood", 0) < 0.4)
        medium_confidence = sum(1 for r in risks if 0.4 <= r.get("likelihood", 0) < 0.7)
        high_confidence = sum(1 for r in risks if r.get("likelihood", 0) >= 0.7)

        return {
            "low": low_confidence,
            "medium": medium_confidence,
            "high": high_confidence,
            "total_risks": len(risks)
        }

    def _predict_timelines(self, risks: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Predict when risks might materialize."""

        timeline_counts = {
            "immediate": 0,    # Within minutes
            "short_term": 0,   # Within hours
            "medium_term": 0,  # Within days
            "long_term": 0     # Weeks or more
        }

        for risk in risks:
            timeframe = risk.get("timeframe", "medium_term")
            timeline_counts[timeframe] += 1

        # Find most likely timeline
        most_likely = max(timeline_counts.items(), key=lambda x: x[1])

        return {
            "most_likely_timeframe": most_likely[0],
            "timeline_distribution": timeline_counts,
            "immediate_risks": timeline_counts["immediate"],
            "urgent_attention_needed": timeline_counts["immediate"] > 0
        }

    def _suggest_alternative_strategies(self, task_type: str, agent_name: str,
                                      risks: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Suggest alternative strategies based on identified risks."""

        # Get recommended strategies from learning memory
        recommended = self.learning_memory.get_recommended_strategies(task_type, agent_name, {})

        # Filter and adapt based on risks
        filtered_recommendations = []

        for rec in recommended:
            # Check if this strategy avoids identified risks
            risk_avoidance_score = self._calculate_risk_avoidance(rec["strategy"], risks)

            if risk_avoidance_score > 0.5:  # Good risk avoidance
                filtered_recommendations.append({
                    "strategy": rec["strategy"],
                    "confidence": rec["confidence"],
                    "rationale": f"{rec['rationale']} - Also helps avoid identified risks",
                    "risk_avoidance_score": risk_avoidance_score
                })

        # If we don't have enough recommendations, add generic alternatives
        if len(filtered_recommendations) < 3:
            generic_alternatives = [
                {
                    "strategy": "incremental_approach",
                    "confidence": 0.7,
                    "rationale": "Break complex tasks into smaller, manageable steps",
                    "risk_avoidance_score": 0.8
                },
                {
                    "strategy": "consult_learning_memory",
                    "confidence": 0.6,
                    "rationale": "Reference successful past approaches for similar tasks",
                    "risk_avoidance_score": 0.7
                },
                {
                    "strategy": "simplified_methodology",
                    "confidence": 0.8,
                    "rationale": "Use proven simple methods instead of complex approaches",
                    "risk_avoidance_score": 0.9
                }
            ]

            # Add generic alternatives not already in recommendations
            existing_strategies = {r["strategy"] for r in filtered_recommendations}
            for alt in generic_alternatives:
                if alt["strategy"] not in existing_strategies:
                    filtered_recommendations.append(alt)
                    if len(filtered_recommendations) >= 5:
                        break

        return filtered_recommendations[:5]

    def _calculate_risk_avoidance(self, strategy: str, risks: List[Dict[str, Any]]) -> float:
        """Calculate how well a strategy avoids identified risks."""

        avoidance_score = 0.5  # Base score
        applicable_risks = 0

        strategy_lower = strategy.lower()

        for risk in risks:
            risk_type = risk.get("type", "")
            applicable_risks += 1

            # Check if strategy counters the risk
            if risk_type == "cognitive_load" and any(word in strategy_lower for word in ["incremental", "step", "simple"]):
                avoidance_score += 0.2
            elif risk_type == "cognitive_overload" and any(word in strategy_lower for word in ["basic", "simple", "proven"]):
                avoidance_score += 0.3
            elif risk_type == "historical_failure" and "alternative" in strategy_lower:
                avoidance_score += 0.25
            elif risk_type == "agent_performance" and any(word in strategy_lower for word in ["proven", "successful", "memory"]):
                avoidance_score += 0.2

        return min(1.0, avoidance_score) if applicable_risks > 0 else 0.5

    def _extract_task_type(self, task_id: str) -> str:
        """Extract task type from task ID."""

        # Use same logic as cognitive analyzer
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

    async def get_predictive_health_check(self, agent_name: str, task_context: Dict[str, Any]) -> Dict[str, Any]:
        """Perform a comprehensive predictive health check for an agent."""

        health_check = {
            "agent_name": agent_name,
            "overall_health": "good",
            "risk_factors": [],
            "strength_indicators": [],
            "recommendations": [],
            "predictive_insights": {}
        }

        try:
            # Get agent profile from learning memory
            agent_profile = self.learning_memory.get_agent_profile(agent_name)

            if "error" not in agent_profile:
                success_rate = agent_profile.get("success_rate", 0.5)

                if success_rate > 0.8:
                    health_check["overall_health"] = "excellent"
                    health_check["strength_indicators"].append("High success rate")
                elif success_rate > 0.6:
                    health_check["overall_health"] = "good"
                    health_check["strength_indicators"].append("Solid performance")
                elif success_rate > 0.4:
                    health_check["overall_health"] = "fair"
                    health_check["risk_factors"].append("Moderate success rate needs improvement")
                else:
                    health_check["overall_health"] = "poor"
                    health_check["risk_factors"].append("Low success rate requires attention")

                # Add strengths and weaknesses
                health_check["strength_indicators"].extend(agent_profile.get("strengths", []))
                health_check["risk_factors"].extend(agent_profile.get("weaknesses", []))

                # Generate recommendations
                if success_rate < 0.6:
                    health_check["recommendations"].append("Focus on building success patterns")
                if len(agent_profile.get("weaknesses", [])) > 2:
                    health_check["recommendations"].append("Address multiple weakness areas")

            # Add task-specific predictions
            task_type = task_context.get("task_type", self._extract_task_type("general"))
            strategy_recommendations = self.learning_memory.get_recommended_strategies(task_type, agent_name, task_context)

            health_check["predictive_insights"] = {
                "recommended_strategies": strategy_recommendations[:3],
                "task_type": task_type,
                "strategy_count": len(strategy_recommendations)
            }

        except Exception as e:
            logger.error(f"Health check failed for {agent_name}: {str(e)}")
            health_check["error"] = str(e)

        return health_check


# Global predictive analyzer instance
_predictive_analyzer = None

def get_predictive_analyzer(learning_memory) -> PredictiveAnalyzer:
    """Get or create the global predictive analyzer instance."""
    global _predictive_analyzer
    if _predictive_analyzer is None:
        _predictive_analyzer = PredictiveAnalyzer(learning_memory)
    return _predictive_analyzer




