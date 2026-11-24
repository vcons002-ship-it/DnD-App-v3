@echo off
REM ============================================================
REM   Test launcher for PR #53 - feat: overhaul map feature editor, door/light tools, and connection stability
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=53"
set "PR_BRANCH=feat/map-feature-editor-overhaul"
set "PR_TITLE=feat: overhaul map feature editor, door/light tools, and connection stability"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
