import { describe, it, expect } from 'vitest';
import { StreamingThinkScrubber, scrubString, scrubStream } from '../src/index';

describe('StreamingThinkScrubber', () => {
  it('passes regular text untouched', () => {
    const scrubber = new StreamingThinkScrubber();
    expect(scrubber.feed('Hello world')).toBe('Hello world');
    expect(scrubber.flush()).toBe('');
  });

  it('scrubs a single block fully contained in one chunk (boundary open)', () => {
    const scrubber = new StreamingThinkScrubber();
    expect(scrubber.feed('<think>secret thought</think>Hello')).toBe('Hello');
    expect(scrubber.flush()).toBe('');
  });

  it('scrubs mid-sentence closed pairs even if not at boundary', () => {
    const scrubber = new StreamingThinkScrubber();
    expect(scrubber.feed('Hello <think>secret thought</think> World')).toBe('Hello  World');
    expect(scrubber.flush()).toBe('');
  });

  it('scrubs split open tags at boundary', () => {
    const scrubber = new StreamingThinkScrubber();
    expect(scrubber.feed('<thi')).toBe('');
    expect(scrubber.feed('nk>secret thoughts')).toBe('');
    expect(scrubber.feed(' continue</think>')).toBe('');
    expect(scrubber.feed(' World')).toBe(' World');
    expect(scrubber.flush()).toBe('');
  });

  it('scrubs split close tags starting at boundary', () => {
    const scrubber = new StreamingThinkScrubber();
    expect(scrubber.feed('<think>secret')).toBe('');
    expect(scrubber.feed(' thoughts </thi')).toBe('');
    expect(scrubber.feed('nk> World')).toBe(' World');
    expect(scrubber.flush()).toBe('');
  });

  it('handles multiple tag types like reasoning and thinking', () => {
    const scrubber = new StreamingThinkScrubber();
    expect(scrubber.feed('<thinking>a</thinking>')).toBe('');
    expect(scrubber.feed('<reasoning>b</reasoning>')).toBe('');
    expect(scrubber.feed('<thought>c</thought>')).toBe('');
    expect(scrubber.feed('<REASONING_SCRATCHPAD>d</REASONING_SCRATCHPAD>')).toBe('');
  });

  it('boundary rules: only open at start-of-line/whitespace is treated as reasoning block', () => {
    const scrubber = new StreamingThinkScrubber();
    // mid-sentence without matching close: not stripped (treated as prose)
    expect(scrubber.feed('Mentions <think> tag in sentence')).toBe('Mentions <think> tag in sentence');
    expect(scrubber.flush()).toBe('');

    scrubber.reset();
    // at line start: stripped
    expect(scrubber.feed('\n<think>block starts')).toBe('\n');
    expect(scrubber.feed('stuff')).toBe('');
    expect(scrubber.feed('</think>Prose')).toBe('Prose');
    expect(scrubber.flush()).toBe('');
  });

  it('strips orphan close tags and trailing spaces', () => {
    const scrubber = new StreamingThinkScrubber();
    expect(scrubber.feed('Hello </think> World')).toBe('Hello World');
  });

  it('flushes non-tag partials', () => {
    const scrubber = new StreamingThinkScrubber();
    expect(scrubber.feed('Hello <thi')).toBe('Hello ');
    expect(scrubber.flush()).toBe('<thi');
  });

  it('discards partial reasoning at end of stream', () => {
    const scrubber = new StreamingThinkScrubber();
    expect(scrubber.feed('<think>secret thoughts')).toBe('');
    expect(scrubber.flush()).toBe('');
  });

  it('static scrubString helper works', () => {
    expect(scrubString('Test <think>hidden</think> string')).toBe('Test  string');
    expect(scrubString('Orphan </think> tag')).toBe('Orphan tag');
  });

  it('static scrubStream helper works with async generator', async () => {
    async function* makeStream() {
      yield '<thi';
      yield 'nk>secret</';
      yield 'think>Hello World';
    }

    const result: string[] = [];
    for await (const chunk of scrubStream(makeStream())) {
      result.push(chunk);
    }
    expect(result.join('')).toBe('Hello World');
  });

  // --- NEW EXTENSIVE FUZZ & CHUNK-SIZING TESTS ---
  it('handles random chunk-size streaming of a long mixed input (Fuzz-like)', () => {
    // All tags are placed at block boundaries (start of line / preceded by newline)
    const input = "Here is some prose.\n<think>Reasoning block 1\nwith multiple lines.</think>\n" +
      "More prose here\n<thought>hidden thought</thought>\nand some more.\n" +
      "\n<REASONING_SCRATCHPAD>Another scratchpad block</REASONING_SCRATCHPAD>\n" +
      "Trailing prose:\n<think>this is blocked too at end";
    
    const expected = "Here is some prose.\n\n" +
      "More prose here\n\nand some more.\n" +
      "\n\n" +
      "Trailing prose:\n";

    // Stream this with various chunk sizes (1, 2, 5, 13, 27, 100)
    const chunkSizes = [1, 2, 5, 13, 27, 100];
    for (const size of chunkSizes) {
      const scrubber = new StreamingThinkScrubber();
      let output = "";
      for (let i = 0; i < input.length; i += size) {
        output += scrubber.feed(input.slice(i, i + size));
      }
      output += scrubber.flush();
      expect(output).toBe(expected);
    }
  });

  it('fuzzes random noise with scattered complete and unclosed tags', () => {
    // Generate a random character stream with tags injected
    const characters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ';
    let raw = "";
    let expected = "";
    
    for (let turn = 0; turn < 20; turn++) {
      if (Math.random() < 0.3) {
        // Inject a boundary think block
        const tag = Math.random() < 0.5 ? "think" : "reasoning";
        raw += `\n<${tag}>hidden content</${tag}>\n`;
        expected += `\n\n`;
      } else {
        // Prose char
        const c = characters[Math.floor(Math.random() * characters.length)];
        raw += c;
        expected += c;
      }
    }

    // Add one unclosed boundary tag at the very end
    raw += `\n<think>unclosed trailing content`;
    expected += `\n`; // Only the newline preceding the tag is emitted

    const scrubber = new StreamingThinkScrubber();
    let result = "";
    // Feed in small random chunks
    let idx = 0;
    while (idx < raw.length) {
      const take = Math.floor(Math.random() * 5) + 1;
      result += scrubber.feed(raw.slice(idx, idx + take));
      idx += take;
    }
    result += scrubber.flush();

    expect(result).toBe(expected);
  });
});
