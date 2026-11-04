@echo off
REM ============================================================
REM   Test launcher for PR #12 - Fix legacy pointers, death save prompts/markers, and spell UI cleanup
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=12"
set "PR_BRANCH=fix/legacy-pointers-death-saves-spells"
set "PR_TITLE=Fix legacy pointers, death save prompts/markers, and spell UI cleanup"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
