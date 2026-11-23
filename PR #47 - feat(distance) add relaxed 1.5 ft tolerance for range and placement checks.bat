@echo off
REM ============================================================
REM   Test launcher for PR #47 - featdistance: add relaxed 1.5 ft tolerance for range and placement checks
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=47"
set "PR_BRANCH=feat/relaxed-distance-tolerance"
set "PR_TITLE=featdistance: add relaxed 1.5 ft tolerance for range and placement checks"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
