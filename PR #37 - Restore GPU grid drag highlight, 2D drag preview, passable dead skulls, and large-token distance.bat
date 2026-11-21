@echo off
REM ============================================================
REM   Test launcher for PR #37 - Restore GPU grid drag highlight, 2D drag preview, passable dead skulls, and large-token distance
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=37"
set "PR_BRANCH=fix/grid-drag-2d-preview-skulls-large-distance"
set "PR_TITLE=Restore GPU grid drag highlight, 2D drag preview, passable dead skulls, and large-token distance"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
