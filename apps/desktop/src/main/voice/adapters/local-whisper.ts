/**
 * Local transcription through whisper.cpp's `whisper-cli`.
 *
 * Not bundled (the model is hundreds of MB); the settings page points at a
 * user-installed binary and ggml model. Output uses `-oj` (JSON) so the text
 * never has to be parsed out of human-oriented log lines.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runProcess, withTempDir } from '../process.js';
import type { ResolvedVoiceProvider, VoiceAdapter } from '../types.js';

export interface WhisperArgs {
  binaryPath: string;
  modelPath: string;
  audioPath: string;
  outBase: string;
  language?: string;
}

export function buildWhisperArgs({
  modelPath,
  audioPath,
  outBase,
  language,
}: Omit<WhisperArgs, 'binaryPath'>): string[] {
  return [
    '-m', modelPath,
    '-f', audioPath,
    '-oj',
    '-of', outBase,
    '-l', language || 'auto',
  ];
}

function whisperText(data: unknown): string | undefined {
  if (!data || typeof data !== 'object') return undefined;
  const record = data as {
    text?: unknown;
    transcription?: Array<{ text?: unknown }>;
  };
  if (typeof record.text === 'string') return record.text;
  if (Array.isArray(record.transcription)) {
    return record.transcription
      .map((item) => (typeof item?.text === 'string' ? item.text : ''))
      .join('')
      .trim();
  }
  return undefined;
}

export const localWhisperAdapter: VoiceAdapter = {
  async transcribe(provider, audio) {
    const binaryPath = provider.entry.options?.binaryPath || 'whisper-cli';
    const modelPath = provider.entry.options?.modelPath || provider.model;
    if (!modelPath) throw new Error('请填写 whisper.cpp 的模型文件路径');

    return withTempDir(async (dir) => {
      const audioPath = join(dir, 'input.wav');
      const outBase = join(dir, 'result');
      await writeFile(audioPath, audio);
      await runProcess(
        binaryPath,
        buildWhisperArgs({ modelPath, audioPath, outBase, language: provider.language }),
        120_000,
      );
      const raw = await readFile(`${outBase}.json`, 'utf8');
      const text = whisperText(JSON.parse(raw));
      if (text === undefined) throw new Error('whisper.cpp 输出格式无法识别');
      return text.trim();
    });
  },
};
