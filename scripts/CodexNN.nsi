Unicode true
Name "Codex NN"
OutFile "/work/bundle/nsis/CodexNN_0.2.0_x64-setup.exe"
InstallDir "$LOCALAPPDATA\Programs\Codex NN"
RequestExecutionLevel user
SetCompressor /SOLID lzma

Page directory
Page instfiles
UninstPage uninstConfirm
UninstPage instfiles

Section "Codex NN"
  SetOutPath "$INSTDIR"
  File "/work/codex-nn.exe"
  File "/work/WebView2Loader.dll"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateDirectory "$SMPROGRAMS\Codex NN"
  CreateShortcut "$SMPROGRAMS\Codex NN\Codex NN.lnk" "$INSTDIR\codex-nn.exe"
  CreateShortcut "$DESKTOP\Codex NN.lnk" "$INSTDIR\codex-nn.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexNN" "DisplayName" "Codex NN"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexNN" "DisplayVersion" "0.2.0"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexNN" "Publisher" "slovx2"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexNN" "UninstallString" "$INSTDIR\Uninstall.exe"
SectionEnd

Section "Uninstall"
  Delete "$DESKTOP\Codex NN.lnk"
  Delete "$SMPROGRAMS\Codex NN\Codex NN.lnk"
  RMDir "$SMPROGRAMS\Codex NN"
  Delete "$INSTDIR\codex-nn.exe"
  Delete "$INSTDIR\WebView2Loader.dll"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\CodexNN"
SectionEnd
