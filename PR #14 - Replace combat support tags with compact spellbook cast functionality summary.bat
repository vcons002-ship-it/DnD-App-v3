@echo off
REM ============================================================
REM   Test launcher for PR #14 - Replace combat support tags with compact spellbook cast functionality summary
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=14"
set "PR_BRANCH=fix/spellbook-cast-summary"
set "PR_TITLE=Replace combat support tags with compact spellbook cast functionality summary"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
