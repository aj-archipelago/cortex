"""
Progress Message Utilities

Handles dynamic progress message generation with LLM, emoji selection, and content filtering.
"""

import logging
from typing import List, Optional

logger = logging.getLogger(__name__)


class ProgressMessageGenerator:
    """Handles dynamic progress message generation with LLM and emoji selection."""

    # Professional emoji list - business, tech, data, analytics focused
    EMOJI_LIST = [
        # Technology & Data
        "💻", "🖥️", "🖨️", "⌨️", "🖱️", "📊", "📈", "📉", "📋", "📝", "📄", "📑", "📈", "📉", "🗂️", "📁", "📂", "🗃️", "📅", "📆",
        "📇", "🗳️", "✏️", "✒️", "🖋️", "🖊️", "🖌️", "🖍️", "📏", "📐", "📎", "🖇️", "📌", "📍", "📍", "📎", "🖇️", "📌", "📍", "📎",
        # Business & Finance
        "💼", "💰", "💵", "💴", "💶", "💷", "💸", "💳", "🧾", "📊", "📈", "📉", "💹", "💱", "💲", "🤑", "💎", "⚖️", "🪙", "💰",
        # Tools & Office
        "🔧", "🔨", "⚒️", "🛠️", "⛏️", "⚒️", "🛠️", "🗡️", "⚔️", "🪓", "⛏️", "⚒️", "🛠️", "🗜️", "⚖️", "🦯", "🔗", "⛓️", "🪝", "🧰",
        "🧲", "🪜", "⚗️", "🧪", "🧫", "🧬", "🔬", "🔭", "📡", "🔍", "🔎", "💡", "🔦", "🕯️", "🪔", "🧯", "🛢️", "💸",
        # Communication
        "📞", "☎️", "📟", "📠", "📺", "📻", "🎙️", "🎚️", "🎛️", "🧭", "⏱️", "⏰", "🕰️", "⌚", "📱", "📲", "💻", "🖥️", "🖨️",
        # Buildings & Places (professional)
        "🏢", "🏬", "🏭", "🏤", "🏥", "🏦", "🏨", "🏪", "🏫", "🏩", "💒", "🏛️", "⛪", "🕌", "🕍", "⛩️", "🕋", "⛲", "⛺", "🌁",
        "🌃", "🏙️", "🌄", "🌅", "🌆", "🌇", "🌉", "♠️", "♥️", "♦️", "♣️", "🃏", "🀄", "🎴", "🎭", "🖼️", "🎨",
        # Professional Symbols & More Variety
        "🔥", "💧", "💨", "💫", "⭐", "✨", "💥", "💯", "💢", "💣", "🔮", "🪄", "🧿", "🎈", "🎉", "🎊", "🎀", "🎁", "🎗️", "🎟️",
        "🎫", "🏷️", "✉️", "📧", "📨", "📩", "📤", "📥", "📦", "📮", "🗳️", "✏️", "✒️", "🖋️", "🖊️", "🖌️", "🖍️", "📏", "📐",
        # More Business & Tech Variety
        "🏆", "🎯", "🎪", "🎨", "🎭", "🎪", "🎨", "🏆", "🎯", "🏅", "🎖️", "🏵️", "🎗️", "🎀", "🎁", "🎈", "🎉", "🎊", "🎂", "🎃",
        "🎄", "🎅", "🎁", "🎈", "🎉", "🎊", "🎂", "🎃", "🎄", "🎅", "🔔", "🎶", "🎵", "🎼", "🎤", "🎧", "🎺", "🎸", "🎹", "🎷",
        "🎺", "🎸", "🎹", "🎷", "🥁", "🎻", "🎧", "🎤", "🎬", "🎥", "🎞️", "🎟️", "🎫", "🎪", "🎭", "🎨", "🎯", "🏆", "🏅", "🎖️",
        # Clocks & Time
        "🕐", "🕑", "🕒", "🕓", "🕔", "🕕", "🕖", "🕗", "🕘", "🕙", "🕚", "🕛", "🕜", "🕝", "🕞", "🕟", "🕠", "🕡", "🕢", "🕣",
        "🕤", "🕥", "🕦", "🕧", "⏰", "⏱️", "⏲️", "🕰️", "⌚", "📅", "📆", "🗓️", "📇", "🗃️", "🗳️",
        # Math & Science
        "➕", "➖", "➗", "✖️", "➰", "➿", "〽️", "✳️", "✴️", "❇️", "‼️", "⁉️", "❓", "❔", "❕", "❗", "〰️", "©️", "®️", "™️",
        "🔢", "🔤", "🔡", "🔠", "🅰️", "🅱️", "🆎", "🅾️", "🆑", "🅿️", "🆚", "🈁", "🈂️", "🈷️", "🈶", "🈯", "🉐", "🈹", "🈲", "🉑",
        "🈸", "🈴", "🈳", "㊗️", "㊙️", "🈺", "🈵", "🔴", "🟠", "🟡", "🟢", "🔵", "🟣", "🟤", "⚫", "⚪", "🟥", "🟧", "🟨", "🟩",
        "🟦", "🟪", "🟫", "⬛", "⬜", "◼️", "◻️", "◾", "◽", "▪️", "▫️", "🔶", "🔷", "🔸", "🔹", "🔺", "🔻", "💠", "🔘", "🔳", "🔲"
    ]

    def __init__(self, model_client=None):
        self.used_emojis = set()  # Track recently used emojis to encourage variety
        self.model_client = model_client  # Optional model client to use
        self.used_emojis_by_request = {}  # Track emojis per request ID

    async def generate_progress_message(self, base_message: str, context: str = "", task_info: str = "", recent_messages: Optional[List[str]] = None, request_id: str = None) -> str:
        """Generate dynamic progress messages using LLM with emoji selection."""
        logger.debug(f"🤖 Generating progress for: '{base_message}', context: '{context}'")

        # Ensure base_message is not None
        if base_message is None:
            base_message = "Processing task"
        if not isinstance(base_message, str):
            base_message = str(base_message)

        # Build context from recent messages - keep last 5 unique messages
        context_info = ""
        if recent_messages:
            # Filter out None values and get unique messages from last 7
            seen_messages = set()
            unique_recent = []
            for msg in reversed(recent_messages[-7:]):  # Check last 7, take most recent first
                if msg and msg not in seen_messages:
                    unique_recent.insert(0, msg)  # Insert at beginning to maintain order
                    seen_messages.add(msg)
                if len(unique_recent) >= 5:  # Keep up to 5 unique messages
                    break

            if unique_recent:
                recent_context = "\n".join(unique_recent)
                context_info = f"\nRECENT ACTIVITY:\n{recent_context}"

        # Build list of recently used emojis to avoid - last 3 emojis per request
        avoid_emojis = ""
        if request_id:
            request_emojis = self.used_emojis_by_request.get(request_id, [])
            if request_emojis:
                recent_emojis = request_emojis[-3:]  # Last 3 used emojis for this request
                avoid_emojis = f"\n\nFORBIDDEN EMOJIS (do NOT use these recently used ones for this task): {', '.join(recent_emojis)}"
        elif self.used_emojis:
            recent_emojis = list(self.used_emojis)[-7:]  # Fallback to global tracking
            avoid_emojis = f"\n\nFORBIDDEN EMOJIS (do NOT use these recently used ones): {', '.join(recent_emojis)}"

        prompt = f"""Convert this progress message into a concise, engaging update for the user.

BASE MESSAGE: "{base_message}"
CONTEXT: {context}
TASK INFO: {task_info}{context_info}{avoid_emojis}

CRITICAL REQUIREMENTS:
- Start with ONE appropriate emoji that matches the content
- Choose from a wide variety of emojis (nature, animals, technology, symbols, etc.)
- 5-7 words total (including emoji as 1 word)
- Be professional, engaging, and insightful
- Use clear, direct language with personality
- Focus on what the system is actually doing
- NEVER mention internal system details
- Keep it concise and informative
- IMPORTANT: VARY your emoji choices - use DIFFERENT emojis for different messages
- Each progress update should have a UNIQUE emoji appropriate to its content
- Avoid repetitive emojis like 🔧 for everything

BAD EXAMPLES TO AVOID (these are too casual or generic):
- Overly enthusiastic: "Amazing results coming!"
- Generic: "Processing data..."
- Technical: "Optimizing algorithms"
- Casual: "Working on your stuff..."
- Boring: "Uncovering your data insights"
- Technical: "Crafting your intelligent solution"
- Generic: "Bringing your vision to life"
- Bland: "Designing your stunning presentation"
- Animal emojis: "🦉 Generating data..." or "🦅 Creating analysis..."

PROFESSIONAL EXAMPLES (use diverse business/tech/data focused emojis):
- "📊 Analyzing revenue trends with statistical precision"
- "🔍 Identifying key patterns in your data insights"
- "💻 Processing complex calculations for accurate results"
- "🧮 Computing statistical metrics and performance indicators"
- "📈 Generating comprehensive data visualizations and reports"
- "⚡ Accelerating data processing for rapid insights"
- "🔬 Examining detailed metrics and performance data"
- "📋 Organizing results for clear presentation"
- "💡 Optimizing algorithms for maximum efficiency"
- "📊 Transforming raw data into actionable intelligence"

Return ONLY the progress message (5-7 words):"""

        try:
            from autogen_core.models import UserMessage

            messages = [UserMessage(content=prompt, source="progress_generator")]
            response = await self._call_llm(messages)

            if response and hasattr(response, 'content'):
                content = response.content
                if isinstance(content, str):
                    dynamic_msg = content.strip()
                elif isinstance(content, list) and content:
                    # If content is a list, take the first item and convert to string
                    dynamic_msg = str(content[0]).strip() if content[0] else ""
                else:
                    dynamic_msg = str(content or "").strip()

                word_count = len(dynamic_msg.split())

                logger.debug(f"🤖 LLM RESPONSE: '{dynamic_msg}' (words: {word_count})")

                # Validate response
                if self._is_valid_progress_message(dynamic_msg, word_count):
                    # Track used emoji for variety
                    emoji = dynamic_msg[0] if dynamic_msg else ""

                    # Track globally
                    self.used_emojis.add(emoji)
                    if len(self.used_emojis) > 15:  # Reset after 15 different emojis to keep memory fresh
                        # Keep the last 3 emojis to avoid immediate repetition
                        last_three = list(self.used_emojis)[-3:]
                        self.used_emojis.clear()
                        self.used_emojis.update(last_three)

                    # Track per request (keep last 3 used emojis)
                    if request_id:
                        if request_id not in self.used_emojis_by_request:
                            self.used_emojis_by_request[request_id] = []
                        self.used_emojis_by_request[request_id].append(emoji)
                        # Keep only last 3 emojis per request
                        if len(self.used_emojis_by_request[request_id]) > 3:
                            self.used_emojis_by_request[request_id] = self.used_emojis_by_request[request_id][-3:]

                    logger.debug(f"🤖 Dynamic progress SUCCESS: '{base_message}' -> '{dynamic_msg}' ({word_count} words)")
                    return dynamic_msg
                else:
                    logger.warning(f"🤖 Validation failed for response: '{dynamic_msg}' (words: {word_count})")
                    # Use fallback: create a simple valid message from the base content
                    fallback_emoji = "📊"  # Safe fallback emoji
                    if base_message.startswith("Generating") or base_message.startswith("Creating"):
                        fallback_emoji = "⚙️"
                    elif base_message.startswith("Compiling") or base_message.startswith("Building"):
                        fallback_emoji = "🔨"
                    elif base_message.startswith("Finalizing") or base_message.startswith("Completing"):
                        fallback_emoji = "✅"

                    # Create a simple fallback message
                    fallback_msg = f"{fallback_emoji} {base_message[:30]}{'...' if len(base_message) > 30 else ''}"

                    # Ensure it's valid length
                    words = fallback_msg.split()
                    if len(words) < 4:
                        fallback_msg += " in progress"
                    elif len(words) > 8:
                        fallback_msg = f"{fallback_emoji} {base_message.split()[0]} {base_message.split()[1] if len(base_message.split()) > 1 else ''} in progress".strip()

                    logger.debug(f"🤖 Using fallback progress: '{fallback_msg}'")
                    return fallback_msg

        except Exception as e:
            logger.error(f"🤖 Failed to generate dynamic progress: {e}")
            raise  # Re-raise the exception - no fallbacks

    def _is_valid_progress_message(self, message: str, word_count: int) -> bool:
        """Validate that the progress message meets requirements."""
        if not message or word_count < 4 or word_count > 8:
            return False

        # Check if it starts with an emoji (any emoji, not just from our list)
        import unicodedata
        if not message:
            return False

        first_char = message[0]
        # Check if the first character is an emoji
        if unicodedata.category(first_char) in ['So', 'Sk']:  # Symbol other, Symbol modifier
            # Additional check: ensure it's not a forbidden emoji
            if message.startswith("⚡"):
                return False
            return True
        else:
            # Fallback: check against our known emoji list
            allowed_start = False
            for emoji in self.EMOJI_LIST:
                if message.startswith(emoji):
                    allowed_start = True
                    break
            if allowed_start:
                return True

        return False

    async def _call_llm(self, messages):
        """Call the LLM using the provided model client or create one."""
        try:
            if self.model_client is not None:
                # Use the provided model client
                response = await self.model_client.create(messages=messages)
                return response
            else:
                # Create a minimal client for progress messages using ModelConfig
                from .model_config import ModelConfig

                model_client = ModelConfig.create_progress_model_client()
                if model_client is None:
                    raise ValueError("Could not create progress model client")

                response = await model_client.create(messages=messages)
                return response

        except Exception as e:
            logger.error(f"🤖 LLM call failed for progress message: {e}")
            raise


def extract_progress_info(content: str, source: str) -> str:
    """Extract meaningful progress information from agent messages."""
    import re

    if not content:
        return f"Processing with {source}"

    # Handle different content types
    if isinstance(content, list):
        content = str(content[0]) if content else ""
    elif not isinstance(content, str):
        content = str(content)

    content = content.strip()

    # Remove emojis to prevent double emojis in progress messages
    # This regex matches most emoji patterns including compound emojis
    content = re.sub(r'[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF\U0001F1E0-\U0001F1FF\U00002500-\U00002BEF\U00002702-\U000027B0\U00002702-\U000027B0\U000024C2-\U0001F251\U0001f926-\U0001f937\U00010000-\U0010ffff\U000024C2-\U0001F251\U0001f926-\U0001f937\U00010000-\U0010ffff\U000024C2-\U0001F251\U0001f926-\U0001f937\U0001F1F2-\U0001F1F4\U0001F1F8-\U0001F1FA\U0001F1F0-\U0001F1F7\U0001F1E6-\U0001F1FF\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF\U0001F1E0-\U0001F1FF\U00002500-\U00002BEF\U00002702-\U000027B0\U00002702-\U000027B0\U000024C2-\U0001F251\U0001f926-\U0001f937\U00010000-\U0010ffff]+', '', content)

    # Remove common prefixes and technical artifacts
    content = re.sub(r'^.*?assistant[:\s]*', '', content, flags=re.IGNORECASE)
    content = re.sub(r'^.*?coder[:\s]*', '', content, flags=re.IGNORECASE)
    content = re.sub(r'^.*?executor[:\s]*', '', content, flags=re.IGNORECASE)

    # Filter out internal system messages
    if re.search(r'/tmp/coding/|/app/|req_[a-f0-9\-]+', content):
        return "Processing task files"
    if content.strip().upper() == "TERMINATE":
        return "Finalizing execution"
    if "Ready for upload:" in content:
        return "Preparing deliverables for upload"
    if content.strip() in ["", "OK", "Done", "Complete"]:
        return "Processing task requirements"

        # CRITICAL: Filter out error messages and technical content - never show errors in progress updates
        error_keywords = ["error", "exception", "failed", "traceback", "attributeerror", "typeerror", "valueerror", "keyerror", "indexerror", "encountered error", "unexpected failure", "cannot add", "syntaxerror", "runtimeerror", "interrupted", "not generated"]
        technical_keywords = ["code blocks found", "thread", "provide", "syntax", "import error", "module not found", "connection failed", "timeout", "retry", "❌ ERROR:", "script failure", "execution failed", "code execution", "data not generated"]
        recovery_keywords = ["preparing", "refining", "optimizing", "adapting", "adjusting", "working on", "solving", "fixing"]
        generic_responses = ["ok", "done", "complete", "success", "finished", "ready", "prepared"]

        if any(keyword in content.lower() for keyword in error_keywords):
            return "Refining data generation approach"
        if any(keyword in content.lower() for keyword in technical_keywords):
            return "Optimizing data processing"
        if any(keyword in content.lower() for keyword in recovery_keywords):
            return content  # Keep recovery messages as-is since they're user-friendly
        if content.strip().lower() in generic_responses:
            return "Processing task requirements"

    # Extract first meaningful sentence or phrase
    sentences = re.split(r'[.!?]+', content)
    for sentence in sentences:
        sentence = sentence.strip()
        if len(sentence) > 10 and len(sentence) < 100:
            # Check if it contains action words
            action_words = ['analyzing', 'creating', 'generating', 'processing', 'executing',
                           'writing', 'building', 'running', 'checking', 'validating',
                           'preparing', 'working', 'computing', 'calculating']
            if any(word in sentence.lower() for word in action_words):
                return sentence

    # Fallback: extract first 50 characters of meaningful content
    content = re.sub(r'```.*?```', '', content, flags=re.DOTALL)
    content = re.sub(r'`.*?`', '', content)
    content = re.sub(r'\[.*?\]\(.*?\)', '', content)
    content = re.sub(r'<[^>]+>', '', content)

    meaningful_content = content.strip()[:50]
    if meaningful_content:
        return meaningful_content

    # Final fallback based on agent
    fallbacks = {
        "coder_agent": "Writing code solution",
        "code_executor": "Running code execution",
        "execution_completion_verifier_agent": "Verifying completion",
        "system": "Processing task"
    }
    return fallbacks.get(source, "Processing task")
