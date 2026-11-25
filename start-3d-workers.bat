@echo off
title DnD-App-v3 - Start 3D & AI Workers
cd /d "%~dp0"

for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"`) do set "PATH=%%P"

echo Checking and starting local Hunyuan 3D shape (:42005), paint (:42004), and ComfyUI (:8188) workers...
echo (Workers keep 0 MB GPU VRAM while idle and only load models during generation.)
echo.

node --import tsx -e "import { ensureHybridWorker, ensureComfyServer } from './server/src/assets/hybridSupervisor.ts'; (async () => { const [s, p, c] = await Promise.all([ensureHybridWorker('shape', process.env.HUNYUAN_SHAPE_URL || 'http://127.0.0.1:42005', () => console.log('  Starting Hunyuan 2mv shape worker (:42005)...'), undefined, { detachedDaemon: true }), ensureHybridWorker('paint', process.env.HUNYUAN_PAINT_URL || 'http://127.0.0.1:42004', () => console.log('  Starting Hunyuan 2.1 PBR paint worker (:42004)...'), undefined, { detachedDaemon: true }), ensureComfyServer({ detachedDaemon: true })]); console.log(''); console.log('  Shape worker (:42005):', s ? 'ONLINE' : 'NOT FOUND'); console.log('  Paint worker (:42004):', p ? 'ONLINE' : 'NOT FOUND'); console.log('  ComfyUI      (:8188): ', c ? 'ONLINE' : 'NOT FOUND / OPTIONAL'); process.exit(s && p ? 0 : 1); })();"
pause
