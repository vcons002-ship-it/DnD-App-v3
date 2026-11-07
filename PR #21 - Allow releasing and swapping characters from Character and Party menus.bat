@echo off
REM ============================================================
REM   Test launcher for PR #21 - Allow releasing and swapping characters from Character and Party menus
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=21"
set "PR_BRANCH=feat/character-release-swap"
set "PR_TITLE=Allow releasing and swapping characters from Character and Party menus"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
