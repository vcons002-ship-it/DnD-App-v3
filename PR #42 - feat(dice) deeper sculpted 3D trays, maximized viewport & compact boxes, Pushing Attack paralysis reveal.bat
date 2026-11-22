@echo off
REM ============================================================
REM   Test launcher for PR #42 - featdice: deeper sculpted 3D trays, maximized viewport and compact boxes, Pushing Attack paralysis reveal
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=42"
set "PR_BRANCH=feat/dice-tray-depth-sizing-and-layout"
set "PR_TITLE=featdice: deeper sculpted 3D trays, maximized viewport and compact boxes, Pushing Attack paralysis reveal"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
