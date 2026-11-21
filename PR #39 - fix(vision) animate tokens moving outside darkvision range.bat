@echo off
REM ============================================================
REM   Test launcher for PR #39 - fixvision: animate tokens moving outside darkvision range
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=39"
set "PR_BRANCH=fix/darkvision-departing-motion"
set "PR_TITLE=fixvision: animate tokens moving outside darkvision range"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
