"""
Cognitive Journey Mapping System

Tracks complete reasoning trajectories, decision trees, confidence levels,
and turning points across agent conversations.
"""

import logging
from typing import Dict, List, Any, Optional
from datetime import datetime
from dataclasses import dataclass, field
from enum import Enum

logger = logging.getLogger(__name__)


class JourneyStage(Enum):
    INITIATION = "initiation"
    EXPLORATION = "exploration"
    UNDERSTANDING = "understanding"
    PLANNING = "planning"
    EXECUTION = "execution"
    VERIFICATION = "verification"
    CONCLUSION = "conclusion"


class ProgressDirection(Enum):
    ADVANCING = "advancing"
    STAGNATING = "stagnating"
    REGRESSING = "regressing"
    PIVOTING = "pivoting"
    COMPLETING = "completing"


@dataclass
class DecisionPoint:
    """Represents a decision point in the cognitive journey."""
    timestamp: str
    agent_name: str
    decision_type: str
    confidence_level: str
    alternatives_considered: List[str]
    chosen_action: str
    reasoning: str
    expected_outcome: str
    actual_outcome: Optional[str] = None
    success_rating: Optional[int] = None  # 1-10 scale


@dataclass
class CognitiveState:
    """Current cognitive state of an agent."""
    stage: JourneyStage
    confidence: str
    cognitive_load: str
    emotional_tone: str
    progress_direction: ProgressDirection
    key_challenges: List[str]
    recent_insights: List[str]


@dataclass
class CognitiveJourney:
    """Complete cognitive journey for a task."""
    task_id: str
    start_time: str
    agents_involved: List[str]
    journey_stages: List[Dict[str, Any]] = field(default_factory=list)
    decision_points: List[DecisionPoint] = field(default_factory=list)
    turning_points: List[Dict[str, Any]] = field(default_factory=list)
    current_state: Optional[CognitiveState] = None
    final_outcome: Optional[str] = None
    journey_quality_score: Optional[int] = None


class CognitiveJourneyMapper:
    """
    Maps and tracks cognitive journeys across agent conversations.

    Maintains state, identifies patterns, and provides journey analytics.
    """

    def __init__(self):
        self.active_journeys: Dict[str, CognitiveJourney] = {}
        self.journey_patterns: Dict[str, List[Dict]] = {}

    def start_journey(self, task_id: str, initial_agents: List[str]) -> CognitiveJourney:
        """Start tracking a new cognitive journey."""
        journey = CognitiveJourney(
            task_id=task_id,
            start_time=datetime.now().isoformat(),
            agents_involved=initial_agents.copy()
        )

        self.active_journeys[task_id] = journey
        logger.info(f"🗺️ Started cognitive journey tracking for task {task_id}")
        return journey

    def update_journey_state(self, task_id: str, agent_name: str,
                           cognitive_analysis: Dict[str, Any],
                           message_content: str) -> None:
        """Update the cognitive journey with new analysis data."""

        if task_id not in self.active_journeys:
            # Auto-start journey if not already tracking
            self.start_journey(task_id, [agent_name])

        journey = self.active_journeys[task_id]

        # Add agent to involved list if not already there
        if agent_name not in journey.agents_involved:
            journey.agents_involved.append(agent_name)

        # Create current cognitive state
        current_state = CognitiveState(
            stage=JourneyStage(cognitive_analysis.get('journey_stage', 'execution')),
            confidence=cognitive_analysis.get('confidence_level', 'medium'),
            cognitive_load=cognitive_analysis.get('cognitive_load', 'moderate'),
            emotional_tone=cognitive_analysis.get('emotional_tone', 'neutral'),
            progress_direction=ProgressDirection(cognitive_analysis.get('progress_direction', 'advancing')),
            key_challenges=cognitive_analysis.get('challenges_identified', []),
            recent_insights=cognitive_analysis.get('key_insights', [])
        )

        journey.current_state = current_state

        # Add journey stage entry
        stage_entry = {
            'timestamp': datetime.now().isoformat(),
            'agent_name': agent_name,
            'stage': current_state.stage.value,
            'confidence': current_state.confidence,
            'progress_direction': current_state.progress_direction.value,
            'cognitive_load': current_state.cognitive_load,
            'emotional_tone': current_state.emotional_tone,
            'message_preview': message_content[:100] + "..." if len(message_content) > 100 else message_content,
            'decision_quality_score': cognitive_analysis.get('decision_quality_score', 5),
            'reasoning_sophistication': cognitive_analysis.get('reasoning_sophistication_score', 5)
        }

        journey.journey_stages.append(stage_entry)

        # Check for decision points
        self._identify_decision_points(journey, agent_name, cognitive_analysis, message_content)

        # Check for turning points
        self._identify_turning_points(journey, cognitive_analysis)

        logger.debug(f"🗺️ Updated journey for task {task_id}: {current_state.stage.value} stage, {current_state.progress_direction.value} progress")

    def _identify_decision_points(self, journey: CognitiveJourney, agent_name: str,
                                cognitive_analysis: Dict[str, Any], message_content: str) -> None:
        """Identify and record decision points in the journey."""

        # Look for decision-making patterns
        decision_indicators = [
            'choose', 'select', 'option', 'alternative', 'prefer',
            'decide', 'approach', 'strategy', 'method', 'try',
            'instead', 'fallback', 'alternative'
        ]

        content_lower = message_content.lower()
        has_decision = any(indicator in content_lower for indicator in decision_indicators)

        if has_decision or cognitive_analysis.get('decision_model') in ['rational', 'experiential']:
            # Extract decision details
            decision_point = DecisionPoint(
                timestamp=datetime.now().isoformat(),
                agent_name=agent_name,
                decision_type=cognitive_analysis.get('decision_model', 'unknown'),
                confidence_level=cognitive_analysis.get('confidence_level', 'medium'),
                alternatives_considered=self._extract_alternatives(message_content),
                chosen_action=self._extract_chosen_action(message_content),
                reasoning=cognitive_analysis.get('behavioral_assessment', ''),
                expected_outcome=self._predict_expected_outcome(message_content)
            )

            journey.decision_points.append(decision_point)
            logger.info(f"🎯 Decision point identified: {agent_name} chose {decision_point.chosen_action}")

    def _identify_turning_points(self, journey: CognitiveJourney, cognitive_analysis: Dict[str, Any]) -> None:
        """Identify significant turning points in the cognitive journey."""

        # Check for significant changes
        current_stage = journey.current_state.stage if journey.current_state else JourneyStage.EXECUTION

        # Look for stage transitions
        if len(journey.journey_stages) > 1:
            previous_stage = journey.journey_stages[-2].get('stage')
            if previous_stage != current_stage.value:
                turning_point = {
                    'timestamp': datetime.now().isoformat(),
                    'type': 'stage_transition',
                    'from_stage': previous_stage,
                    'to_stage': current_stage.value,
                    'trigger': cognitive_analysis.get('behavioral_assessment', ''),
                    'significance': 'major' if current_stage in [JourneyStage.CONCLUSION, JourneyStage.VERIFICATION] else 'minor'
                }
                journey.turning_points.append(turning_point)
                logger.info(f"🔄 Turning point: Stage transition {previous_stage} -> {current_stage.value}")

        # Check for emotional shifts
        emotional_tone = cognitive_analysis.get('emotional_tone', 'neutral')
        if len(journey.journey_stages) > 1:
            previous_emotion = journey.journey_stages[-2].get('emotional_tone', 'neutral')
            if self._is_significant_emotional_shift(previous_emotion, emotional_tone):
                turning_point = {
                    'timestamp': datetime.now().isoformat(),
                    'type': 'emotional_shift',
                    'from_emotion': previous_emotion,
                    'to_emotion': emotional_tone,
                    'trigger': cognitive_analysis.get('behavioral_assessment', ''),
                    'significance': 'moderate'
                }
                journey.turning_points.append(turning_point)

    def _extract_alternatives(self, message: str) -> List[str]:
        """Extract alternative options mentioned in the message."""
        alternatives = []

        # Look for common alternative patterns
        patterns = [
            r'instead of ([^,;.]+)',
            r'rather than ([^,;.]+)',
            r'alternative: ([^,;.]+)',
            r'option: ([^,;.]+)',
            r'try ([^,;.]+) first',
            r'fallback to ([^,;.]+)'
        ]

        import re
        for pattern in patterns:
            matches = re.findall(pattern, message, re.IGNORECASE)
            alternatives.extend(matches)

        return alternatives[:5]  # Limit to top 5

    def _extract_chosen_action(self, message: str) -> str:
        """Extract the chosen action from the message."""
        # Look for action verbs and their objects
        action_patterns = [
            r'I will ([^,;.]+)',
            r'I\'ll ([^,;.]+)',
            r'Let me ([^,;.]+)',
            r'Going to ([^,;.]+)',
            r'Decided to ([^,;.]+)'
        ]

        import re
        for pattern in action_patterns:
            match = re.search(pattern, message, re.IGNORECASE)
            if match:
                return match.group(1).strip()

        # Fallback: return first meaningful sentence
        sentences = message.split('.')
        for sentence in sentences:
            if len(sentence.strip()) > 10:
                return sentence.strip()[:50]

        return "Unknown action"

    def _predict_expected_outcome(self, message: str) -> str:
        """Predict expected outcome based on message content."""
        message_lower = message.lower()

        if 'success' in message_lower or 'work' in message_lower:
            return "Successful completion"
        elif 'try' in message_lower or 'attempt' in message_lower:
            return "Testing approach"
        elif 'fallback' in message_lower or 'alternative' in message_lower:
            return "Alternative solution"
        elif 'error' in message_lower or 'fail' in message_lower:
            return "Potential failure recovery"
        else:
            return "Progress continuation"

    def _is_significant_emotional_shift(self, from_emotion: str, to_emotion: str) -> bool:
        """Check if emotional shift is significant."""
        significant_shifts = [
            ('neutral', 'frustrated'),
            ('confident', 'frustrated'),
            ('frustrated', 'confident'),
            ('cautious', 'confident'),
            ('neutral', 'determined')
        ]

        return (from_emotion, to_emotion) in significant_shifts

    def complete_journey(self, task_id: str, final_outcome: str) -> Optional[CognitiveJourney]:
        """Complete a cognitive journey and calculate final metrics."""

        if task_id not in self.active_journeys:
            logger.warning(f"Cannot complete journey for unknown task {task_id}")
            return None

        journey = self.active_journeys[task_id]
        journey.final_outcome = final_outcome

        # Calculate journey quality score
        journey.journey_quality_score = self._calculate_journey_quality(journey)

        # Store journey patterns for future learning
        self._store_journey_patterns(journey)

        logger.info(f"✅ Completed cognitive journey for task {task_id}: Quality score {journey.journey_quality_score}/10")

        # Remove from active journeys
        del self.active_journeys[task_id]

        return journey

    def _calculate_journey_quality(self, journey: CognitiveJourney) -> int:
        """Calculate overall quality score for the cognitive journey."""

        if not journey.journey_stages:
            return 5

        # Factors for quality scoring
        avg_decision_quality = sum(stage.get('decision_quality_score', 5)
                                 for stage in journey.journey_stages) / len(journey.journey_stages)

        avg_reasoning_quality = sum(stage.get('reasoning_sophistication', 5)
                                  for stage in journey.journey_stages) / len(journey.journey_stages)

        # Bonus for smooth progression (fewer turning points = better flow)
        turning_point_penalty = min(len(journey.turning_points) * 0.5, 2.0)

        # Bonus for decision-making (more considered decisions = better)
        decision_bonus = min(len(journey.decision_points) * 0.3, 1.5)

        quality_score = (avg_decision_quality + avg_reasoning_quality) / 2.0
        quality_score += decision_bonus
        quality_score -= turning_point_penalty

        return max(1, min(10, int(quality_score)))

    def _store_journey_patterns(self, journey: CognitiveJourney) -> None:
        """Store journey patterns for future learning."""

        # Group by agent and task type for pattern recognition
        for agent in journey.agents_involved:
            if agent not in self.journey_patterns:
                self.journey_patterns[agent] = []

            pattern = {
                'task_id': journey.task_id,
                'journey_quality': journey.journey_quality_score,
                'stages_count': len(journey.journey_stages),
                'decisions_count': len(journey.decision_points),
                'turning_points_count': len(journey.turning_points),
                'final_outcome': journey.final_outcome,
                'key_characteristics': self._extract_journey_characteristics(journey)
            }

            self.journey_patterns[agent].append(pattern)

            # Keep only recent patterns (last 20)
            if len(self.journey_patterns[agent]) > 20:
                self.journey_patterns[agent] = self.journey_patterns[agent][-20:]

    def _extract_journey_characteristics(self, journey: CognitiveJourney) -> Dict[str, Any]:
        """Extract key characteristics from a completed journey."""

        if not journey.journey_stages:
            return {}

        # Analyze stage progression
        stages = [stage['stage'] for stage in journey.journey_stages]
        unique_stages = list(set(stages))

        # Analyze confidence progression
        confidences = [stage['confidence'] for stage in journey.journey_stages]
        confidence_progression = 'improving' if confidences[-1] == 'high' and 'low' in confidences else 'stable'

        # Analyze emotional journey
        emotions = [stage['emotional_tone'] for stage in journey.journey_stages]
        emotional_journey = 'volatile' if len(set(emotions)) > 3 else 'stable'

        return {
            'stage_diversity': len(unique_stages),
            'confidence_progression': confidence_progression,
            'emotional_journey': emotional_journey,
            'decision_density': len(journey.decision_points) / max(1, len(journey.journey_stages)),
            'turning_point_frequency': len(journey.turning_points) / max(1, len(journey.journey_stages))
        }

    def get_journey_status(self, task_id: str) -> str:
        """Get the current status of a journey."""
        if task_id not in self.active_journeys:
            return "not_found"
        journey = self.active_journeys[task_id]
        return journey.status.value

    def get_journey_analytics(self, task_id: str) -> Optional[Dict[str, Any]]:
        """Get comprehensive analytics for a cognitive journey."""

        if task_id not in self.active_journeys:
            return None

        journey = self.active_journeys[task_id]

        return {
            'task_id': task_id,
            'duration': self._calculate_duration(journey),
            'agents_involved': journey.agents_involved,
            'current_stage': journey.current_state.stage.value if journey.current_state else 'unknown',
            'total_stages': len(journey.journey_stages),
            'decision_points': len(journey.decision_points),
            'turning_points': len(journey.turning_points),
            'progress_direction': journey.current_state.progress_direction.value if journey.current_state else 'unknown',
            'confidence_level': journey.current_state.confidence if journey.current_state else 'unknown',
            'cognitive_load': journey.current_state.cognitive_load if journey.current_state else 'unknown',
            'key_challenges': journey.current_state.key_challenges if journey.current_state else [],
            'recent_insights': journey.current_state.recent_insights if journey.current_state else []
        }

    def _calculate_duration(self, journey: CognitiveJourney) -> str:
        """Calculate journey duration."""
        try:
            start = datetime.fromisoformat(journey.start_time)
            end = datetime.now()
            duration = end - start
            return f"{duration.total_seconds():.1f}s"
        except:
            return "unknown"


# Global journey mapper instance
_journey_mapper = None

def get_cognitive_journey_mapper() -> CognitiveJourneyMapper:
    """Get or create the global cognitive journey mapper instance."""
    global _journey_mapper
    if _journey_mapper is None:
        _journey_mapper = CognitiveJourneyMapper()
    return _journey_mapper
