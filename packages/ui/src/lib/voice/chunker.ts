/**
 * Turn an assistant reply into speakable chunks.
 *
 * Markdown is for eyes: code fences, tables and link syntax read as noise.
 * Splitting per sentence (not per paragraph) also keeps the first audio chunk
 * small enough to start playing while the next one synthesizes.
 */

/**
 * Upper bound for one synthesis request. Larger chunks read more naturally but
 * take longer to synthesize than the previous chunk takes to play, which
 * causes audible stalls; 160 chars stays comfortably ahead of playback.
 */
const MAX_CHUNK_LEN = 160;
/** The first chunk stays short so playback can start quickly. */
const FIRST_CHUNK_LEN = 30;
const MIN_CHUNK_LEN = 2;
const MAX_TOTAL_CHARS = 8_000;

/**
 * Chunk sizes ramp up: the short opening is followed by a moderate chunk (its
 * synthesis must beat the opening's ~4 s of audio), then steady 140-char
 * chunks that the two-chunk prefetch always keeps ahead of.
 */
function chunkLimit(index: number): number {
  if (index === 0) return FIRST_CHUNK_LEN;
  if (index === 1) return 60;
  return 140;
}

/** Strip formatting that no TTS engine should pronounce. */
export function stripMarkdownForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, '')
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, ' ') // table separator rows
    .replace(/\|/g, ' ')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

const SENTENCE_END = /[。！？!?；;…]/;
const CLOSERS = /[”’」』）)\]】》]/;

function splitSentences(text: string): string[] {
  const chunks: string[] = [];
  let buffer = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    buffer += ch;

    let boundary = SENTENCE_END.test(ch);
    if (!boundary && ch === '.') {
      const next = text[i + 1];
      const prev = text[i - 1] ?? '';
      boundary = next === undefined || /\s/.test(next) || !(/\d/.test(prev) && /\d/.test(next));
    }
    if (!boundary && ch === '\n') {
      boundary = true;
    }

    if (boundary) {
      while (i + 1 < text.length && CLOSERS.test(text[i + 1])) {
        i += 1;
        buffer += text[i];
      }
      const trimmed = buffer.trim();
      if (trimmed) chunks.push(trimmed);
      buffer = '';
    }
  }
  const tail = buffer.trim();
  if (tail) chunks.push(tail);
  return chunks;
}

function splitLong(sentence: string, maxLen: number): string[] {
  if (sentence.length <= maxLen) return [sentence];
  const parts: string[] = [];
  let rest = sentence;
  while (rest.length > maxLen) {
    let cut = -1;
    for (const mark of ['，', ',', '、', '：', ':', ' ']) {
      cut = Math.max(cut, rest.lastIndexOf(mark, maxLen));
    }
    if (cut < maxLen * 0.3) cut = maxLen;
    else cut += 1;
    const piece = rest.slice(0, cut).trim();
    if (piece) parts.push(piece);
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

export interface ChunkOptions {
  maxLen?: number;
  minLen?: number;
}

/** Merge tiny fragments into a neighbour so the player does not stutter. */
function mergeShort(chunks: string[], minLen: number): string[] {
  const merged: string[] = [];
  for (const chunk of chunks) {
    if (merged.length > 0 && chunk.length < minLen) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${chunk}`;
    } else {
      merged.push(chunk);
    }
  }
  // A short first chunk is better appended to the second than read alone.
  if (merged.length > 1 && merged[0].length < minLen) {
    merged[1] = `${merged[0]} ${merged[1]}`;
    merged.shift();
  }
  return merged;
}

export function splitIntoSentences(text: string, options: ChunkOptions = {}): string[] {
  const maxLen = options.maxLen ?? MAX_CHUNK_LEN;
  const minLen = options.minLen ?? MIN_CHUNK_LEN;
  if (!text.trim()) return [];

  const pieces = splitSentences(text)
    .flatMap((sentence) => splitLong(sentence, maxLen))
    .filter((piece) => piece.length > 0);
  return mergeShort(pieces, minLen).filter((piece) => piece.trim().length > 0);
}

/**
 * Sentences packed into prosody-sized chunks.
 *
 * Synthesizing every sentence separately resets the model's prosody at each
 * punctuation mark, which reads as choppy. Packing several sentences per
 * request keeps the flow natural; only the first chunk is kept short so audio
 * starts quickly while the rest synthesizes ahead.
 */
export function speechChunks(text: string): string[] {
  const clean = stripMarkdownForSpeech(text).slice(0, MAX_TOTAL_CHARS);
  const sentences = splitIntoSentences(clean, { maxLen: MAX_CHUNK_LEN, minLen: 1 });
  const chunks: string[] = [];
  let buffer = '';
  let limit = chunkLimit(0);

  for (const sentence of sentences) {
    if (!buffer) {
      buffer = sentence;
      continue;
    }
    if (buffer.length + 1 + sentence.length <= limit) {
      buffer = `${buffer} ${sentence}`;
      continue;
    }
    chunks.push(buffer);
    buffer = sentence;
    limit = chunkLimit(chunks.length);
  }
  if (buffer) chunks.push(buffer);

  // A single long first sentence would still delay the first sound; split it at
  // the nearest clause mark when one is close enough.
  if (chunks[0] && chunks[0].length > FIRST_CHUNK_LEN) {
    let cut = -1;
    for (const mark of ['，', ',', '、', '：', ':', '；', ';']) {
      cut = Math.max(cut, chunks[0].lastIndexOf(mark, FIRST_CHUNK_LEN));
    }
    if (cut > 0) {
      const rest = chunks[0].slice(cut + 1).trim();
      chunks[0] = chunks[0].slice(0, cut + 1).trim();
      if (rest) chunks.splice(1, 0, rest);
    }
  }

  // Hard cap on what one reply can read aloud, without cutting mid-sentence.
  const capped: string[] = [];
  let total = 0;
  for (const chunk of chunks) {
    if (total + chunk.length > MAX_TOTAL_CHARS) break;
    capped.push(chunk);
    total += chunk.length + 1;
  }
  return capped;
}
