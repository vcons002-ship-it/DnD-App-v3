@echo off
REM ============================================================
REM   Test launcher for PR #34 - Optimize 3D camera performance with GPU floor, packed lighting textures, and mesh batching
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=34"
set "PR_BRANCH=perf/3d-gpu-floor-and-draw-batching"
set "PR_TITLE=Optimize 3D camera performance with GPU floor, packed lighting textures, and mesh batching"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
