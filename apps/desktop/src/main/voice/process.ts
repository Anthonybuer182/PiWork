/**
 * Child-process helpers for the local adapters (`say`, PowerShell, whisper).
 *
 * These are the only adapters that touch the OS rather than HTTP. Arguments
 * are always passed as an array (never a shell string), so user text cannot be
 * interpreted as flags or commands.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface RunResult {
  stdout: string;
  stderr: string;
}

export async function runProcess(
  command: string,
  args: string[],
  timeoutMs = 60_000,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(command, args, { windowsHide: true });

    const stdout: string[] = [];
    const stderr: string[] = [];
    child.stdout.on('data', (chunk) => stdout.push(String(chunk)));
    child.stderr.on('data', (chunk) => stderr.push(String(chunk)));

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`本地语音进程超时（${command}）`));
    }, timeoutMs);

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        err.message.includes('ENOENT')
          ? new Error(`未找到可执行文件「${command}」，请确认已安装并填写完整路径`)
          : err,
      );
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const result = { stdout: stdout.join(''), stderr: stderr.join('') };
      if (code === 0) resolve(result);
      else reject(new Error(`${command} 退出码 ${code}：${result.stderr.slice(0, 500)}`));
    });
  });
}

/** Create a temp directory for one request and always remove it afterwards. */
export async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pi-voice-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function writeTextFile(path: string, text: string): Promise<void> {
  await writeFile(path, text, 'utf8');
}

export async function readFileBuffer(path: string): Promise<Buffer> {
  return readFile(path);
}
