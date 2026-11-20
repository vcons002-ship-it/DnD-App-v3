@echo off
REM ============================================================
REM   Test launcher for PR #35 - Enable GPU floor with manual fog/2D tokens, fix mobile zoom/pan flicker, and fix View dropdown contrast
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=35"
set "PR_BRANCH=fix/gpu-floor-manual-fog-mobile-flicker-dropdown"
set "PR_TITLE=Enable GPU floor with manual fog/2D tokens, fix mobile zoom/pan flicker, and fix View dropdown contrast"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
