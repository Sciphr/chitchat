!macro NSIS_HOOK_PREINSTALL
  DetailPrint "Preparing ChitChat installation..."
  nsExec::ExecToLog 'taskkill /IM ChitChat.exe'
  Sleep 1200
  nsExec::ExecToLog 'taskkill /F /IM ChitChat.exe'
!macroend

!macro NSIS_HOOK_POSTINSTALL
  DetailPrint "ChitChat installation complete."
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  DetailPrint "Preparing ChitChat uninstall..."
  nsExec::ExecToLog 'taskkill /IM ChitChat.exe'
  Sleep 1200
  nsExec::ExecToLog 'taskkill /F /IM ChitChat.exe'
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DetailPrint "ChitChat uninstall complete."
!macroend
