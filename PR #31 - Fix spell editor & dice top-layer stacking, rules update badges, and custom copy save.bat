@echo off
REM ============================================================
REM   Test launcher for PR #31 - Fix spell editor and dice top-layer stacking, rules update badges, and custom copy save
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=31"
set "PR_BRANCH=fix/spell-editor-layering-and-rules-update"
set "PR_TITLE=Fix spell editor and dice top-layer stacking, rules update badges, and custom copy save"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
