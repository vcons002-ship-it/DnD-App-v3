@echo off
REM ============================================================
REM   Test launcher for PR #22 - Add interactive spell ray/missile targeting, tagged group rolls, and combat UI polish
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=22"
set "PR_BRANCH=feat/spell-ray-targeting-and-ui"
set "PR_TITLE=Add interactive spell ray/missile targeting, tagged group rolls, and combat UI polish"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
