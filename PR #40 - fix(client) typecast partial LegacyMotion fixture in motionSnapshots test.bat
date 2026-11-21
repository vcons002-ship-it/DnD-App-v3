@echo off
REM ============================================================
REM   Test launcher for PR #40 - fixclient: typecast partial LegacyMotion fixture in motionSnapshots test
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=40"
set "PR_BRANCH=fix/motion-snapshots-test-typecheck"
set "PR_TITLE=fixclient: typecast partial LegacyMotion fixture in motionSnapshots test"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
