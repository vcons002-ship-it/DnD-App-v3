@echo off
REM ============================================================
REM   Test launcher for PR #51 - fixcanvas: Mac targeting lines, darkvision affinity, and DM inspect
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=51"
set "PR_BRANCH=fix/mac-tether-affinity-dm-inspect"
set "PR_TITLE=fixcanvas: Mac targeting lines, darkvision affinity, and DM inspect"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
