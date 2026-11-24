@echo off
REM ============================================================
REM   Test launcher for PR #50 - featvision: per-creature darkvision distances
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=50"
set "PR_BRANCH=feat/per-creature-darkvision"
set "PR_TITLE=featvision: per-creature darkvision distances"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
