# Chat History Compression Quality Guide

## Testing Compression Quality

### 1. Information Retention Tests

Run the test suite to verify compression preserves:
- ✅ User's original question/task
- ✅ Tool names and purposes
- ✅ Key findings from tool results
- ✅ Citations and URLs
- ✅ File names and references
- ✅ Important data points (numbers, dates, names)

```bash
npm test -- tests/integration/features/compression/sys_compress_chat_history.test.js
```

### 2. Manual Quality Assessment

Create test cases with real chat histories and evaluate:

**Key Questions:**
1. Can another AI agent continue the task after reading the compressed summary?
2. Are all critical facts preserved?
3. Are citations intact and usable?
4. Is the narrative flow maintained?

**Example Test Case:**
```javascript
const testCase = {
    original: [/* long chat history with 20+ tool calls */],
    compressed: await compressChatHistory(original),
    questions: [
        "What was the original user question?",
        "What tools were used?",
        "What were the key findings?",
        "What URLs/citations were found?"
    ]
};
```

### 3. Compression Metrics

Track these metrics:
- **Token Reduction**: Target 60-80% reduction
- **Information Retention**: >90% of critical facts preserved
- **Citation Preservation**: 100% of URLs preserved
- **Readability**: Human-readable narrative format

## Improving Compression Quality

### Current Strengths
- ✅ Uses Gemini 3 Flash with high reasoning effort (1M token context)
- ✅ Explicit instructions to preserve citations and context
- ✅ Handles tool calls and results correctly
- ✅ Formats multimodal content

### Areas for Improvement

#### 1. Prompt Engineering

**Current Prompt Issues:**
- Generic instructions may not emphasize critical data enough
- No explicit instruction to preserve numbers/dates
- No guidance on what to prioritize when space is limited

**Improvements:**
```javascript
// Add to system prompt:
"CRITICAL: When compressing, ALWAYS preserve:
- Exact numbers, percentages, dollar amounts, dates
- All URLs and file paths exactly as written
- Tool names and their purposes
- Source citations with full attribution
- Any data that would be needed to verify claims or continue research"
```

#### 2. Structured Output Format

**Current:** Free-form narrative
**Improvement:** Structured format for better parsing

```javascript
// Consider structured format:
{
  "userRequest": "...",
  "toolsUsed": [
    { "name": "SearchInternet", "purpose": "...", "keyFindings": "..." }
  ],
  "citations": ["url1", "url2"],
  "keyFacts": ["$77B revenue", "12% price increase"],
  "conclusion": "..."
}
```

#### 3. Two-Pass Compression

**Current:** Single pass compression
**Improvement:** Two-pass approach

1. **First Pass**: Extract critical facts (numbers, URLs, citations)
2. **Second Pass**: Compress narrative while preserving extracted facts

#### 4. Context-Aware Compression

**Current:** Generic compression
**Improvement:** Task-specific compression

```javascript
// Detect task type and adjust compression strategy
if (taskType === 'fact-checking') {
  // Prioritize: citations, numbers, source credibility
} else if (taskType === 'coding') {
  // Prioritize: code snippets, file paths, error messages
} else if (taskType === 'research') {
  // Prioritize: URLs, key findings, methodology
}
```

#### 5. Citation Extraction

**Current:** Relies on model to preserve citations
**Improvement:** Explicit citation extraction

```javascript
// Extract citations before compression
const citations = extractCitations(chatHistory);
// Include in prompt: "These citations MUST be preserved: [list]"
```

#### 6. Quality Validation

**Current:** No validation of compression quality
**Improvement:** Post-compression validation

```javascript
// After compression, validate:
- All URLs from original are present
- All tool names are mentioned
- Key numbers are preserved
- User question is referenced
```

### Implementation Priority

1. **High Priority:**
   - Improve prompt to emphasize numbers, URLs, citations
   - Add citation extraction before compression
   - Add post-compression validation

2. **Medium Priority:**
   - Structured output format
   - Two-pass compression
   - Task-specific strategies

3. **Low Priority:**
   - Advanced context-aware compression
   - Machine learning for quality scoring

## Testing Strategy

### Unit Tests
- Formatting logic
- Citation extraction
- Information extraction

### Integration Tests
- End-to-end compression with real model
- Quality metrics validation
- Error handling

### Manual Evaluation
- Create test cases from real conversations
- Human evaluation of compressed summaries
- A/B testing different prompt versions

## Metrics Dashboard

Track these metrics over time:
- Average compression ratio
- Information retention rate
- Citation preservation rate
- Model API errors during compression
- Time to compress

## Example Improvements

### Before (Current):
```
The user asked about tariffs. Research was done using search tools. 
Some findings were discovered about economic impacts.
```

### After (Improved):
```
User asked: "Did Trump tariffs help America?"

Research via SearchInternet:
- USITC Report (https://www.usitc.gov/publications/5405): Section 301 tariffs 
  generated $77 billion revenue but increased consumer prices by 12%
- Federal Reserve study: 95-100% tariff costs passed through to U.S. consumers
- Census Bureau data: Trade deficit with China increased from $375B (2017) 
  to $419B (2019) despite tariffs

Conclusion: Tariffs did not reduce trade deficit; costs largely borne by 
U.S. consumers.
```

**Key Improvements:**
- Exact user question preserved
- Tool name mentioned
- All URLs preserved
- All numbers preserved
- Clear structure

