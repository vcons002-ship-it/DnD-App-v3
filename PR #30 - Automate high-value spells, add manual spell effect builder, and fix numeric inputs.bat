@echo off
REM ============================================================
REM   Test launcher for PR #30 - Automate high-value spells, add manual spell effect builder, and fix numeric inputs
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=30"
set "PR_BRANCH=feat/high-value-spell-automation"
set "PR_TITLE=Automate high-value spells, add manual spell effect builder, and fix numeric inputs"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
