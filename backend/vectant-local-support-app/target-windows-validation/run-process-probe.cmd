@echo off
cd /d "%USERPROFILE%\windows_local_validation_fixture\project"
workspace_probe.exe -t 127.0.0.1
