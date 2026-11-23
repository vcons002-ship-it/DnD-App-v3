@echo off
REM ============================================================
REM   Test launcher for PR #48 - feattether: bound distance pill sizing, keep on tether, and depth-mask behind tokens
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=48"
set "PR_BRANCH=feat/clean-tether-distance-pill"
set "PR_TITLE=feattether: bound distance pill sizing, keep on tether, and depth-mask behind tokens"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
