@echo off
REM ============================================================
REM   Test launcher for PR #4 - featvision: render targetable partial token names above vision mask and optimize visibility
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=4"
set "PR_BRANCH=feat/v3-perf-and-partial-token-name"
set "PR_TITLE=featvision: render targetable partial token names above vision mask and optimize visibility"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
