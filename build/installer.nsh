; Custom NSIS installer script for Sentry-Six-Revamped
; Handles corrupted old installations and file locking issues

!macro customCheckAppRunning
  ; Force kill any running instance and child processes
  nsExec::ExecToStack `taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /t`
  nsExec::ExecToStack `taskkill /f /im "Sentry-Six-Revamped.exe" /t`
  Sleep 2000
!macroend

; Run BEFORE attempting old uninstaller - proactively clean up corrupted installations
!macro customInit
  ; Check if old uninstaller exists and is valid
  ; If corrupted, clean up now to prevent error dialogs later
  
  Var /GLOBAL oldUninstaller
  Var /GLOBAL oldInstallDir
  
  ; Read old install location from registry
  ReadRegStr $oldInstallDir HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}" "InstallLocation"
  ReadRegStr $oldUninstaller HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}" "UninstallString"
  
  ${if} $oldUninstaller != ""
    ; Old installation exists - check if uninstaller is valid
    ; Try to get file info - if this fails, uninstaller is corrupted/missing
    IfFileExists $oldInstallDir\*.* 0 no_old_install
    
    ; Kill any running processes first
    nsExec::ExecToStack `taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /t`
    nsExec::ExecToStack `taskkill /f /im "Sentry-Six-Revamped.exe" /t`
    Sleep 1000
    
    ; Proactively remove old installation to avoid uninstaller issues
    DetailPrint "Cleaning up previous installation..."
    RMDir /r "$oldInstallDir"
    
    ; Also check common alternative locations
    RMDir /r "$LOCALAPPDATA\Programs\Sentry Six Revamped"
    RMDir /r "$LOCALAPPDATA\Programs\Sentry-Six-Revamped"
    
    ; Clean up registry so installer doesn't try to run broken uninstaller
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}"
    
    no_old_install:
  ${endIf}
  
  ; Also check HKLM for system-wide installs
  ReadRegStr $oldInstallDir HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}" "InstallLocation"
  ${if} $oldInstallDir != ""
    nsExec::ExecToStack `taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /t`
    Sleep 1000
    RMDir /r "$oldInstallDir"
    RMDir /r "$PROGRAMFILES\Sentry-Six-Revamped"
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}"
  ${endIf}
!macroend

; Handle corrupted uninstaller - if old uninstall fails, clean up manually
!macro customUnInstallCheck
  ; The old uninstaller failed (possibly corrupted)
  ; Clean up manually instead of failing
  DetailPrint "Old uninstaller unavailable - performing manual cleanup..."
  
  ; Kill any running processes first
  nsExec::ExecToStack `taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /t`
  nsExec::ExecToStack `taskkill /f /im "Sentry-Six-Revamped.exe" /t`
  Sleep 1500
  
  ; Find and delete old installation directories in common locations
  RMDir /r "$LOCALAPPDATA\Programs\Sentry Six Revamped"
  RMDir /r "$LOCALAPPDATA\Programs\Sentry-Six-Revamped"
  RMDir /r "$PROGRAMFILES\Sentry-Six-Revamped"
  RMDir /r "$PROGRAMFILES\Sentry Six Revamped"
  
  ; Clean up registry entries for old installation
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}"
  DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}"
  
  DetailPrint "Manual cleanup complete"
  
  ; Clear errors so installation continues
  ClearErrors
!macroend

; Override the default file removal to handle locked files gracefully
!macro customRemoveFiles
  SetDetailsPrint textonly
  DetailPrint "Removing old files..."
  SetDetailsPrint listonly
  
  ; Force kill first
  nsExec::ExecToStack `taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /t`
  Sleep 1000
  
  ; Use RMDir with retries for locked files
  StrCpy $R1 0
  
  retry_delete:
    IntOp $R1 $R1 + 1
    RMDir /r "$INSTDIR"
    
    IfFileExists "$INSTDIR\*.*" 0 delete_done
      ${if} $R1 < 5
        DetailPrint "Files in use, retrying... ($R1/5)"
        Sleep 2000
        nsExec::ExecToStack `taskkill /f /im "${APP_EXECUTABLE_FILENAME}" /t`
        Sleep 1000
        Goto retry_delete
      ${else}
        DetailPrint "Some files locked - scheduling for cleanup on reboot"
        Delete /REBOOTOK "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
        Delete /REBOOTOK "$INSTDIR\*.dll"
        Delete /REBOOTOK "$INSTDIR\*.exe"
        RMDir /r /REBOOTOK "$INSTDIR"
        SetRebootFlag true
      ${endIf}
  
  delete_done:
!macroend
