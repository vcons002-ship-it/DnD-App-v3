@echo off
REM ============================================================
REM   Test launcher for PR #54 - feat: auto-start local Hunyuan 3D and ComfyUI workers and resolve Windows service paths
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=54"
set "PR_BRANCH=feat/auto-start-3d-workers"
set "PR_TITLE=feat: auto-start local Hunyuan 3D and ComfyUI workers and resolve Windows service paths"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
