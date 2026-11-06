@echo off
REM ============================================================
REM   Test launcher for PR #18 - Include 2D/3D token selection in hardware benchmark with 20-25 FPS full-3D target
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=18"
set "PR_BRANCH=feat/benchmark-token-3d-2d-selection"
set "PR_TITLE=Include 2D/3D token selection in hardware benchmark with 20-25 FPS full-3D target"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
