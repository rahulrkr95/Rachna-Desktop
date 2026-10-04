; --------------------------------------------------------------------------
; Rachna AI Studio - Setup.exe bootstrapper
;
;   Rachna AI Studio Setup.exe
;        |
;        +-- Check WebView2 Runtime         -> install if missing
;        +-- Check VC++ 2015-2022 x64 Redist -> install if missing
;        +-- Run Rachna AI Studio.msi        (msiexec /i)
;
; This installer is a thin bootstrapper. It never registers itself in
; Add/Remove Programs and has no persistent state of its own - the
; underlying MSI is the single source of truth for install/upgrade/repair/
; uninstall (it already registers its own Add/Remove Programs entry).
; Once msiexec succeeds, Setup.exe's job is done. Because of that there is
; deliberately no uninstall section here: there's nothing for it to undo.
;
; The prerequisite check-and-install logic is NOT duplicated here - it
; lives in one place, ..\prereqs\install-prereqs.ps1, which this script
; just shells out to. That's the same script the MSI's own WiX custom
; action (windows\fragments\prereqs.wxs) calls as a defense-in-depth
; fallback for direct-MSI deployments (SCCM/Intune/etc. that skip this
; bootstrapper entirely). Running it twice back to back is harmless: the
; script checks both prerequisites up front and returns immediately,
; without even showing its progress window, if both are already present.
;
; ---------------------------------------------------------------------
; Build-time inputs (pass on the makensis command line with /D):
;
;   MSI_PATH     (required) full path to the built .msi to embed
;   APP_VERSION  (optional) e.g. 1.0.x - used for the exe's version info
;   OUT_FILE     (optional) output path for the built Setup.exe
;
; Example:
;   makensis ^
;     /DMSI_PATH="src-tauri\target\release\bundle\msi\Rachna AI Studio_1.0.x_x64_en-US.msi" ^
;     /DAPP_VERSION=1.0.x ^
;     /DOUT_FILE="dist\Rachna AI Studio Setup.exe" ^
;     src-tauri\windows\bootstrapper\setup.nsi
; --------------------------------------------------------------------------

!ifndef MSI_PATH
  !error "MSI_PATH must be defined, e.g. /DMSI_PATH=path\to\app.msi"
!endif

!ifndef APP_VERSION
  !define APP_VERSION "0.0.0.0"
!endif

!ifndef OUT_FILE
  !define OUT_FILE "Rachna AI Studio Setup.exe"
!endif

!define PRODUCT_NAME  "Rachna AI Studio"
!define COMPANY_NAME  "Rachna AI"
!define PREREQ_SCRIPT "..\prereqs\install-prereqs.ps1"
!define ICON_PATH     "..\..\icons\icon.ico"

!include "MUI2.nsh"
!include "LogicLib.nsh"

Name "${PRODUCT_NAME}"
OutFile "${OUT_FILE}"
Unicode true
RequestExecutionLevel admin
InstallDir "$PROGRAMFILES64\${PRODUCT_NAME}"
ShowInstDetails show
SetCompressor /SOLID lzma

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey "ProductName"     "${PRODUCT_NAME} Setup"
VIAddVersionKey "CompanyName"     "${COMPANY_NAME}"
VIAddVersionKey "FileVersion"     "${APP_VERSION}"
VIAddVersionKey "FileDescription" "${PRODUCT_NAME} Installer"
VIAddVersionKey "LegalCopyright"  "${COMPANY_NAME}"

!define MUI_ICON   "${ICON_PATH}"
!define MUI_UNICON "${ICON_PATH}"
!define MUI_ABORTWARNING

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

; ---------------------------------------------------------------------
; $PLUGINSDIR is a per-run temp folder NSIS deletes automatically once
; setup finishes - it's scratch space, not the real install directory
; (the MSI decides where the app itself actually lands).
; ---------------------------------------------------------------------
Function .onInit
  InitPluginsDir
FunctionEnd

; "-" prefix = hidden/required section: always runs, never shown as an
; optional component to the user. Order of sections below is the
; execution order.

Section "-Prerequisites" SecPrereq
  SetOutPath "$PLUGINSDIR"
  File "/oname=install-prereqs.ps1" "${PREREQ_SCRIPT}"

  DetailPrint "Checking required components (WebView2 Runtime, VC++ Redistributable)..."
  nsExec::ExecToLog '"$WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\install-prereqs.ps1"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP "Setup cannot continue because a required component could not be installed.$\r$\n$\r$\nDetails were logged to: %TEMP%\RachnaAIStudio-Prereqs.log"
    Abort
  ${EndIf}
SectionEnd

Section "-InstallApp" SecApp
  SetOutPath "$PLUGINSDIR"
  File "/oname=RachnaAIStudio.msi" "${MSI_PATH}"

  DetailPrint "Installing ${PRODUCT_NAME}..."
  ${If} ${Silent}
    nsExec::ExecToLog 'msiexec /i "$PLUGINSDIR\RachnaAIStudio.msi" /qn /norestart'
  ${Else}
    nsExec::ExecToLog 'msiexec /i "$PLUGINSDIR\RachnaAIStudio.msi" /qb-! /norestart'
  ${EndIf}
  Pop $0

  ; 0 = success, 3010 = success but a reboot is required - both are fine.
  ${If} $0 != 0
  ${AndIf} $0 != 3010
    MessageBox MB_ICONSTOP "${PRODUCT_NAME} installation failed (msiexec exit code $0).$\r$\n$\r$\nCheck %TEMP% for MSI log files."
    Abort
  ${EndIf}
SectionEnd
