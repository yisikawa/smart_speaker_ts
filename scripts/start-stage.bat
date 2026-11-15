@echo off
rem サーバーを別ウィンドウで起動し、Edge のアプリ窓でステージを開く
start "sumika-server" cmd /c "npm start"
timeout /t 6 /nobreak > nul
set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
start "" "%EDGE%" --app="http://localhost:3000/?mode=stage&role=display" --window-size=960,720
