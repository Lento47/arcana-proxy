@echo off
cd /d L:\PROJECTS\arcana-proxy
echo === Git Status ===
git status --short
echo === Staging files ===
git add src/free-routing.ts src/index.ts
if %ERRORLEVEL% neq 0 echo STAGE FAILED && exit /b 1
echo === Committing ===
git commit -m "feat: hybrid load-sensing scheduler + per-user effort score tracking [bump]"
if %ERRORLEVEL% neq 0 echo COMMIT FAILED && exit /b 1
echo === Pushing ===
git push origin master
if %ERRORLEVEL% neq 0 echo PUSH FAILED && exit /b 1
echo DONE
