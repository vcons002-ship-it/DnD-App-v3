@echo off
REM ============================================================
REM   Test launcher for PR #56 - Polish 45° crowd labels, fix edge-to-edge distance, and remove label ellipses
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=56"
set "PR_BRANCH=feat/hud-polish-and-edge-distance"
set "PR_TITLE=Polish 45° crowd labels, fix edge-to-edge distance, and remove label ellipses"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
