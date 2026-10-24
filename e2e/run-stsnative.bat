@echo off
rem stsnative headless launcher - STS native cordis plugin E2E rig.
rem Lives at an ASCII, space-free path on purpose: cmd /c mangles quoted paths with
rem spaces, and the previous round proved CJK paths can silently break hook spawning.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
set "DSH_DESKTOP_NODE_EXECUTABLE=C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe"
cd /d "C:\Users\<you>\AppData\Local\Temp\sts-native\ws"
"C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe" --expose-internals "C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
