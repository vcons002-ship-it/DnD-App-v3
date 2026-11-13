import { execFile } from 'node:child_process';
import { config } from '../config.js';
import type { OllamaModelDetail } from '../../../shared/ollamaModels.js';

/**
 * Low-level client for a local Ollama HTTP server — the local-LLM backend shared
 * by every AI feature (the rules assistant AND creature/character/item/spell
 * generation, via ai/gateway.ts). Pure: imports only config, so there are no
 * import cycles. Fail-safe: every call returns null/false on any error.
 */

/** Cached reachability from the last probe — drives the UI "AI available" flag
 *  without a per-request network round-trip. Refreshed on boot + settings save. */
let reachable = false;

export function ollamaReachable(): boolean {
  return reachable;
}

/** Whether a local Ollama URL + model are configured (defaults are always set). */
export function ollamaConfigured(): boolean {
  return !!(config.ollamaUrl && config.ollamaModel);
}

/** Probe the server (GET /api/tags) and cache whether it's up. */
export async function refreshOllama(): Promise<boolean> {
  if (!ollamaConfigured()) {
    reachable = false;
    return false;
  }
  try {
    const res = await fetch(`${config.ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(2500),
    });
    reachable = res.ok;
  } catch {
    reachable = false;
  }
  return reachable;
}

type OllamaTagEntry = {
  name?: string;
  size?: number;
  details?: {
    parameter_size?: string;
    quantization_level?: string;
  };
};

/** Locally-pulled models with disk/parameter metadata from Ollama's `/api/tags`. */
export async function listOllamaModelDetails(): Promise<OllamaModelDetail[]> {
  if (!config.ollamaUrl) return [];
  try {
    const res = await fetch(`${config.ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) {
      reachable = false;
      return [];
    }
    reachable = true;
    const data = (await res.json()) as { models?: OllamaTagEntry[] };
    return (data.models ?? [])
      .filter((m): m is OllamaTagEntry & { name: string } => typeof m.name === 'string' && !!m.name)
      .map((m) => ({
        name: m.name,
        ...(typeof m.size === 'number' && Number.isFinite(m.size) ? { sizeBytes: m.size } : {}),
        ...(m.details?.parameter_size ? { parameterSize: m.details.parameter_size } : {}),
        ...(m.details?.quantization_level ? { quantizationLevel: m.details.quantization_level } : {}),
      }));
  } catch {
    reachable = false;
    return [];
  }
}

/** The locally-pulled model names (for the chat's backend dropdown). [] if down. */
export async function listOllamaModels(): Promise<string[]> {
  return (await listOllamaModelDetails()).map((m) => m.name);
}

let gpuVramPromise: Promise<number | undefined> | null = null;

/** Cached total GPU VRAM in bytes from `nvidia-smi`, or undefined when unavailable. */
export function detectGpuVramBytes(): Promise<number | undefined> {
  if (!gpuVramPromise) {
    gpuVramPromise = new Promise((resolve) => {
      execFile(
        'nvidia-smi',
        ['--query-gpu=memory.total', '--format=csv,noheader,nounits'],
        { timeout: 2500, windowsHide: true },
        (err, stdout) => {
          if (err || !stdout) {
            resolve(undefined);
            return;
          }
          const mibList = stdout
            .trim()
            .split(/\r?\n/)
            .map((line) => Number(line.trim()))
            .filter((n) => Number.isFinite(n) && n > 0);
          resolve(mibList.length ? Math.max(...mibList) * 1024 * 1024 : undefined);
        },
      );
    });
  }
  return gpuVramPromise;
}

/**
 * One chat completion. `json:true` asks Ollama to emit strict JSON (and nudges
 * the model via the system prompt). Returns the assistant text, or null on any
 * failure (connection refused when Ollama isn't running lands here).
 */
export async function ollamaChat(
  system: string,
  user: string,
  opts: {
    images?: string[];
    json?: boolean;
    model?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    temperature?: number;
    think?: boolean;
    numPredict?: number;
    numCtx?: number;
  } = {},
): Promise<string | null> {
  const model = opts.model?.trim() || config.ollamaModel;
  if (!config.ollamaUrl || !model) return null;
  // A generous safety timeout (default 2 min) combined with the caller's cancel
  // signal — so a slow local model isn't cut off, but a "Stop" still works.
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 120_000);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  try {
    const res = await fetch(`${config.ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        stream: false,
        ...(opts.think !== undefined ? {think:opts.think} : {}),
        ...(opts.json ? { format: 'json' } : {}),
        options: {
          temperature: opts.temperature ?? (opts.json ? 0 : 0.2),
          // Enlarge the context window so the grounding excerpts aren't truncated
          // (a too-small window is a top cause of "hallucinated" rules).
          num_ctx: opts.numCtx ?? config.ollamaNumCtx,
          ...(opts.numPredict !== undefined ? {num_predict:opts.numPredict} : {}),
        },
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user, ...(opts.images?.length ? {images:opts.images} : {}) },
        ],
      }),
      signal,
    });
    if (!res.ok) {
      console.warn(`  [ollama] HTTP ${res.status} from ${model}`);
      reachable = false;
      return null;
    }
    reachable = true; // a successful call confirms it's up
    const data = (await res.json()) as { message?: { content?: string } };
    const text = data.message?.content?.trim();
    return text || null;
  } catch (err) {
    console.warn('  [ollama] request failed:', (err as Error).message);
    reachable = false;
    return null;
  }
}
