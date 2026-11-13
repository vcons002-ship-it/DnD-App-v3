/** Runtime VRAM assessment and safe default selection for local Ollama models. */
export const DEFAULT_OLLAMA_MODEL = 'qwen3.5:9b';

export type OllamaModelDetail = {
  name: string;
  sizeBytes?: number;
  parameterSize?: string;
  quantizationLevel?: string;
};

export type OllamaModelTier = 'ok' | 'heavy' | 'critical';

export type OllamaModelAssessment = {
  name: string;
  tier: OllamaModelTier;
  estimatedVramGb: number;
  systemVramGb: number;
  optionTag: string;
  headline: string;
  shortReason: string;
  detail: string;
};

const IMPLICIT_PARAMS_B: Array<[RegExp, number]> = [
  [/^qwen3\.8(?=$|:)/i, 27.3],
  [/^qwen3\.6(?=$|:)/i, 32],
  [/^llama3\.2(?=$|:)/i, 3.2],
  [/^gemma4(?=$|:latest$)/i, 12],
  [/^mixtral(?=$|:)/i, 47],
  [/^command-r-plus(?=$|:)/i, 104],
  [/^command-r(?=$|:)/i, 35],
];

function inferParamsB(name: string, detail?: OllamaModelDetail): number {
  const fromMeta = detail?.parameterSize?.match(/^(\d+(?:\.\d+)?)\s*B$/i);
  if (fromMeta) return Number(fromMeta[1]);
  const fromName = name.match(/(?:^|[:\-_])(\d+(?:\.\d+)?)b(?=$|[:\-_])/i);
  if (fromName) return Number(fromName[1]);
  for (const [pattern, sizeB] of IMPLICIT_PARAMS_B) {
    if (pattern.test(name)) return sizeB;
  }
  return 8;
}

/** Estimate total VRAM (model weights + 8k context KV cache overhead) in GiB. */
export function estimateOllamaVramGb(name: string, detail?: OllamaModelDetail): number {
  let weightGb: number;
  if (detail?.sizeBytes && detail.sizeBytes > 0) {
    weightGb = detail.sizeBytes / 1024 ** 3;
  } else {
    const paramsB = inferParamsB(name, detail);
    const quantText = `${detail?.quantizationLevel ?? ''} ${name}`;
    const gibPerParam = /(?:fp16|bf16|f16)/i.test(quantText)
      ? 2.0
      : /q8/i.test(quantText)
        ? 1.02
        : /q6/i.test(quantText)
          ? 0.78
          : /q5/i.test(quantText)
            ? 0.68
            : 0.61;
    weightGb = paramsB * gibPerParam;
  }
  const overheadGb = Math.max(1.0, Math.min(3.0, weightGb * 0.1 + 0.8));
  return Math.round((weightGb + overheadGb) * 10) / 10;
}

/** Classify an Ollama model against the host GPU VRAM budget (with game/VTT headroom). */
export function assessOllamaModel(
  name: string,
  opts?: { detail?: OllamaModelDetail; gpuVramBytes?: number },
): OllamaModelAssessment {
  const systemVramGb =
    opts?.gpuVramBytes && opts.gpuVramBytes > 0
      ? Math.round((opts.gpuVramBytes / 1024 ** 3) * 10) / 10
      : 32;
  const estimatedVramGb = estimateOllamaVramGb(name, opts?.detail);
  const vramLabel = `~${estimatedVramGb.toFixed(estimatedVramGb >= 10 ? 0 : 1)} GB`;

  if (estimatedVramGb >= systemVramGb * 0.78) {
    return {
      name,
      tier: 'critical',
      estimatedVramGb,
      systemVramGb,
      optionTag: `${vramLabel} — OVERLOAD RISK`,
      headline: `Critical GPU memory overload risk (${vramLabel} VRAM)`,
      shortReason:
        estimatedVramGb > systemVramGb
          ? `Exceeds your ${systemVramGb} GB GPU VRAM — will spill into system RAM and stall games and the tabletop.`
          : `Uses nearly all ${systemVramGb} GB GPU VRAM — will overflow into system RAM if a game, 3D tabletop, or ComfyUI is active.`,
      detail: `"${name}" requires roughly ${vramLabel} of VRAM (including 8k context cache) on a ${systemVramGb} GB GPU budget. Running it alongside a game, the 3D VTT canvas, or ComfyUI will exhaust VRAM, spill into system RAM, and cause severe freezes, frame drops, or generation timeouts.`,
    };
  }

  if (estimatedVramGb >= Math.min(14, systemVramGb * 0.45)) {
    return {
      name,
      tier: 'heavy',
      estimatedVramGb,
      systemVramGb,
      optionTag: `${vramLabel} — HEAVY`,
      headline: `Heavy local model (${vramLabel} VRAM)`,
      shortReason:
        'High VRAM load — can cause stutter, FPS drops, or ComfyUI OOMs while gaming or hosting.',
      detail: `"${name}" uses roughly ${vramLabel} of VRAM (over half of a ${systemVramGb} GB GPU). If you are also running a game on your GPU or generating art in ComfyUI, loading this model can push total VRAM past capacity and slow down the whole system.`,
    };
  }

  return {
    name,
    tier: 'ok',
    estimatedVramGb,
    systemVramGb,
    optionTag: vramLabel,
    headline: `Fits comfortably (${vramLabel} VRAM)`,
    shortReason: '',
    detail: '',
  };
}

/** Pick the best lightweight local model when auto-selecting or recovering from a heavy pick. */
export function pickRecommendedSafeModel(
  models: string[],
  details?: OllamaModelDetail[],
  gpuVramBytes?: number,
): string | null {
  const detailByName = new Map((details ?? []).map((d) => [d.name, d]));
  const safe = models.filter(
    (m) => assessOllamaModel(m, { detail: detailByName.get(m), gpuVramBytes }).tier === 'ok',
  );
  if (!safe.length) return null;
  if (safe.includes(DEFAULT_OLLAMA_MODEL)) return DEFAULT_OLLAMA_MODEL;
  return safe.find((m) => /^qwen/i.test(m)) ?? safe[0];
}
