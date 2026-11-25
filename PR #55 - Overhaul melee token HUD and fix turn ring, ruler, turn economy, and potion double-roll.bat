@echo off
REM ============================================================
REM   Test launcher for PR #55 - Overhaul melee token HUD and fix turn ring, ruler, turn economy, and potion double-roll
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=55"
set "PR_BRANCH=feat/combat-hud-and-roll-fixes"
set "PR_TITLE=Overhaul melee token HUD and fix turn ring, ruler, turn economy, and potion double-roll"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
