@echo off
REM ============================================================
REM   Test launcher for PR #38 - Show affinity outlines when passing by temporarily visible units
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=38"
set "PR_BRANCH=fix/passing-affinity-outline"
set "PR_TITLE=Show affinity outlines when passing by temporarily visible units"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
