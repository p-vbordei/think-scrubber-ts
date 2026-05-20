# think-scrubber

A stateful, zero-dependency character/token stream parser to strip `<think>` tags and reasoning blocks from LLM output streams in real-time.

## License

Apache License 2.0 (100% independent and open-source).

## Features

- **Stateful Boundary Resolution**: Safely handles partial tags split across stream delta boundaries (e.g., chunk 1 ends in `</thi` and chunk 2 starts with `nk>`).
- **Orphan-Close Cleanup**: Detects and strips orphaned close tags (e.g., `</think>`) when no open tag is active.
- **Boundary Gating**: Ensures `<think>` used in conversation as normal text (e.g. `"Write a <think> block here."`) is *not* accidentally stripped, while genuine reasoning blocks are safely discarded.
- **Multiple Tag Support**: Handles `<think>`, `<thinking>`, `<reasoning>`, `<thought>`, and `<REASONING_SCRATCHPAD>` tags (case-insensitive).
- **Environment Agnostic**: Works perfectly in Node.js, browsers, Cloudflare Workers, and Edge runtimes.

## Installation

```bash
npm install think-scrubber
```

## Usage

### 1. Simple Stream Feed

Use `StreamingThinkScrubber` statefully chunk-by-chunk:

```typescript
import { StreamingThinkScrubber } from 'think-scrubber';

const scrubber = new StreamingThinkScrubber();

// On stream start
scrubber.reset();

// Inside your stream reader
const chunk1 = scrubber.feed("Hello "); // returns "Hello "
const chunk2 = scrubber.feed("<thi");   // returns "" (buffered)
const chunk3 = scrubber.feed("nk>hidden thought</"); // returns "" (buffered)
const chunk4 = scrubber.feed("think> World"); // returns " World"

// On stream end
const tail = scrubber.flush(); // returns ""
```

### 2. Async Generator Stream Helper

Scrub an async iterable of string chunks directly:

```typescript
import { scrubStream } from 'think-scrubber';

const rawStream = getLlmStream(); // AsyncIterable<string>

for await (const cleanChunk of scrubStream(rawStream)) {
  process.stdout.write(cleanChunk);
}
```

### 3. Static String Helper

For non-streaming string cleanup:

```typescript
import { scrubString } from 'think-scrubber';

const cleaned = scrubString("Normal prose <think>some reasoning</think> other prose");
// returns "Normal prose  other prose"
```
