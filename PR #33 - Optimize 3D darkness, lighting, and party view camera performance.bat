@echo off
REM ============================================================
REM   Test launcher for PR #33 - Optimize 3D darkness, lighting, and party view camera performance
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=33"
set "PR_BRANCH=perf/3d-darkness-party-camera"
set "PR_TITLE=Optimize 3D darkness, lighting, and party view camera performance"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
