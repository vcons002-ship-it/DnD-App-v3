@echo off
REM ============================================================
REM   Test launcher for PR #28 - Default Ollama to qwen3.5:9b and add heavy-model VRAM overload warnings
REM
REM   Double-click to spin up this PR's branch in an isolated folder/port
REM   for testing. Your main install (run by start.bat) is untouched.
REM   Auto-removes itself + its test folder once the PR is merged/closed.
REM ============================================================
set "PR_NUMBER=28"
set "PR_BRANCH=feat/ollama-vram-warnings-and-default"
set "PR_TITLE=Default Ollama to qwen3.5:9b and add heavy-model VRAM overload warnings"
set "MAIN_DIR=%~dp0"
call "%~dp0tools\pr-test-runner.bat"
