@echo off
REM ============================================================
REM   Test launcher for PR #41 - featdice: unified dice rule flows, interactive Savage Attacker tray, under-die rings and sculpted 3D trays
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=41"
set "PR_BRANCH=feat/unified-dice-flows-and-3d-trays"
set "PR_TITLE=featdice: unified dice rule flows, interactive Savage Attacker tray, under-die rings and sculpted 3D trays"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
