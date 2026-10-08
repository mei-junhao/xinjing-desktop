!define APP_NAME "心镜 XinJing"
!define APP_VERSION "1.0.0"
!define APP_PUBLISHER "Mei"
!define APP_ID "com.xinjing.desktop"
!define APP_EXEC "xinjing-tauri.exe"
!define INSTALL_DIR "$LOCALAPPDATA\XinJing"
!define MUI_LANGDLL_REGISTRY_ROOT "HKCU"
!define MUI_LANGDLL_REGISTRY_KEY "Software\XinJing"
!define MUI_LANGDLL_REGISTRY_VALUENAME "Installer Language"

!include "MUI2.nsh"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_WELCOME
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "SimplifiedChinese"
!insertmacro MUI_LANGUAGE "English"

Name "${APP_NAME}"
OutFile "xinjing-tauri-${APP_VERSION}.exe"
InstallDir "${INSTALL_DIR}"
InstallDirRegKey HKCU "Software\${APP_NAME}" "InstallDir"
RequestExecutionLevel user

Section "MainSection" SEC01
  SetOutPath "$INSTDIR"
  File /r "..\..\app\*"
  File "..\xinjing-tauri.exe"
  
  WriteRegStr HKCU "Software\${APP_NAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\${APP_NAME}" "Version" "${APP_VERSION}"
  
  CreateShortcut "$SMPROGRAMS\${APP_NAME}.lnk" "$INSTDIR\${APP_EXEC}"
  CreateShortcut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXEC}"
SectionEnd

Section "Uninstall"
  Delete "$INSTDIR\${APP_EXEC}"
  RMDir /r "$INSTDIR"
  
  Delete "$SMPROGRAMS\${APP_NAME}.lnk"
  Delete "$DESKTOP\${APP_NAME}.lnk"
  
  DeleteRegKey HKCU "Software\${APP_NAME}"
SectionEnd

!macro MUI_STARTMENU_WRITE_BEGIN Application
  SetShellVarContext current
!macroend

!macro MUI_STARTMENU_WRITE_END
!macroend