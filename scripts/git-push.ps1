# PowerShell script to commit and push arcana-proxy changes
cd L:\PROJECTS\arcana-proxy
Write-Host "=== Git Status ==="
git status --short
Write-Host "=== Staging files ==="
git add src/free-routing.ts src/index.ts
if ($LASTEXITCODE -ne 0) { Write-Host "STAGE FAILED"; exit 1 }
Write-Host "=== Committing ==="
git commit -m "feat: hybrid load-sensing scheduler + per-user effort score tracking [bump]"
if ($LASTEXITCODE -ne 0) { Write-Host "COMMIT FAILED (maybe nothing to commit)"; exit 1 }
Write-Host "=== Pushing ==="
git push origin master
if ($LASTEXITCODE -ne 0) { Write-Host "PUSH FAILED"; exit 1 }
Write-Host "DONE"
