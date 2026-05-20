/**
 * Stateful scrubber for reasoning/thinking blocks in streamed assistant text.
 *
 * Licensed under the Apache License, Version 2.0 (the "License").
 */

export class StreamingThinkScrubber {
  private static readonly OPEN_TAG_NAMES = [
    "think",
    "thinking",
    "reasoning",
    "thought",
    "REASONING_SCRATCHPAD",
  ] as const;

  private static readonly OPEN_TAGS = StreamingThinkScrubber.OPEN_TAG_NAMES.map(
    (name) => `<${name}>`
  );
  private static readonly CLOSE_TAGS = StreamingThinkScrubber.OPEN_TAG_NAMES.map(
    (name) => `</${name}>`
  );

  private static readonly MAX_TAG_LEN = Math.max(
    ...[...StreamingThinkScrubber.OPEN_TAGS, ...StreamingThinkScrubber.CLOSE_TAGS].map((t) => t.length)
  );

  private inBlock = false;
  private buf = "";
  private lastEmittedEndedNewline = true;

  /**
   * Reset all state. Call at the top of every new turn.
   */
  public reset(): void {
    this.inBlock = false;
    this.buf = "";
    this.lastEmittedEndedNewline = true;
  }

  /**
   * Feed one delta; return the scrubbed visible portion.
   *
   * May return an empty string when the entire delta is reasoning
   * content or is being held back pending resolution of a partial
   * tag at the boundary.
   */
  public feed(text: string): string {
    if (!text) {
      return "";
    }
    let buf = this.buf + text;
    this.buf = "";
    const out: string[] = [];

    while (buf) {
      if (this.inBlock) {
        // Hunt for the earliest close tag.
        const [closeIdx, closeLen] = this.findFirstTag(buf, StreamingThinkScrubber.CLOSE_TAGS);
        if (closeIdx === -1) {
          // No close yet — hold back a potential partial close-tag prefix; discard everything else.
          const held = this.maxPartialSuffix(buf, StreamingThinkScrubber.CLOSE_TAGS);
          this.buf = held > 0 ? buf.slice(-held) : "";
          return out.join("");
        }
        // Found close: discard block content + tag, continue.
        buf = buf.slice(closeIdx + closeLen);
        this.inBlock = false;
      } else {
        // Priority 1 — closed <tag>X</tag> pair anywhere in buf.
        // Closed pairs are always an intentional, bounded construct, so no boundary gating.
        const pair = this.findEarliestClosedPair(buf);

        // Priority 2 — unterminated open tag at a block boundary.
        // Boundary-gated so prose that mentions '<think>' isn't over-stripped.
        const [openIdx, openLen] = this.findOpenAtBoundary(buf, out);

        // Pick whichever match comes earliest in the buffer.
        if (pair !== null && (openIdx === -1 || pair[0] <= openIdx)) {
          const [startIdx, endIdx] = pair;
          let preceding = buf.slice(0, startIdx);
          if (preceding) {
            preceding = this.stripOrphanCloseTags(preceding);
            if (preceding) {
              out.push(preceding);
              this.lastEmittedEndedNewline = preceding.endsWith("\n");
            }
          }
          buf = buf.slice(endIdx);
          continue;
        }

        if (openIdx !== -1) {
          // Unterminated open at boundary — emit preceding, enter block, continue loop with remainder.
          let preceding = buf.slice(0, openIdx);
          if (preceding) {
            preceding = this.stripOrphanCloseTags(preceding);
            if (preceding) {
              out.push(preceding);
              this.lastEmittedEndedNewline = preceding.endsWith("\n");
            }
          }
          this.inBlock = true;
          buf = buf.slice(openIdx + openLen);
          continue;
        }

        // No resolvable tag structure in buf. Hold back any partial-tag prefix at the tail so
        // a split tag across deltas isn't missed, then emit the rest.
        const heldOpen = this.maxPartialSuffix(buf, StreamingThinkScrubber.OPEN_TAGS);
        const heldClose = this.maxPartialSuffix(buf, StreamingThinkScrubber.CLOSE_TAGS);
        const held = Math.max(heldOpen, heldClose);

        let emitText = "";
        if (held > 0) {
          emitText = buf.slice(0, -held);
          this.buf = buf.slice(-held);
        } else {
          emitText = buf;
          this.buf = "";
        }

        if (emitText) {
          emitText = this.stripOrphanCloseTags(emitText);
          if (emitText) {
            out.push(emitText);
            this.lastEmittedEndedNewline = emitText.endsWith("\n");
          }
        }
        return out.join("");
      }
    }

    return out.join("");
  }

  /**
   * End-of-stream flush.
   *
   * If still inside an unterminated block, held-back content is discarded.
   * Otherwise, the held-back partial-tag tail is emitted verbatim.
   */
  public flush(): string {
    if (this.inBlock) {
      this.buf = "";
      this.inBlock = false;
      return "";
    }
    let tail = this.buf;
    this.buf = "";
    if (!tail) {
      return "";
    }
    tail = this.stripOrphanCloseTags(tail);
    if (tail) {
      this.lastEmittedEndedNewline = tail.endsWith("\n");
    }
    return tail;
  }

  private findFirstTag(buf: string, tags: readonly string[]): [number, number] {
    const bufLower = buf.toLowerCase();
    let bestIdx = -1;
    let bestLen = 0;
    for (const tag of tags) {
      const idx = bufLower.indexOf(tag.toLowerCase());
      if (idx !== -1 && (bestIdx === -1 || idx < bestIdx)) {
        bestIdx = idx;
        bestLen = tag.length;
      }
    }
    return [bestIdx, bestLen];
  }

  private findEarliestClosedPair(buf: string): [number, number] | null {
    const bufLower = buf.toLowerCase();
    let best: [number, number] | null = null;
    for (let idx = 0; idx < StreamingThinkScrubber.OPEN_TAGS.length; idx++) {
      const openTag = StreamingThinkScrubber.OPEN_TAGS[idx];
      const closeTag = StreamingThinkScrubber.CLOSE_TAGS[idx];
      const openLower = openTag.toLowerCase();
      const closeLower = closeTag.toLowerCase();

      const openIdx = bufLower.indexOf(openLower);
      if (openIdx === -1) {
        continue;
      }
      const closeIdx = bufLower.indexOf(closeLower, openIdx + openLower.length);
      if (closeIdx === -1) {
        continue;
      }
      const endIdx = closeIdx + closeLower.length;
      if (best === null || openIdx < best[0]) {
        best = [openIdx, endIdx];
      }
    }
    return best;
  }

  private findOpenAtBoundary(buf: string, alreadyEmitted: string[]): [number, number] {
    const bufLower = buf.toLowerCase();
    let bestIdx = -1;
    let bestLen = 0;
    for (const tag of StreamingThinkScrubber.OPEN_TAGS) {
      const tagLower = tag.toLowerCase();
      let searchStart = 0;
      while (true) {
        const idx = bufLower.indexOf(tagLower, searchStart);
        if (idx === -1) {
          break;
        }
        if (this.isBlockBoundary(buf, idx, alreadyEmitted)) {
          if (bestIdx === -1 || idx < bestIdx) {
            bestIdx = idx;
            bestLen = tag.length;
          }
          break;
        }
        searchStart = idx + 1;
      }
    }
    return [bestIdx, bestLen];
  }

  private isBlockBoundary(buf: string, idx: number, alreadyEmitted: string[]): boolean {
    if (idx === 0) {
      if (alreadyEmitted.length > 0) {
        return alreadyEmitted[alreadyEmitted.length - 1].endsWith("\n");
      }
      return this.lastEmittedEndedNewline;
    }
    const preceding = buf.slice(0, idx);
    const lastNl = preceding.lastIndexOf("\n");
    if (lastNl === -1) {
      const priorNewline =
        alreadyEmitted.length > 0
          ? alreadyEmitted[alreadyEmitted.length - 1].endsWith("\n")
          : this.lastEmittedEndedNewline;
      return priorNewline && preceding.trim() === "";
    }
    return preceding.slice(lastNl + 1).trim() === "";
  }

  private maxPartialSuffix(buf: string, tags: readonly string[]): number {
    if (!buf) {
      return 0;
    }
    const bufLower = buf.toLowerCase();
    const maxCheck = Math.min(bufLower.length, StreamingThinkScrubber.MAX_TAG_LEN - 1);
    for (let i = maxCheck; i > 0; i--) {
      const suffix = bufLower.slice(-i);
      for (const tag of tags) {
        const tagLower = tag.toLowerCase();
        if (tagLower.length > i && tagLower.startsWith(suffix)) {
          return i;
        }
      }
    }
    return 0;
  }

  private stripOrphanCloseTags(text: string): string {
    if (!text.includes("</")) {
      return text;
    }
    const textLower = text.toLowerCase();
    const out: string[] = [];
    let i = 0;
    while (i < text.length) {
      let matched = false;
      if (textLower.slice(i, i + 2) === "</") {
        for (const tag of StreamingThinkScrubber.CLOSE_TAGS) {
          const tagLower = tag.toLowerCase();
          const tagLen = tagLower.length;
          if (textLower.slice(i, i + tagLen) === tagLower) {
            let j = i + tagLen;
            while (j < text.length && " \t\n\r".includes(text[j])) {
              j++;
            }
            i = j;
            matched = true;
            break;
          }
        }
      }
      if (!matched) {
        out.push(text[i]);
        i++;
      }
    }
    return out.join("");
  }
}

/**
 * Helper utility to scrub an asynchronous string generator or browser stream.
 */
export async function* scrubStream(
  stream: AsyncIterable<string> | ReadableStream<string>
): AsyncGenerator<string, void, unknown> {
  const scrubber = new StreamingThinkScrubber();
  const iterable = isReadableStream(stream) ? toAsyncIterable(stream) : stream;

  for await (const chunk of iterable) {
    const visible = scrubber.feed(chunk);
    if (visible) {
      yield visible;
    }
  }
  const tail = scrubber.flush();
  if (tail) {
    yield tail;
  }
}

function isReadableStream(obj: any): obj is ReadableStream<string> {
  return obj && typeof obj.getReader === "function";
}

async function* toAsyncIterable(stream: ReadableStream<string>): AsyncIterable<string> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value !== undefined) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Utility to scrub a complete static string.
 */
export function scrubString(text: string): string {
  const scrubber = new StreamingThinkScrubber();
  const body = scrubber.feed(text);
  const tail = scrubber.flush();
  return body + tail;
}
