@echo off
REM ============================================================
REM   Test launcher for PR #20 - Use multiclassClassSummary in PlayerHud orbArt to pass client typecheck
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=20"
set "PR_BRANCH=fix/player-hud-multiclass-typecheck"
set "PR_TITLE=Use multiclassClassSummary in PlayerHud orbArt to pass client typecheck"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
