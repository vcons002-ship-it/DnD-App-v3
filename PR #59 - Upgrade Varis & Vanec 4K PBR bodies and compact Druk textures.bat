@echo off
REM ============================================================
REM   Test launcher for PR #59 - Upgrade Varis and Vanec 4K PBR bodies and compact Druk textures
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=59"
set "PR_BRANCH=feat/character-pbr-and-druk-compression"
set "PR_TITLE=Upgrade Varis and Vanec 4K PBR bodies and compact Druk textures"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
