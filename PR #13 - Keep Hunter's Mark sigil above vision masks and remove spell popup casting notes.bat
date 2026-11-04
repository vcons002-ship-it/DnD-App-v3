@echo off
REM ============================================================
REM   Test launcher for PR #13 - Keep Hunter's Mark sigil above vision masks and remove spell popup casting notes
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=13"
set "PR_BRANCH=fix/hunters-mark-vision-and-spell-popup-text"
set "PR_TITLE=Keep Hunter's Mark sigil above vision masks and remove spell popup casting notes"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
