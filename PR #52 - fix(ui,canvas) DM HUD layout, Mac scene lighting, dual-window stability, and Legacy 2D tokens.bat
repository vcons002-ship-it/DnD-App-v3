@echo off
REM ============================================================
REM   Test launcher for PR #52 - fixui,canvas: DM HUD layout, Mac scene lighting, dual-window stability, and Legacy 2D tokens
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=52"
set "PR_BRANCH=fix/dm-hud-mac-lighting-legacy-tokens"
set "PR_TITLE=fixui,canvas: DM HUD layout, Mac scene lighting, dual-window stability, and Legacy 2D tokens"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
