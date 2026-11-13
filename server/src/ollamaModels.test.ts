import { describe, it, expect } from 'vitest';
import {
  assessOllamaModel,
  DEFAULT_OLLAMA_MODEL,
  pickRecommendedSafeModel,
  type OllamaModelDetail,
} from '../../shared/ollamaModels.js';

const GB = 1024 ** 3;
const GPU_32_GB = 32 * GB;

describe('Ollama model VRAM assessment', () => {
  it('classifies models using exact disk sizes and GPU VRAM budget', () => {
    const details: Record<string, OllamaModelDetail> = {
      'qwen3.5:9b': { name: 'qwen3.5:9b', sizeBytes: Math.round(6.14 * GB) },
      'gemma4:12b': { name: 'gemma4:12b', sizeBytes: Math.round(7.04 * GB) },
      'qwen3.8:latest': { name: 'qwen3.8:latest', sizeBytes: Math.round(16.52 * GB) },
      'gemma4:31b': { name: 'gemma4:31b', sizeBytes: Math.round(18.5 * GB) },
      'qwen3.8:27b-q8_0': { name: 'qwen3.8:27b-q8_0', sizeBytes: Math.round(27.92 * GB) },
      'llama3.3:70b': { name: 'llama3.3:70b', sizeBytes: Math.round(42.5 * GB) },
    };

    expect(assessOllamaModel('qwen3.5:9b', { detail: details['qwen3.5:9b'], gpuVramBytes: GPU_32_GB }).tier).toBe('ok');
    expect(assessOllamaModel('gemma4:12b', { detail: details['gemma4:12b'], gpuVramBytes: GPU_32_GB }).tier).toBe('ok');
    expect(assessOllamaModel('qwen3.8:latest', { detail: details['qwen3.8:latest'], gpuVramBytes: GPU_32_GB }).tier).toBe('heavy');
    expect(assessOllamaModel('gemma4:31b', { detail: details['gemma4:31b'], gpuVramBytes: GPU_32_GB }).tier).toBe('heavy');
    expect(assessOllamaModel('qwen3.8:27b-q8_0', { detail: details['qwen3.8:27b-q8_0'], gpuVramBytes: GPU_32_GB }).tier).toBe('critical');
    expect(assessOllamaModel('llama3.3:70b', { detail: details['llama3.3:70b'], gpuVramBytes: GPU_32_GB }).tier).toBe('critical');
  });

  it('classifies installed models accurately by name when server metadata is absent', () => {
    expect(assessOllamaModel('qwen3.8:27b-q8_0').tier).toBe('critical');
    expect(assessOllamaModel('qwen3.8:latest').tier).toBe('heavy');
    expect(assessOllamaModel('gemma4:31b').tier).toBe('heavy');
    expect(assessOllamaModel('gemma4:26b').tier).toBe('heavy');
    expect(assessOllamaModel('qwen3.5:9b').tier).toBe('ok');
    expect(assessOllamaModel('gemma4:12b').tier).toBe('ok');
    expect(assessOllamaModel('gemma4:latest').tier).toBe('ok');
    expect(assessOllamaModel('llama3.2:latest').tier).toBe('ok');
  });

  it('prefers the lightweight default qwen model over heavy models listed first', () => {
    const models = ['qwen3.8:27b-q8_0', 'qwen3.8:latest', 'gemma4:31b', 'qwen3.5:9b', 'llama3.2:latest'];
    expect(pickRecommendedSafeModel(models)).toBe(DEFAULT_OLLAMA_MODEL);
    expect(pickRecommendedSafeModel(['qwen3.8:27b-q8_0', 'qwen3.8:latest'])).toBeNull();
  });
});
