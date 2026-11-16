@echo off
setlocal EnableExtensions
title Pocket Server
cd /d "%~dp0"

rem ---------------------------------------------------------------
rem  RYN intro. Skip it with:  Pocket Server.bat --fast
rem  or by setting POCKET_SERVER_NO_ANIM=1
rem ---------------------------------------------------------------
if /i "%~1"=="--fast" goto boot
if /i "%~1"=="--no-anim" goto boot
if defined POCKET_SERVER_NO_ANIM goto boot

color 0A
cls
echo.
echo            ####    #   #   #   #
echo            #   #    # #    ##  #
timeout /t 1 >nul 2>&1
echo            ####      #     # # #
echo            # #       #     #  ##
timeout /t 1 >nul 2>&1
echo            #  #      #     #   #
timeout /t 1 >nul 2>&1
echo.
echo               R Y N   .   P O C K E T   S E R V E R
echo               your phone is the server - now on a PC
timeout /t 1 >nul 2>&1
color 07

:boot
cls
echo.
echo   Pocket Server for Windows
echo   ------------------------------------------------------------
echo.

set "NODE=node.exe"
if exist "%~dp0node.exe" goto haveNode
set "NODE=node"
where node >nul 2>nul
if errorlevel 1 goto noNode

:haveNode
if not exist "%~dp0windows\launch.js" goto broken

echo   starting PocketBase, the panel and the supervisor ...
echo   close this window (or press Ctrl+C) to stop everything.
echo.

"%NODE%" "%~dp0windows\launch.js" %*

echo.
echo   Server stopped.
if not defined POCKET_SERVER_NO_PAUSE pause
exit /b 0

:noNode
echo   Node.js was not found.
echo.
echo   This folder should contain node.exe next to this file.
echo   Download the ready-made zip from the Releases page, or install
echo   Node.js 22 or newer from https://nodejs.org and run this file again.
echo.
pause
exit /b 1

:broken
echo   windows\launch.js is missing - the folder was copied incompletely.
echo   Download the zip again from the Releases page.
echo.
pause
exit /b 1
