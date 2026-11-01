/**
 * Offline fallback TTS through the OS voice.
 *
 * macOS uses `say`, which can write a WAV; Windows uses SAPI through
 * PowerShell. Both read the text from a temp file rather than argv — arguments
 * would hit length limits and shell-quoting edge cases on long replies.
 */

import { join } from 'node:path';
import { readFileBuffer, runProcess, withTempDir, writeTextFile } from '../process.js';
import type { ResolvedVoiceProvider, VoiceAdapter } from '../types.js';

export interface SayArgs {
  textPath: string;
  outPath: string;
  voice?: string;
}

export function buildSayArgs({ textPath, outPath, voice }: SayArgs): string[] {
  const args = [
    '-f', textPath,
    '-o', outPath,
    '--file-format=WAVE',
    '--data-format=LEI16@22050',
  ];
  if (voice) args.push('-v', voice);
  return args;
}

export interface PowerShellArgs {
  script: string;
}

/** `-EncodedCommand` takes base64 UTF-16LE, which sidesteps every quoting rule. */
export function buildPowerShellCommand(script: string): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64'),
  ];
}

/** Single-quote a value for PowerShell, doubling embedded quotes. */
export function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildPowerShellScript(input: {
  textPath: string;
  outPath: string;
  voice?: string;
}): string {
  const lines = [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  ];
  if (input.voice) lines.push(`try { $s.SelectVoice(${psQuote(input.voice)}) } catch {}`);
  lines.push(
    `$s.SetOutputToWaveFile(${psQuote(input.outPath)})`,
    `$s.Speak([System.IO.File]::ReadAllText(${psQuote(input.textPath)}))`,
    '$s.Dispose()',
  );
  return lines.join('\n');
}

async function synthesizeWithSay(provider: ResolvedVoiceProvider, text: string): Promise<Buffer> {
  return withTempDir(async (dir) => {
    const textPath = join(dir, 'speech.txt');
    const outPath = join(dir, 'speech.wav');
    await writeTextFile(textPath, text);
    await runProcess('say', buildSayArgs({ textPath, outPath, voice: provider.voice || undefined }));
    return readFileBuffer(outPath);
  });
}

async function synthesizeWithSapi(provider: ResolvedVoiceProvider, text: string): Promise<Buffer> {
  return withTempDir(async (dir) => {
    const textPath = join(dir, 'speech.txt');
    const outPath = join(dir, 'speech.wav');
    await writeTextFile(textPath, text);
    const script = buildPowerShellScript({
      textPath,
      outPath,
      voice: provider.voice || undefined,
    });
    await runProcess('powershell.exe', buildPowerShellCommand(script));
    return readFileBuffer(outPath);
  });
}

export const systemTtsAdapter: VoiceAdapter = {
  async synthesize(provider, text) {
    const trimmed = text.trim();
    if (!trimmed) throw new Error('没有可朗读的文本');
    const bytes =
      process.platform === 'darwin'
        ? await synthesizeWithSay(provider, trimmed)
        : process.platform === 'win32'
          ? await synthesizeWithSapi(provider, trimmed)
          : (() => {
              throw new Error('当前系统不支持内置语音，请改用云端语音服务商');
            })();
    return { bytes, mimeType: 'audio/wav' };
  },
};
