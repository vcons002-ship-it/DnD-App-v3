import { describe, expect, it } from 'vitest';
import {
  parseLocalWorkerPort,
  resolveAssetBlender,
  resolveAssetPython,
  resolveHybridWorkerSpec,
} from './assets/hybridSupervisor.js';

describe('hybridSupervisor', () => {
  it('respects explicit ASSET_PYTHON and ASSET_BLENDER overrides and discovers host binaries', () => {
    expect(resolveAssetPython({ ASSET_PYTHON: 'C:/custom/python.exe' })).toBe('C:/custom/python.exe');
    expect(resolveAssetBlender({ ASSET_BLENDER: 'C:/custom/blender.exe' })).toBe('C:/custom/blender.exe');
    expect(resolveAssetPython({})).toBeTruthy();
    expect(resolveAssetBlender({})).toBeTruthy();
  });

  it('refuses auto-start during test runs, disabled flags, non-loopback hosts, and sentinel ports', () => {
    expect(parseLocalWorkerPort('http://127.0.0.1:42005', { VITEST: 'true' })).toBeNull();
    expect(parseLocalWorkerPort('http://127.0.0.1:42005', { HUNYUAN_AUTO_START: '0' })).toBeNull();
    expect(parseLocalWorkerPort('http://127.0.0.1:42005', { PLACEHOLDER_MODELS: '1' })).toBeNull();
    expect(parseLocalWorkerPort('http://127.0.0.1:1', {})).toBeNull();
    expect(parseLocalWorkerPort('http://shape', {})).toBeNull();
    expect(parseLocalWorkerPort('http://192.168.1.50:42005', {})).toBeNull();
    expect(parseLocalWorkerPort('http://127.0.0.1:42005', {})).toBe(42005);
    expect(parseLocalWorkerPort('http://localhost:42004', {})).toBe(42004);
  });

  it('returns null launch specs when nonexistent roots are supplied', () => {
    expect(resolveHybridWorkerSpec('shape', 42005, { HUNYUAN_SHAPE_ROOT: 'C:/nonexistent-hunyuan-root' })).toBeNull();
    expect(resolveHybridWorkerSpec('paint', 42004, { HUNYUAN_PAINT_ROOT: 'C:/nonexistent-hunyuan-root' })).toBeNull();
  });
});
