@echo off
setlocal
set "RUN=%USERPROFILE%\vectant-local-support-validation"
set "PROJECT=%USERPROFILE%\windows_local_validation_fixture\project"
set "VECTANT_TEST_DAEMON_READY_FILE=%RUN%\ready.txt"
"%RUN%\local-support-test-daemon.exe" "%PROJECT%" 43999 > "%RUN%\daemon.out" 2> "%RUN%\daemon.err"
