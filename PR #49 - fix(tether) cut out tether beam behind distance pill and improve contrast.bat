@echo off
REM ============================================================
REM   Test launcher for PR #49 - fixtether: cut out tether beam behind distance pill and improve contrast
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=49"
set "PR_BRANCH=fix/tether-pill-beam-cutout"
set "PR_TITLE=fixtether: cut out tether beam behind distance pill and improve contrast"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
