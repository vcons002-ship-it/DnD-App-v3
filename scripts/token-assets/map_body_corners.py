"""Match Hunyuan 2.1 exported triangle corners back to exact source vertex indices."""
import json
from pathlib import Path
import sys
import numpy as np
from scipy.spatial import cKDTree


def main():
    if len(sys.argv) != 2:
        raise SystemExit('Usage: python map_body_corners.py <work_dir>')
    work_dir = Path(sys.argv[1]).resolve()
    src_pos = np.fromfile(work_dir / 'source-pos.f32', dtype=np.float32).reshape(-1, 3)
    src_idx = np.fromfile(work_dir / 'source-index.u32', dtype=np.uint32).reshape(-1, 3)
    paint_pos = np.fromfile(work_dir / 'paint-pos.f32', dtype=np.float32).reshape(-1, 3)
    paint_idx = np.fromfile(work_dir / 'paint-index.u32', dtype=np.uint32).reshape(-1, 3)

    if len(paint_idx) != len(src_idx):
        raise AssertionError(f'Triangle count mismatch: painted={len(paint_idx)} vs source={len(src_idx)}')

    _, match = cKDTree(src_pos[src_idx].mean(axis=1)).query(paint_pos[paint_idx].mean(axis=1))
    delta = np.linalg.norm(paint_pos[paint_idx][:, :, None, :] - src_pos[src_idx[match]][:, None, :, :], axis=3)
    max_error = float(delta.min(axis=2).max())
    if max_error >= 0.000002:
        raise AssertionError(f'Corner position error exceeded tolerance: {max_error}')

    corner = src_idx[match][np.arange(len(paint_idx))[:, None], delta.argmin(axis=2)].astype(np.uint32)
    corner.tofile(work_dir / 'source-corners.u32')
    report = {
        'maxPositionError': max_error,
        'triangles': int(len(paint_idx)),
        'mappedCorners': int(corner.size),
    }
    (work_dir / 'normal-mapping.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(f'[map_body_corners] triangles={len(paint_idx)} maxPositionError={max_error:.3e}', flush=True)


if __name__ == '__main__':
    main()
