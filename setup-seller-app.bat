@echo off
rem One-click setup of "Nexra Connect for Sellers" (lets any seller's Shopify store connect).
rem Before running: create the app in the Shopify Partner Dashboard and copy its Client ID and Client secret.
setlocal
cd /d "%~dp0"

if not exist shopify.app.sellers.toml (
  echo shopify.app.sellers.toml not found. Run this file from inside the nexra-connect folder.
  goto fail
)

echo.
echo === 1/4  Installing tools ===
call npm install || goto fail

echo.
set /p CID=Paste the seller app Client ID and press Enter:
if "%CID%"=="" goto fail

echo.
echo === 2/4  Saving Client ID in shopify.app.sellers.toml ===
powershell -NoProfile -Command "(Get-Content shopify.app.sellers.toml) -replace '^client_id = \".*\"$', 'client_id = \"%CID%\"' | Set-Content shopify.app.sellers.toml" || goto fail

echo.
echo === 3/4  Uploading app settings to Shopify (log in with your Partner account) ===
call npx @shopify/cli@latest app deploy --config sellers || goto fail

echo.
echo === 4/4  Saving keys on the Cloudflare worker (log in with your Cloudflare account) ===
call npx wrangler login || goto fail
echo %CID%| npx wrangler secret put SELLER_API_KEY || goto fail
echo Paste the seller app Client SECRET when asked:
call npx wrangler secret put SELLER_API_SECRET || goto fail

echo.
echo Done. Last step: Partner Dashboard - your seller app - Distribution - choose Public distribution and submit for review.
pause
exit /b 0

:fail
echo.
echo Setup stopped. Copy the messages above and send them to Claude.
pause
exit /b 1
