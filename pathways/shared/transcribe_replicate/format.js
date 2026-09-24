function timed(item) {
  return Number.isFinite(item?.start) && Number.isFinite(item?.end) && item.start >= 0 && item.end >= item.start;
}

export function normalizeReplicateOutput(output, offset = 0) {
  const raw = output?.segments;
  const segments = Array.isArray(raw) ? raw : raw?.segments;
  if (!Array.isArray(segments)) throw new Error("Replicate transcription returned invalid segments");
  return {
    text: String(output.transcription ?? segments.map(s => s.text || "").join(" ")).trim(),
    language: output.detected_language,
    segments: segments.map(segment => {
      if (!timed(segment)) throw new Error("Replicate transcription returned invalid segment timestamps");
      return {
        text: String(segment.text || "").trim(), start: segment.start + offset, end: segment.end + offset,
        words: (segment.words || []).map(w => ({
          text: String(w.word ?? w.text ?? "").trim(),
          // Some tokens (e.g. numbers) have no alignment. Preserve them instead
          // of dropping them or presenting invented word timing as measured.
          ...(timed(w) ? { start: w.start + offset, end: w.end + offset } : {}),
        })),
      };
    }),
  };
}

function timestamp(seconds, format) {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}${format === "srt" ? "," : "."}${String(ms % 1000).padStart(3, "0")}`;
}

function wrap(words, { maxLineWidth = 0, maxWordsPerLine = 0 }) {
  const lines = [];
  let line = [];
  for (const word of words) {
    if (line.length && ((maxWordsPerLine > 0 && line.length >= maxWordsPerLine) ||
        (maxLineWidth > 0 && [...line, word].map(w => w.text).join(" ").length > maxLineWidth))) {
      lines.push(line); line = [];
    }
    line.push(word);
  }
  if (line.length) lines.push(line);
  return lines;
}

function segmentCues(segment, args) {
  const { wordTimestamped, highlightWords, maxLineCount = 0, maxLineWidth = 0, maxWordsPerLine = 0 } = args;
  const needsWords = wordTimestamped || highlightWords || maxLineCount > 0 || maxWordsPerLine > 0;
  const words = segment.words.filter(w => w.text);
  if (needsWords && (!words.length || words.some(w => !timed(w)))) {
    throw new Error("Word alignment is incomplete for this audio; request segment subtitles instead");
  }
  if (!needsWords) {
    return [{ ...segment, text: wrap(segment.text.split(/\s+/).map(text => ({ text })), args).map(l => l.map(w => w.text).join(" ")).join("\n") }];
  }
  if (wordTimestamped && !highlightWords && !maxLineWidth && !maxWordsPerLine && !maxLineCount) return words;
  const lines = wrap(words, args);
  const cues = [];
  const count = maxLineCount > 0 ? maxLineCount : lines.length;
  for (let i = 0; i < lines.length; i += count) {
    const group = lines.slice(i, i + count);
    const groupWords = group.flat();
    const text = group.map(l => l.map(w => w.text).join(" ")).join("\n");
    if (!highlightWords) {
      cues.push({ start: groupWords[0].start, end: groupWords.at(-1).end, text });
      continue;
    }
    let previousEnd = groupWords[0].start;
    for (const word of groupWords) {
      if (word.start > previousEnd) cues.push({ start: previousEnd, end: word.start, text });
      cues.push({ start: word.start, end: word.end,
        text: group.map(l => l.map(w => w === word ? `<u>${w.text}</u>` : w.text).join(" ")).join("\n") });
      previousEnd = word.end;
    }
  }
  return cues;
}

export function validateReplicateFormat(args = {}) {
  if (!["text", "srt", "vtt"].includes(String(args.responseFormat || "text").toLowerCase())) {
    throw new Error("Replicate transcription responseFormat must be text, srt, or vtt");
  }
  for (const key of ["maxLineWidth", "maxLineCount", "maxWordsPerLine"]) {
    if (args[key] != null && (!Number.isInteger(args[key]) || args[key] < 0)) {
      throw new Error(`${key} must be a nonnegative integer`);
    }
  }
}

export function formatReplicateTranscript(chunks, args = {}) {
  validateReplicateFormat(args);
  const format = String(args.responseFormat || "text").toLowerCase();
  if (format === "text" && !args.wordTimestamped && !args.highlightWords) {
    return chunks.map(c => c.text).join(" ").replace(/\s+/g, " ").trim();
  }
  const subtitleFormat = format === "text" ? "vtt" : format;
  const cues = chunks.flatMap(c => c.segments).filter(s => s.text).flatMap(s => segmentCues(s, args));
  const body = cues.map((cue, i) => `${i + 1}\n${timestamp(cue.start, subtitleFormat)} --> ${timestamp(cue.end, subtitleFormat)}\n${cue.text}`).join("\n\n");
  return `${subtitleFormat === "vtt" ? "WEBVTT\n\n" : ""}${body}${body ? "\n" : ""}`;
}
