# transcribe-bench

LLM-as-judge benchmark for comparing ASR provider transcripts. It runs a sorted, ranked markdown table comparing transcripts produced by configured providers, including hybrid timestamp/text paths, against an auto-picked reference.

## What it does

1. Loads a transcript per provider - either from cached results in `TRANSCRIBE_BENCH_CACHE_DIR`, the repo-adjacent `transcribe-bench-cache/result_*.{json,txt,srt}`, or live from Cortex GraphQL when `--live` is set.
2. Picks a reference transcript (`trint` if available, else `elevenlabs`, else longest).
3. Asks an LLM judge (default `gemini-pro-31-vision` via cortex's `sys_generator_quick`) to score each non-reference candidate against the reference on `coverage / accuracy / readability / faithfulness / overall` (0-100 each), with a 1-line note.
4. Computes objective cue-quality (terminal-end %, mid-clause %, duration discipline, composite 0-100) for any provider that returned SRT.
5. Computes timing only against the selected reference when it has SRT; otherwise it uses the best available timestamped fallback and prints that timing reference explicitly in the report.
6. Writes a sorted markdown table to `results/bench_<timestamp>.md` and prints to stdout, with score columns reported on a `/100` scale.

## Quick start

```bash
cd helper-apps/transcribe-bench
./run.sh
```

Cortex must be reachable at `http://localhost:4000/graphql` (override with `CORTEX_URL=...`).

Cached transcript lookup defaults to the repo-adjacent `transcribe-bench-cache/`
directory. Set `TRANSCRIBE_BENCH_CACHE_DIR=/path/to/cache` when running the
benchmark elsewhere.

## Flags

| Flag          | Default                             | Meaning                                                                  |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| `--providers` | all                                 | Comma-separated subset (e.g. `xai+gemini,xai,gemini,whisper,elevenlabs`) |
| `--reference` | auto (trint / elevenlabs / longest) | Pin a specific provider as the reference                                 |
| `--judge`     | `gemini-pro-31-vision`              | Model name to use as the LLM judge                                       |
| `--live`      | off                                 | Re-run Cortex transcription pathways live (requires `--audioUrl`)        |
| `--audioUrl`  | none                                | A fetchable URL of the audio (needed for `--live`)                       |
| `--audio`     | `cached fixture`                    | Display label for the audio in the report                                |
| `--language`  | `ar`                                | Language hint passed to live transcribe pathways                         |
| `--output`    | `results/bench_<ts>.md`             | Where to write the report                                                |

## Layout

```
transcribe-bench/
  bench.mjs       # main entry: loads providers, judges, scores cues, writes table
  providers.mjs   # cached + live loaders, normalized to {name, text, srt?, source}
  judge.mjs       # LLM judge against the reference (sys_generator_quick chatHistory mode)
  score.mjs       # objective cue-quality (terminal %, mid-clause %, dur discipline)
  format.mjs      # sorted markdown table
  run.sh          # entry point with cortex health check
  results/        # output reports (gitignored)
```

## Notes

- Long transcripts are sampled in three windows (head / middle / tail) before being sent to the judge, to keep prompts inside model context limits while still observing the whole audio.
- The reference row is excluded from judging and surfaces with `**ref**` in the rank/overall columns.
- Cue-quality is shown only for providers that emit SRT.
- Timing quality is separate from text judging. For example, if `trint` is loaded as text-only, the report still judges content against Trint but must use another timestamped provider as the timing reference.
- The `xai+gemini` row is marked in the report when it is the configured `--star` provider.
