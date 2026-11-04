@echo off
REM ============================================================
REM   Test launcher for PR #11 - fixvision: eliminate mobile player-view zoom artifacts and preserve remembered tokens until targetable
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=11"
set "PR_BRANCH=fix/mobile-legacy-zoom-and-remembered-tokens"
set "PR_TITLE=fixvision: eliminate mobile player-view zoom artifacts and preserve remembered tokens until targetable"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
