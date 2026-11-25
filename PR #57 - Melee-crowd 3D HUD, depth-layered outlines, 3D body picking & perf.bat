@echo off
REM ============================================================
REM   Test launcher for PR #57 - Melee-crowd 3D HUD, depth-layered outlines, 3D body picking and perf
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=57"
set "PR_BRANCH=feat/melee-crowd-hud-and-3d-picking"
set "PR_TITLE=Melee-crowd 3D HUD, depth-layered outlines, 3D body picking and perf"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
