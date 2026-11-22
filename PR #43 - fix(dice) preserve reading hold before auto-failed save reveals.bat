@echo off
REM ============================================================
REM   Test launcher for PR #43 - fixdice: preserve reading hold before auto-failed save reveals
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=43"
set "PR_BRANCH=fix/pushing-attack-autofail-tray-hold"
set "PR_TITLE=fixdice: preserve reading hold before auto-failed save reveals"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
