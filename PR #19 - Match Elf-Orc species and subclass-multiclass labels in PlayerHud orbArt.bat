@echo off
REM ============================================================
REM   Test launcher for PR #19 - Match Elf/Orc species and subclass/multiclass labels in PlayerHud orbArt
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=19"
set "PR_BRANCH=fix/ranger-orb-art-species-match"
set "PR_TITLE=Match Elf/Orc species and subclass/multiclass labels in PlayerHud orbArt"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
