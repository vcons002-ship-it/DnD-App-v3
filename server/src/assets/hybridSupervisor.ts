import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const scriptsDir = fileURLToPath(new URL('../../tools/asset-production/', import.meta.url));
const logRoot = path.join(config.dataDir, 'asset-production');

const managedChildren = new Map<string, ChildProcess>();
const inflight = new Map<string, Promise<boolean>>();
let exitHookRegistered = false;

function registerExitCleanup() {
  if (exitHookRegistered) return;
  exitHookRegistered = true;
  const stopAll = () => {
    for (const [, child] of managedChildren) {
      try {
        if (!child.killed) child.kill();
      } catch {
        /* ignore shutdown races */
      }
    }
    managedChildren.clear();
  };
  process.once('exit', stopAll);
}

function listWindowsUserDirs(): string[] {
  const usersRoot = 'C:/Users';
  if (process.platform !== 'win32' || !fs.existsSync(usersRoot)) return [];
  try {
    return fs
      .readdirSync(usersRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !['Public', 'Default', 'Default User', 'All Users'].includes(d.name))
      .map((d) => path.join(usersRoot, d.name));
  } catch {
    return [];
  }
}

function commandWorks(cmd: string, args = ['--version']): boolean {
  try {
    const res = spawnSync(cmd, args, { windowsHide: true, timeout: 5000, stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}

let cachedPython: string | undefined;
/**
 * Resolve a working Python executable even when the server runs as a Windows
 * LocalSystem service (where user-installed Python isn't on the Machine PATH).
 */
export function resolveAssetPython(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ASSET_PYTHON) return env.ASSET_PYTHON;
  if (env === process.env && cachedPython) return cachedPython;
  if (commandWorks('python')) {
    if (env === process.env) cachedPython = 'python';
    return 'python';
  }
  if (process.platform === 'win32') {
    const candidates: string[] = [];
    for (const userDir of [os.homedir(), ...listWindowsUserDirs()]) {
      const pyRoot = path.join(userDir, 'AppData/Local/Programs/Python');
      if (fs.existsSync(pyRoot)) {
        try {
          const versions = fs
            .readdirSync(pyRoot, { withFileTypes: true })
            .filter((d) => d.isDirectory() && /^Python3\d+$/i.test(d.name))
            .map((d) => d.name)
            .sort()
            .reverse();
          for (const v of versions) candidates.push(path.join(pyRoot, v, 'python.exe'));
        } catch {
          /* ignore unreadable user dir */
        }
      }
    }
    candidates.push(
      'C:/pinokio/api/Hunyuan3d-2-lowvram/app/env/Scripts/python.exe',
      'C:/pinokio/api/Hunyuan3D-2.1-WinPortable/runtime/Hunyuan3D2_WinPortable/python_standalone/python.exe',
    );
    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && commandWorks(candidate)) {
        if (env === process.env) cachedPython = candidate;
        return candidate;
      }
    }
  }
  return 'python';
}

let cachedBlender: string | undefined;
/** Resolve Blender 5.x/4.x on Windows or PATH across user and service accounts. */
export function resolveAssetBlender(env: NodeJS.ProcessEnv = process.env): string {
  if (env.ASSET_BLENDER) return env.ASSET_BLENDER;
  if (env === process.env && cachedBlender) return cachedBlender;
  if (process.platform === 'win32') {
    const preferred = 'C:/Program Files/Blender Foundation/Blender 5.1/blender.exe';
    if (fs.existsSync(preferred)) {
      if (env === process.env) cachedBlender = preferred;
      return preferred;
    }
    const foundation = 'C:/Program Files/Blender Foundation';
    if (fs.existsSync(foundation)) {
      try {
        const dirs = fs
          .readdirSync(foundation, { withFileTypes: true })
          .filter((d) => d.isDirectory() && /^Blender\b/i.test(d.name))
          .map((d) => d.name)
          .sort()
          .reverse();
        for (const dir of dirs) {
          const exe = path.join(foundation, dir, 'blender.exe');
          if (fs.existsSync(exe)) {
            if (env === process.env) cachedBlender = exe;
            return exe;
          }
        }
      } catch {
        /* ignore */
      }
    }
  }
  return 'blender';
}

export function parseLocalWorkerPort(rawUrl: string, env: NodeJS.ProcessEnv = process.env): number | null {
  if (env.HUNYUAN_AUTO_START === '0' || env.VITEST || env.NODE_ENV === 'test' || env.PLACEHOLDER_MODELS === '1') {
    return null;
  }
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:') return null;
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') return null;
    const port = Number(parsed.port || 80);
    if (!Number.isInteger(port) || port <= 1024 || port > 65535) return null;
    return port;
  } catch {
    return null;
  }
}

async function checkHybridHealth(baseUrl: string, timeoutMs = 2500): Promise<'ready' | 'busy' | 'offline'> {
  try {
    const res = await fetch(baseUrl.replace(/\/$/, '') + '/health', { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return 'offline';
    const data = (await res.json()) as { protocol?: string; running?: boolean };
    if (data?.protocol !== 'dnd-hybrid-v1') return 'offline';
    return data.running ? 'busy' : 'ready';
  } catch {
    return 'offline';
  }
}

function findPinokioRoot(subpath: string, explicit?: string): { pinokioRoot: string; appRoot: string } | null {
  if (explicit !== undefined) {
    return fs.existsSync(explicit) ? { pinokioRoot: path.resolve(explicit, '../..'), appRoot: explicit } : null;
  }
  const bases = [
    'C:/pinokio',
    'D:/pinokio',
    path.join(os.homedir(), 'pinokio'),
    ...listWindowsUserDirs().map((u) => path.join(u, 'pinokio')),
  ];
  for (const base of bases) {
    const candidate = path.join(base, 'api', subpath);
    if (fs.existsSync(candidate)) return { pinokioRoot: base, appRoot: candidate };
  }
  return null;
}

type WorkerLaunchSpec = {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  logFile: string;
};

export function resolveHybridWorkerSpec(
  kind: 'shape' | 'paint',
  port: number,
  env: NodeJS.ProcessEnv = process.env,
): WorkerLaunchSpec | null {
  if (kind === 'shape') {
    const found = findPinokioRoot('Hunyuan3d-2-lowvram', env.HUNYUAN_SHAPE_ROOT);
    if (!found) return null;
    const cwd = env.HUNYUAN_SHAPE_CWD || path.join(found.appRoot, 'app');
    const pythonExe =
      env.HUNYUAN_SHAPE_PYTHON ||
      (process.platform === 'win32'
        ? path.join(cwd, 'env/Scripts/python.exe')
        : path.join(cwd, 'env/bin/python'));
    const workerScript = path.join(scriptsDir, 'hybrid_shape_worker.py');
    if (!fs.existsSync(pythonExe) || !fs.existsSync(cwd) || !fs.existsSync(workerScript)) return null;

    const cacheRoot = path.join(found.pinokioRoot, 'cache');
    const hfHome = path.join(cacheRoot, 'HF_HOME');
    const childEnv: NodeJS.ProcessEnv = {
      ...env,
      PYTHONUNBUFFERED: '1',
      ...(fs.existsSync(hfHome)
        ? {
            HF_HOME: hfHome,
            HF_HUB_CACHE: path.join(hfHome, 'hub'),
            TORCH_HOME: path.join(cacheRoot, 'TORCH_HOME'),
            XDG_CACHE_HOME: path.join(cacheRoot, 'XDG_CACHE_HOME'),
            XDG_DATA_HOME: path.join(cacheRoot, 'XDG_DATA_HOME'),
            U2NET_HOME: path.join(cacheRoot, 'XDG_DATA_HOME/.u2net'),
            GRADIO_TEMP_DIR: path.join(cacheRoot, 'GRADIO_TEMP_DIR'),
          }
        : {}),
    };
    const scriptsBin = path.dirname(pythonExe);
    childEnv.PATH = `${scriptsBin}${path.delimiter}${env.PATH ?? ''}`;
    return {
      command: pythonExe,
      args: [workerScript, String(port)],
      cwd,
      env: childEnv,
      logFile: path.join(logRoot, 'hybrid-shape-worker.log'),
    };
  }

  const found = findPinokioRoot('Hunyuan3D-2.1-WinPortable', env.HUNYUAN_PAINT_ROOT);
  if (!found) return null;
  const portableRoot = path.join(found.appRoot, 'runtime/Hunyuan3D2_WinPortable');
  const cwd = env.HUNYUAN_PAINT_CWD || path.join(portableRoot, 'Hunyuan3D-2.1');
  const pythonExe =
    env.HUNYUAN_PAINT_PYTHON ||
    (process.platform === 'win32'
      ? path.join(portableRoot, 'python_standalone/python.exe')
      : path.join(portableRoot, 'python_standalone/bin/python'));
  const workerScript = path.join(scriptsDir, 'hybrid_paint_worker.py');
  if (!fs.existsSync(pythonExe) || !fs.existsSync(cwd) || !fs.existsSync(workerScript)) return null;

  const hfHub = path.join(portableRoot, 'HuggingFaceHub');
  const cacheRoot = path.join(found.pinokioRoot, 'cache');
  const childEnv: NodeJS.ProcessEnv = {
    ...env,
    PYTHONUNBUFFERED: '1',
    ...(fs.existsSync(hfHub)
      ? {
          HF_HOME: hfHub,
          HF_HUB_CACHE: hfHub,
          HY3DGEN_MODELS: hfHub,
        }
      : {}),
    ...(fs.existsSync(path.join(cacheRoot, 'TORCH_HOME')) ? { TORCH_HOME: path.join(cacheRoot, 'TORCH_HOME') } : {}),
    ...(fs.existsSync(path.join(cacheRoot, 'XDG_DATA_HOME/.u2net'))
      ? { U2NET_HOME: path.join(cacheRoot, 'XDG_DATA_HOME/.u2net') }
      : {}),
  };
  return {
    command: pythonExe,
    args: ['-s', workerScript, String(port)],
    cwd,
    env: childEnv,
    logFile: path.join(logRoot, 'hybrid-paint-worker.log'),
  };
}

/**
 * Ensure the requested local Hunyuan worker (`shape` on :42005 or `paint` on :42004)
 * is running and healthy. Spawns it automatically if installed locally and waits
 * until `/health` responds with `protocol: "dnd-hybrid-v1"`.
 */
export async function ensureHybridWorker(
  kind: 'shape' | 'paint',
  baseUrl: string,
  onStarting?: () => void,
  signal?: AbortSignal,
  opts: { detachedDaemon?: boolean } = {},
): Promise<boolean> {
  const port = parseLocalWorkerPort(baseUrl);
  if (port === null) return false;

  const initial = await checkHybridHealth(baseUrl, 2000);
  if (initial !== 'offline') return true;

  const key = `${kind}:${port}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const task = (async () => {
    try {
      const recheck = await checkHybridHealth(baseUrl, 1500);
      if (recheck !== 'offline') return true;

      const spec = resolveHybridWorkerSpec(kind, port);
      if (!spec) return false;

      onStarting?.();
      fs.mkdirSync(path.dirname(spec.logFile), { recursive: true });
      const logFd = fs.openSync(spec.logFile, 'a');
      let exited = false;
      let child: ChildProcess;
      try {
        if (!opts.detachedDaemon) registerExitCleanup();
        child = spawn(spec.command, spec.args, {
          cwd: spec.cwd,
          env: spec.env,
          windowsHide: true,
          detached: !!opts.detachedDaemon,
          shell: false,
          stdio: ['ignore', logFd, logFd],
        });
        if (opts.detachedDaemon) child.unref();
      } finally {
        fs.closeSync(logFd);
      }

      if (!opts.detachedDaemon) managedChildren.set(key, child);
      child.once('exit', () => {
        exited = true;
        if (managedChildren.get(key) === child) managedChildren.delete(key);
      });
      child.once('error', () => {
        exited = true;
        if (managedChildren.get(key) === child) managedChildren.delete(key);
      });

      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        if (signal?.aborted) return false;
        if (exited) return false;
        const state = await checkHybridHealth(baseUrl, 2000);
        if (state !== 'offline') {
          console.log(`  [3d] Local Hunyuan ${kind} worker ready at ${baseUrl}`);
          return true;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      return false;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

/**
 * Optionally auto-start local ComfyUI (:8188) if installed in a known portable
 * folder and not already listening.
 */
export async function ensureComfyServer(opts: { detachedDaemon?: boolean } = {}): Promise<boolean> {
  if (
    process.env.COMFY_AUTO_START === '0' ||
    process.env.VITEST ||
    process.env.NODE_ENV === 'test' ||
    process.env.PLACEHOLDER_MODELS === '1' ||
    !config.comfyUrl
  ) {
    return false;
  }
  let port: number;
  try {
    const u = new URL(config.comfyUrl);
    if ((u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') || u.protocol !== 'http:') return false;
    port = Number(u.port || 80);
    if (!Number.isInteger(port) || port <= 1024) return false;
  } catch {
    return false;
  }

  try {
    const res = await fetch(`${config.comfyUrl}/system_stats`, { signal: AbortSignal.timeout(2000) });
    if (res.ok) return true;
  } catch {
    /* offline — try auto-start below */
  }

  const key = `comfy:${port}`;
  const existing = inflight.get(key);
  if (existing) return existing;

  const roots = [
    process.env.COMFY_ROOT,
    'C:/ComfyUI_windows_portable',
    'D:/ComfyUI_windows_portable',
    path.join(os.homedir(), 'VisualReader/ComfyUI_windows_portable'),
    path.join(os.homedir(), 'ComfyUI_windows_portable'),
    ...listWindowsUserDirs().flatMap((u) => [
      path.join(u, 'VisualReader/ComfyUI_windows_portable'),
      path.join(u, 'ComfyUI_windows_portable'),
    ]),
  ].filter((x): x is string => !!x);

  const comfyRoot = roots.find(
    (r) =>
      fs.existsSync(path.join(r, 'python_embeded/python.exe')) &&
      fs.existsSync(path.join(r, 'ComfyUI/main.py')),
  );
  if (!comfyRoot) return false;

  const task = (async () => {
    try {
      const pyExe = path.join(comfyRoot, 'python_embeded/python.exe');
      const mainPy = path.join(comfyRoot, 'ComfyUI/main.py');
      const logFile = path.join(logRoot, 'comfyui-autostart.log');
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const logFd = fs.openSync(logFile, 'a');
      let exited = false;
      let child: ChildProcess;
      try {
        if (!opts.detachedDaemon) registerExitCleanup();
        child = spawn(
          pyExe,
          [
            '-s',
            '-u',
            mainPy,
            '--port',
            String(port),
            '--enable-cors-header',
            '*',
            '--vram-headroom',
            '4',
            '--disable-pinned-memory',
            '--cache-classic',
          ],
          {
            cwd: comfyRoot,
            windowsHide: true,
            detached: !!opts.detachedDaemon,
            shell: false,
            stdio: ['ignore', logFd, logFd],
          },
        );
        if (opts.detachedDaemon) child.unref();
      } finally {
        fs.closeSync(logFd);
      }
      if (!opts.detachedDaemon) managedChildren.set(key, child);
      child.once('exit', () => {
        exited = true;
        if (managedChildren.get(key) === child) managedChildren.delete(key);
      });
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline && !exited) {
        try {
          const res = await fetch(`${config.comfyUrl}/system_stats`, { signal: AbortSignal.timeout(2000) });
          if (res.ok) {
            console.log(`  [comfy] Local ComfyUI ready at ${config.comfyUrl}`);
            return true;
          }
        } catch {
          /* still booting */
        }
        await new Promise((r) => setTimeout(r, 750));
      }
      return false;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}

/**
 * Non-blocking background warmup called on server startup. Both Hunyuan workers
 * keep their GPU pipelines unloaded (`0 MB` VRAM) until an asset job executes.
 */
export function warmHybridWorkers(
  urls = {
    shape: process.env.HUNYUAN_SHAPE_URL || 'http://127.0.0.1:42005',
    paint: process.env.HUNYUAN_PAINT_URL || 'http://127.0.0.1:42004',
  },
) {
  if (parseLocalWorkerPort(urls.shape) !== null) {
    void ensureHybridWorker('shape', urls.shape).catch(() => {});
  }
  if (parseLocalWorkerPort(urls.paint) !== null) {
    void ensureHybridWorker('paint', urls.paint).catch(() => {});
  }
}
