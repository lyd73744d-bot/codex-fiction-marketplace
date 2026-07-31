@echo off
setlocal

set "PLUGIN_ROOT=%~dp0.."
set "NODE_EXE="

if defined FICTION_DIRECTOR_NODE if exist "%FICTION_DIRECTOR_NODE%" set "NODE_EXE=%FICTION_DIRECTOR_NODE%"

if not defined NODE_EXE if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" (
  set "NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)

if not defined NODE_EXE (
  for /d %%R in ("%USERPROFILE%\.cache\codex-runtimes\*") do (
    if exist "%%~fR\dependencies\node\bin\node.exe" set "NODE_EXE=%%~fR\dependencies\node\bin\node.exe"
  )
)

if not defined NODE_EXE (
  for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%~fN"
)

if not defined NODE_EXE (
  >&2 echo [longform-fiction-director] Node.js was not found. Reinstall the plugin from Codex.
  exit /b 9009
)

"%NODE_EXE%" "%PLUGIN_ROOT%\server\mcp-server.js"
exit /b %ERRORLEVEL%
