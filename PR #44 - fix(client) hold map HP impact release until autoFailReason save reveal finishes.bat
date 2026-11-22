@echo off
REM ============================================================
REM   Test launcher for PR #44 - fixclient: hold map HP impact release until autoFailReason save reveal finishes
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=44"
set "PR_BRANCH=fix/autofail-save-reveal-hold"
set "PR_TITLE=fixclient: hold map HP impact release until autoFailReason save reveal finishes"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
