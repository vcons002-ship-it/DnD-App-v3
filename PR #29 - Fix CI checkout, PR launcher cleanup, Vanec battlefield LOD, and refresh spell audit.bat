@echo off
REM ============================================================
REM   Test launcher for PR #29 - Fix CI checkout, PR launcher cleanup, Vanec battlefield LOD, and refresh spell audit
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=29"
set "PR_BRANCH=fix/ci-vanec-lod-and-spell-audit"
set "PR_TITLE=Fix CI checkout, PR launcher cleanup, Vanec battlefield LOD, and refresh spell audit"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
