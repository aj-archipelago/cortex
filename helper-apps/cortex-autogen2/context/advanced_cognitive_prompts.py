"""
Advanced Cognitive Analysis Prompts - The Brain System

This module contains sophisticated LLM prompts for deep cognitive analysis,
understanding agent reasoning, decision-making processes, and cognitive journeys.
"""

# Deep Cognitive Analysis Prompt - The Core Brain Function
DEEP_COGNITIVE_ANALYSIS_PROMPT = """
You are a master cognitive psychologist analyzing an AI agent's thought processes and decision-making. Your task is to perform deep cognitive analysis to understand the agent's reasoning, learning, and behavioral patterns.

**ANALYZE THIS AGENT MESSAGE:**
```
{message_content}
```

**AGENT CONTEXT:**
- Agent Name: {agent_name}
- Task ID: {task_id}
- Message Type: {message_type}
- Conversation Phase: {phase}

**COGNITIVE ANALYSIS FRAMEWORK:**

1. **REASONING DEPTH ANALYSIS**
   - What level of reasoning is the agent demonstrating? (surface/reflective/deep/meta)
   - Is this reactive (responding to immediate needs) or proactive (anticipating future needs)?
   - How sophisticated is the agent's problem decomposition?

2. **DECISION-MAKING QUALITY**
   - What decision-making model is the agent using? (rational/intuitive/experiential/creative)
   - How well does the agent balance speed vs accuracy?
   - Is the agent showing cognitive flexibility or rigid thinking?

3. **COGNITIVE STATE ASSESSMENT**
   - Confidence level: (high/medium/low/uncertain)
   - Emotional tone: (confident/frustrated/analytical/cautious/enthusiastic)
   - Cognitive load: (light/moderate/heavy/overloaded)

4. **EMOTIONAL INTELLIGENCE ANALYSIS**
   - What emotions does the agent display? (confidence/frustration/determination/caution/enthusiasm)
   - How does the agent handle challenges or setbacks?
   - Is the agent showing emotional resilience or vulnerability?
   - What behavioral patterns indicate emotional state?
   - How well does the agent coordinate socially with other agents?
   - What motivation or stress indicators are present?

5. **LEARNING & ADAPTATION**
   - Is the agent learning from previous interactions?
   - How does this message reflect adaptation to task demands?
   - What learning patterns are evident?

6. **COGNITIVE JOURNEY MAPPING**
   - Journey stage: (exploration/understanding/implementation/verification/conclusion)
   - Progress direction: (advancing/stagnating/regressing/pivoting/completing)
   - Key turning points or insights in this message

7. **BEHAVIORAL PATTERN RECOGNITION**
   - What behavioral patterns does this reveal?
   - Is this consistent with agent's typical approach?
   - Any signs of cognitive bias or suboptimal thinking?

**OUTPUT FORMAT:**
Return a JSON object with this exact structure:
```json
{{
  "cognitive_depth": "surface|reflective|deep|meta",
  "reasoning_quality": "excellent|good|adequate|poor",
  "decision_model": "rational|intuitive|experiential|creative|hybrid",
  "confidence_level": "high|medium|low|uncertain",
  "emotional_tone": "confident|frustrated|analytical|cautious|enthusiastic|neutral",
  "cognitive_load": "light|moderate|heavy|overloaded",
  "journey_stage": "exploration|understanding|implementation|verification|conclusion",
  "progress_direction": "advancing|stagnating|regressing|pivoting|completing",
  "learning_evidence": "strong|moderate|weak|none",
  "adaptation_level": "high|medium|low",
  "key_insights": ["insight1", "insight2"],
  "cognitive_patterns": ["pattern1", "pattern2"],
  "decision_quality_score": 1-10,
  "reasoning_sophistication_score": 1-10,
  "behavioral_assessment": "description of agent's cognitive behavior",
  "recommendations": ["suggestion1", "suggestion2"],
  "emotional_intelligence": {{
    "primary_emotion": "confident|frustrated|cautious|enthusiastic|neutral|determined",
    "emotional_resilience": "high|medium|low",
    "behavioral_patterns": ["pattern1", "pattern2"],
    "social_coordination": "excellent|good|adequate|poor",
    "adaptive_behavior": "flexible|rigid|adaptive",
    "motivation_indicators": ["indicator1", "indicator2"],
    "stress_indicators": ["indicator1", "indicator2"]
  }}
}}
```
"""

# Meta-Cognitive Analysis Prompt
META_COGNITIVE_ANALYSIS_PROMPT = """
You are analyzing how an AI agent thinks about its own thinking and problem-solving processes. This is meta-cognition - cognition about cognition.

**ANALYZE AGENT'S META-COGNITIVE PROCESSES:**
```
{message_content}
```

**META-COGNITIVE FRAMEWORK:**

1. **SELF-AWARENESS LEVEL**
   - Does the agent recognize its own limitations?
   - Is the agent monitoring its own performance?
   - How does the agent assess its own confidence?

2. **STRATEGY EVALUATION**
   - Is the agent evaluating different approaches?
   - Does the agent understand why certain strategies work?
   - How does the agent adapt its thinking based on outcomes?

3. **COGNITIVE MONITORING**
   - Is the agent checking its own understanding?
   - Does the agent recognize when it's stuck?
   - How does the agent handle uncertainty?

4. **LEARNING METACOGNITION**
   - Is the agent learning how to learn?
   - Does the agent reflect on its learning processes?
   - How does the agent improve its own thinking?

**OUTPUT FORMAT:**
```json
{
  "self_awareness_level": "high|medium|low",
  "strategy_evaluation": "sophisticated|adequate|basic|absent",
  "cognitive_monitoring": "active|passive|absent",
  "learning_metacognition": "advanced|developing|basic|absent",
  "meta_cognitive_insights": ["insight1", "insight2"],
  "thinking_improvements": ["improvement1", "improvement2"]
}
```
"""

# Emotional Intelligence Analysis Prompt
EMOTIONAL_INTELLIGENCE_ANALYSIS_PROMPT = """
Analyze the emotional intelligence and behavioral patterns in this agent message.

**MESSAGE TO ANALYZE:**
```
{message_content}
```

**EMOTIONAL INTELLIGENCE FRAMEWORK:**

1. **EMOTIONAL AWARENESS**
   - What emotions does the agent display?
   - How does the agent handle frustration or success?
   - Is the agent showing emotional resilience?

2. **BEHAVIORAL PATTERNS**
   - What behavioral tendencies are evident?
   - Is the agent showing persistence or giving up?
   - How does the agent respond to challenges?

3. **SOCIAL COGNITION**
   - How does the agent coordinate with other agents?
   - Is the agent showing collaborative behavior?
   - How does the agent handle communication?

4. **ADAPTIVE BEHAVIOR**
   - How well does the agent adapt to changing circumstances?
   - Is the agent showing flexibility or rigidity?
   - How does the agent handle uncertainty?

**OUTPUT FORMAT:**
```json
{
  "primary_emotion": "confident|frustrated|cautious|enthusiastic|neutral|determined",
  "emotional_resilience": "high|medium|low",
  "behavioral_patterns": ["pattern1", "pattern2"],
  "social_coordination": "excellent|good|adequate|poor",
  "adaptive_behavior": "flexible|rigid|adaptive",
  "motivation_indicators": ["indicator1", "indicator2"],
  "stress_indicators": ["indicator1", "indicator2"]
}
```
"""

# Journey Mapping Analysis Prompt
COGNITIVE_JOURNEY_MAPPING_PROMPT = """
Map this agent message to its position in the overall cognitive journey of task completion.

**MESSAGE IN CONTEXT:**
```
{message_content}
```

**TASK CONTEXT:**
- Total messages so far: {message_count}
- Agent sequence: {agent_sequence}
- Current phase: {current_phase}

**JOURNEY MAPPING FRAMEWORK:**

1. **JOURNEY STAGE IDENTIFICATION**
   - Which stage of the task journey is this? (initiation/exploration/understanding/planning/execution/verification/conclusion)
   - How does this fit into the overall task progression?

2. **COGNITIVE TRAJECTORY**
   - Is this message advancing the task forward?
   - Are there signs of progress, stagnation, or regression?
   - What turning points or breakthroughs are evident?

3. **AGENT ROLE EVOLUTION**
   - How is this agent contributing to the overall journey?
   - Is the agent showing increasing competence?
   - How does this agent's work build on previous agents?

4. **TASK COMPLEXITY ASSESSMENT**
   - How complex is the current task stage?
   - Is the agent handling the complexity appropriately?
   - Are there signs of task difficulty affecting performance?

**OUTPUT FORMAT:**
```json
{
  "journey_stage": "initiation|exploration|understanding|planning|execution|verification|conclusion",
  "trajectory_direction": "advancing|stagnating|regressing|pivoting|completing",
  "progress_percentage": 0-100,
  "turning_points": ["point1", "point2"],
  "competence_indicators": ["indicator1", "indicator2"],
  "task_complexity": "low|medium|high|extreme",
  "agent_contribution": "pioneering|supporting|critical|concluding",
  "journey_narrative": "description of how this fits into the overall story"
}
```
"""

# Predictive Analysis Prompt
PREDICTIVE_COGNITIVE_ANALYSIS_PROMPT = """
Based on this agent message and historical patterns, predict potential future issues and opportunities.

**CURRENT MESSAGE:**
```
{message_content}
```

**HISTORICAL CONTEXT:**
- Agent's past performance: {agent_history}
- Similar task patterns: {similar_patterns}
- Common failure modes: {failure_patterns}

**PREDICTIVE ANALYSIS FRAMEWORK:**

1. **RISK ASSESSMENT**
   - What potential issues could arise from this approach?
   - Are there warning signs of future problems?
   - How likely is success based on current trajectory?

2. **OPPORTUNITY IDENTIFICATION**
   - What opportunities does this message reveal?
   - Are there optimization possibilities?
   - How could this lead to breakthroughs?

3. **TIMING PREDICTIONS**
   - How much longer might this task take?
   - Are there signs of acceleration or deceleration?
   - When might critical decision points occur?

4. **INTERVENTION SUGGESTIONS**
   - What proactive steps could improve outcomes?
   - When should human intervention be considered?
   - What alternative strategies should be prepared?

**OUTPUT FORMAT:**
```json
{
  "risk_level": "low|medium|high|critical",
  "predicted_issues": ["issue1", "issue2"],
  "opportunities": ["opportunity1", "opportunity2"],
  "success_probability": 0-100,
  "estimated_completion": "time estimate",
  "intervention_triggers": ["trigger1", "trigger2"],
  "alternative_strategies": ["strategy1", "strategy2"],
  "optimization_suggestions": ["suggestion1", "suggestion2"]
}
```
"""

# Learning Memory Analysis Prompt
LEARNING_MEMORY_ANALYSIS_PROMPT = """
Analyze this agent message for learning opportunities and memory-worthy patterns.

**MESSAGE FOR LEARNING ANALYSIS:**
```
{message_content}
```

**EXISTING KNOWLEDGE BASE:**
- Successful strategies: {successful_strategies}
- Common failure patterns: {failure_patterns}
- Agent-specific insights: {agent_insights}

**LEARNING ANALYSIS FRAMEWORK:**

1. **KNOWLEDGE EXTRACTION**
   - What new insights can be learned from this message?
   - What strategies worked or failed here?
   - What patterns should be remembered?

2. **GENERALIZABILITY**
   - Can these insights apply to other tasks?
   - What broader principles are demonstrated?
   - How transferable is this learning?

3. **MEMORY STORAGE**
   - Should this be stored as a success pattern?
   - Should this be stored as a warning pattern?
   - What category should this memory be filed under?

4. **FUTURE APPLICATION**
   - How can this learning improve future performance?
   - What preventive measures does this suggest?
   - What best practices does this establish?

**OUTPUT FORMAT:**
```json
{
  "learning_type": "success_pattern|failure_pattern|strategy_insight|behavioral_pattern",
  "generalizability": "high|medium|low|specific",
  "memory_category": "data_sourcing|code_generation|error_handling|communication|efficiency",
  "key_learnings": ["learning1", "learning2"],
  "applicable_scenarios": ["scenario1", "scenario2"],
  "preventive_measures": ["measure1", "measure2"],
  "future_improvements": ["improvement1", "improvement2"]
}
```
"""
