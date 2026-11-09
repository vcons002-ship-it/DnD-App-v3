@echo off
REM ============================================================
REM   Test launcher for PR #23 - Add Sorcerous-Burst-style spark and arrow animation to spell ray targeting
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=23"
set "PR_BRANCH=feat/spell-ray-arrow-animation"
set "PR_TITLE=Add Sorcerous-Burst-style spark and arrow animation to spell ray targeting"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
