@echo off
REM ============================================================
REM   Test launcher for PR #27 - Unify and compact under-token name and HP HUD
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=27"
set "PR_BRANCH=feat/compact-consistent-token-hud"
set "PR_TITLE=Unify and compact under-token name and HP HUD"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
