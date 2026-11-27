@echo off
REM ============================================================
REM   Test launcher for PR #60 - Enable multi-tier LOD switching for Druk
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=60"
set "PR_BRANCH=feat/enable-druk-multi-tier-lod"
set "PR_TITLE=Enable multi-tier LOD switching for Druk"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
