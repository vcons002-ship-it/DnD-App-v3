@echo off
REM ============================================================
REM   Test launcher for PR #46 - featmotion: increase token move speed to 30 ft/sec
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=46"
set "PR_BRANCH=feat/tune-token-move-speed-30fps"
set "PR_TITLE=featmotion: increase token move speed to 30 ft/sec"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
