; 自定义「应用仍在运行」检测 —— 覆盖 electron-builder 默认 CHECK_APP_RUNNING
; 触发条件：更新/安装时心镜 XinJing 仍在运行。
; 目标：①给出清晰中文指引 ②提供「强制结束进程」按钮（taskkill /f /im /t 杀整棵树）
; 注意：本文件通过 package.json 的 build.nsis.include 注入，宏名必须为 customCheckAppRunning
;       才能被 allowOnlyOneInstallerInstance.nsh 的 !ifmacrodef 命中并整体替换默认逻辑。

!macro customCheckAppRunning
  ${if} ${isUpdated}
    # 更新模式：先给应用一点时间自行退出（自动更新时应用常常正在关闭）
    Sleep 1500
  ${endIf}

  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 != 0
    Goto xjAppNotRunning
  ${endIf}

  xjAppPrompt:
  MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
    "心镜 XinJing 仍在运行，更新无法继续。$\r$\n$\r$\n请选择一种方式：$\r$\n• 点击「重试」——由安装程序强制结束所有 xinjing.exe 进程；$\r$\n• 或打开任务管理器（Ctrl+Shift+Esc）手动结束 xinjing.exe，再点「重试」。$\r$\n$\r$\n结束后即可继续安装。" \
    /SD IDRETRY IDRETRY xjAppForceKill IDCANCEL xjAppQuit

  xjAppQuit:
  Quit

  xjAppForceKill:
  DetailPrint `正在强制结束 "${PRODUCT_NAME}" 进程...`
  ; /f 强制终止  /t 连带结束子进程（残留渲染进程）  /im 按映像名
  nsExec::Exec `taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /t`
  Pop $0
  Sleep 1500
  !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
  ${if} $R0 == 0
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION \
      "仍无法结束心镜 XinJing 进程，它可能以管理员身份运行。$\r$\n$\r$\n请在任务管理器（Ctrl+Shift+Esc）中结束所有 xinjing.exe，再点「重试」继续安装。" \
      /SD IDRETRY IDRETRY xjAppPrompt IDCANCEL xjAppQuit2
    xjAppQuit2:
    Quit
  ${else}
    Goto xjAppNotRunning
  ${endIf}

  xjAppNotRunning:
!macroend
