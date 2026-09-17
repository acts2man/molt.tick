/** Compile generated output using its fixed scaffold, without worker/API secrets. */
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface BuildResult {
  ok: boolean;
  exitCode: number | null;
  logPath: string;
  error?: string;
}

export async function verifyProductionBuild(siteDir: string, timeoutMs = 120000): Promise<BuildResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error('Build timeout must be positive');
  const logPath = join(siteDir, 'MOLT_BUILD.log');
  const env: NodeJS.ProcessEnv = { CI: '1', NODE_ENV: 'production' };
  for (const name of ['PATH', 'HOME', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LANG', 'LC_ALL']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  // This is credential minimization, not an OS sandbox. Run generated builds in
  // isolated workers with no filesystem/network access to production secrets.
  const result = await new Promise<{ code: number | null; log: string; error?: string }>((resolve) => {
    const child = spawn('npm', ['run', 'build'], { cwd: siteDir, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    let timedOut = false;
    const append = (chunk: Buffer) => { log = (log + chunk.toString()).slice(-2_000_000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { child.kill('SIGKILL'); }
    }, timeoutMs);
    child.once('error', (err) => { clearTimeout(timer); resolve({ code: null, log, error: err.message }); });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, log, error: timedOut ? 'Production build timed out' : code === 0 ? undefined : `Production build failed (exit ${code})` });
    });
  });
  await writeFile(logPath, result.log + (result.error ? `\n${result.error}\n` : ''));
  return { ok: result.code === 0 && !result.error, exitCode: result.code, logPath, ...(result.error ? { error: result.error } : {}) };
}
