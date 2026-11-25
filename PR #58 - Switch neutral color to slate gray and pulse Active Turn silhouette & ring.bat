@echo off
REM ============================================================
REM   Test launcher for PR #58 - Switch neutral color to slate gray and pulse Active Turn silhouette and ring
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=58"
set "PR_BRANCH=feat/slate-neutral-and-turn-pulse"
set "PR_TITLE=Switch neutral color to slate gray and pulse Active Turn silhouette and ring"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
