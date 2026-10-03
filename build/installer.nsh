; 自定义「应用仍在运行」检测 + 卸载旧文件失败自愈 —— 覆盖 electron-builder 默认 CHECK_APP_RUNNING
; 触发条件：更新/安装时心镜 XinJing 仍在运行，或存在会导致旧卸载器 Abort 的旧版本残留。
; 目标：①给出清晰中文指引 ②提供「强制结束进程」按钮（taskkill /f /im /t 杀整棵树）
;       ③进程确认退出后，主动清理旧安装目录 + 删除卸载注册表项，规避
;         "Failed to uninstall old application files.:2"（旧卸载器因文件被外部进程锁定而 Abort）。
; 注意：本文件通过 package.json 的 build.nsis.include 注入，宏名必须为 customCheckAppRunning
;       才能被 allowOnlyOneInstallerInstance.nsh 的 !ifmacrodef 命中并整体替换默认逻辑。
;       本宏在 electron-builder 的 uninstallOldVersion 之前执行，是「卸载自愈」的合法钩子。

!macro customCheckAppRunning
  ${if} ${isUpdated}
    # electron-updater 会先启动 NSIS，再通知 Electron 退出。数据备份或 Chromium
    # 收尾较慢时，短暂存在进程是正常现象；最多等待 15 秒再要求人工干预。
    StrCpy $R5 0
    xjWaitForAppExit:
      Sleep 1000
      !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
      ${if} $R0 != 0
        Goto xjAppNotRunning
      ${endIf}
      IntOp $R5 $R5 + 1
      ${if} $R5 < 15
        Goto xjWaitForAppExit
      ${endIf}
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

  ; ============================================================
  ; 卸载旧文件失败自愈
  ; ------------------------------------------------------------
  ; 背景：升级/覆盖安装时，electron-builder 会先调用 uninstallOldVersion 运行「旧卸载器」，
  ;       旧卸载器用原子重命名 $INSTDIR 的方式删目录；只要目录内任一文件被外部进程
  ;      （Defender 实时扫描 / 资源管理器缩略图句柄 / 备份同步代理）锁定，就会 Abort，
  ;       退出码 2 → 弹出 "Failed to uninstall old application files. ... :2" 并终止安装。
  ; 策略：此时心镜进程已确认退出（上文已强杀）。这里主动把旧安装目录清掉，并删除卸载注册表项；
  ;       随后的 uninstallOldVersion 读不到 UninstallString → 提前 Return（installUtil.nsh:156-163），
  ;       跳过脆弱的旧卸载器，直接走全新安装分支，从根上规避 :2 错误。
  ; ============================================================
  ClearErrors
  ReadRegStr $R1 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" "UninstallString"
  ${if} $R1 == ""
    ; 注册表无卸载记录 = 全新安装，无需自愈
    Goto xjSelfHealDone
  ${endIf}

  ; 定位旧安装目录：优先注册表 InstallLocation，回退到当前 $INSTDIR
  ReadRegStr $R2 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "InstallLocation"
  ${if} $R2 == ""
    StrCpy $R2 "$INSTDIR"
  ${endIf}

  ; 只有确认目录已不存在，才允许删除卸载注册表项。否则保留注册表并交回
  ; electron-builder 的标准卸载流程，避免“目录未删净但卸载信息先丢失”。
  StrCpy $R4 0
  ${ifNot} ${FileExists} "$R2\*.*"
    StrCpy $R4 1
  ${elseIf} ${FileExists} "$R2\${APP_EXECUTABLE_FILENAME}"
  ${orIf} ${FileExists} "$R2\resources\app.asar"
    DetailPrint `正在清理旧版本安装目录：$R2`
    ; 给刚退出进程后的外部句柄（Defender 扫描等）时间释放，最多重试 3 次
    StrCpy $R3 0
    xjRmRetry:
      RMDir /r "$R2"
      ${ifNot} ${FileExists} "$R2\*.*"
        Goto xjRmDone
      ${endIf}
      IntOp $R3 $R3 + 1
      ${if} $R3 < 3
        DetailPrint `旧目录仍被占用，1.2 秒后重试清理（第 $R3 次）...`
        Sleep 1200
        Goto xjRmRetry
      ${endIf}
    xjRmDone:
    ${ifNot} ${FileExists} "$R2\*.*"
      StrCpy $R4 1
    ${endIf}
  ${endIf}

  ${if} $R4 == 1
    ; 旧目录已清理，删除卸载项以跳过脆弱的旧卸载器；安装结束会重新写回。
    DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
  ${else}
    DetailPrint `旧版本目录未完全清理，保留卸载信息并回退到标准卸载流程。`
  ${endIf}
  ClearErrors

  xjSelfHealDone:
!macroend
