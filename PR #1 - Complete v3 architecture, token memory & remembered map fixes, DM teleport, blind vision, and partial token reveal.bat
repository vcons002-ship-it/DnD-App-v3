@echo off
REM ============================================================
REM   Test launcher for PR #1 - Complete v3 architecture, token memory and remembered map fixes, DM teleport, blind vision, and partial token reveal
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=1"
set "PR_BRANCH=feat/v3-complete-and-partial-token-reveal"
set "PR_TITLE=Complete v3 architecture, token memory and remembered map fixes, DM teleport, blind vision, and partial token reveal"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
