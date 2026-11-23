; LightSSH installer (per-user, no admin rights needed)
; makensis /DVERSION=1.5.0 /DSRC=dist\LightSSH-win32-x64 /DOUT=dist\LightSSH-Setup-v1.5.0.exe installer.nsi
Unicode true
!include "MUI2.nsh"

!ifndef VERSION
  !define VERSION "0.0.0"
!endif
!ifndef SRC
  !define SRC "dist\LightSSH-win32-x64"
!endif
!ifndef OUT
  !define OUT "dist\LightSSH-Setup.exe"
!endif
!define APP "LightSSH"
!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\LightSSH"

Name "${APP} ${VERSION}"
OutFile "${OUT}"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
InstallDirRegKey HKCU "Software\${APP}" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
BrandingText "${APP} ${VERSION}"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${APP}"
VIAddVersionKey "FileDescription" "${APP} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName" "Candies Sven"
VIAddVersionKey "LegalCopyright" "Candies Sven"

!define MUI_ICON "build_icon.ico"
!define MUI_UNICON "build_icon.ico"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP}.exe"

!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

LangString RUNNING ${LANG_SIMPCHINESE} "LightSSH 正在运行，请先关闭它再继续。"
LangString RUNNING ${LANG_ENGLISH} "LightSSH is running. Please close it, then continue."

Function .onInit
  !insertmacro MUI_LANGDLL_DISPLAY
FunctionEnd

Section "Install"
  ; refuse to overwrite a running app
  retry:
  ClearErrors
  IfFileExists "$INSTDIR\${APP}.exe" 0 +4
    FileOpen $0 "$INSTDIR\${APP}.exe" a
    IfErrors 0 +2
      MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(RUNNING)" IDRETRY retry IDCANCEL abort
    FileClose $0
  Goto go
  abort:
  Abort
  go:

  SetOutPath "$INSTDIR"
  RMDir /r "$INSTDIR\resources"
  RMDir /r "$INSTDIR\locales"
  File /r "${SRC}\*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\${APP}.exe"
  CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\${APP}.exe"

  WriteRegStr HKCU "Software\${APP}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "${APP}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Candies Sven"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\${APP}.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  Delete "$SMPROGRAMS\${APP}.lnk"
  Delete "$DESKTOP\${APP}.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\${APP}"
  ; saved hosts and settings in %APPDATA%\LightSSH are kept on purpose
SectionEnd
