# LeagueVid keeps recordings and clips beside the executable when the user has
# not chosen another folder. electron-builder's default upgrade uninstaller
# assumes that every item in $INSTDIR belongs to the app, so it would otherwise
# move/delete those user files while replacing the application.

!ifndef BUILD_UNINSTALLER

Var /GLOBAL LeagueVidRecordingsBackup
Var /GLOBAL LeagueVidClipsBackup
Var /GLOBAL LeagueVidRecordingsMoved
Var /GLOBAL LeagueVidClipsMoved
Var /GLOBAL LeagueVidUpdateTemp

!define MUI_CUSTOMFUNCTION_ABORT LeagueVidRestoreUserData

Function LeagueVidPreserveUserData
  StrCpy $LeagueVidRecordingsBackup "$INSTDIR.__leaguevid_recordings"
  StrCpy $LeagueVidClipsBackup "$INSTDIR.__leaguevid_clips"

  IfFileExists "$LeagueVidRecordingsBackup\*.*" 0 leaguevid_move_recordings
    IfFileExists "$INSTDIR\recordings\*.*" 0 leaguevid_recordings_preserved
    MessageBox MB_OK|MB_ICONSTOP "LeagueVid found both $INSTDIR\recordings and an earlier update backup at $LeagueVidRecordingsBackup. Move those files together, then run the installer again."
    Abort

  leaguevid_move_recordings:
    IfFileExists "$INSTDIR\recordings\*.*" 0 leaguevid_recordings_done
    ClearErrors
    Rename "$INSTDIR\recordings" "$LeagueVidRecordingsBackup"
    IfErrors 0 leaguevid_recordings_preserved
    MessageBox MB_OK|MB_ICONSTOP "LeagueVid could not protect $INSTDIR\recordings before updating. The update has been stopped; your files were not deleted."
    Abort

  leaguevid_recordings_preserved:
    StrCpy $LeagueVidRecordingsMoved "1"

  leaguevid_recordings_done:
    IfFileExists "$LeagueVidClipsBackup\*.*" 0 leaguevid_move_clips
      IfFileExists "$INSTDIR\clips\*.*" 0 leaguevid_clips_preserved
      MessageBox MB_OK|MB_ICONSTOP "LeagueVid found both $INSTDIR\clips and an earlier update backup at $LeagueVidClipsBackup. Move those files together, then run the installer again."
      Abort

  leaguevid_move_clips:
    IfFileExists "$INSTDIR\clips\*.*" 0 leaguevid_clips_done
    ClearErrors
    Rename "$INSTDIR\clips" "$LeagueVidClipsBackup"
    IfErrors 0 leaguevid_clips_preserved
    MessageBox MB_OK|MB_ICONSTOP "LeagueVid could not protect $INSTDIR\clips before updating. The update has been stopped; your files were not deleted."
    Abort

  leaguevid_clips_preserved:
    StrCpy $LeagueVidClipsMoved "1"

  leaguevid_clips_done:
FunctionEnd

Function LeagueVidRestoreUserData
  StrCmp $LeagueVidRecordingsMoved "1" 0 leaguevid_restore_clips
    IfFileExists "$LeagueVidRecordingsBackup\*.*" 0 leaguevid_recordings_restored
    IfFileExists "$INSTDIR\recordings\*.*" leaguevid_recordings_conflict 0
    ClearErrors
    Rename "$LeagueVidRecordingsBackup" "$INSTDIR\recordings"
    IfErrors 0 leaguevid_recordings_restored
    MessageBox MB_OK|MB_ICONSTOP "LeagueVid was updated, but could not restore your recordings from $LeagueVidRecordingsBackup. They are still safe in the backup folder."
    Abort

    leaguevid_recordings_conflict:
      MessageBox MB_OK|MB_ICONSTOP "LeagueVid was updated, but could not restore $LeagueVidRecordingsBackup because $INSTDIR\recordings already exists. Your recordings are still safe in the backup folder."
      Abort

    leaguevid_recordings_restored:

  leaguevid_restore_clips:
  StrCmp $LeagueVidClipsMoved "1" 0 leaguevid_restore_done
    IfFileExists "$LeagueVidClipsBackup\*.*" 0 leaguevid_clips_restored
    IfFileExists "$INSTDIR\clips\*.*" leaguevid_clips_conflict 0
    ClearErrors
    Rename "$LeagueVidClipsBackup" "$INSTDIR\clips"
    IfErrors 0 leaguevid_clips_restored
    MessageBox MB_OK|MB_ICONSTOP "LeagueVid was updated, but could not restore your clips from $LeagueVidClipsBackup. They are still safe in the backup folder."
    Abort

    leaguevid_clips_conflict:
      MessageBox MB_OK|MB_ICONSTOP "LeagueVid was updated, but could not restore $LeagueVidClipsBackup because $INSTDIR\clips already exists. Your clips are still safe in the backup folder."
      Abort

    leaguevid_clips_restored:

  leaguevid_restore_done:
FunctionEnd

!macro customInit
  StrCpy $LeagueVidRecordingsMoved "0"
  StrCpy $LeagueVidClipsMoved "0"

  # Only an upgrade has an existing executable and needs the old uninstaller.
  IfFileExists "$INSTDIR\${APP_EXECUTABLE_FILENAME}" 0 leaguevid_init_done

  # The old electron-builder uninstaller stages files atomically through TEMP.
  # Make TEMP a sibling of a custom install so H: -> H: renames stay atomic.
  StrCpy $LeagueVidUpdateTemp "$INSTDIR.__leaguevid_update_temp"
  CreateDirectory "$LeagueVidUpdateTemp"
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("TEMP", "$LeagueVidUpdateTemp").r0'
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("TMP", "$LeagueVidUpdateTemp").r0'

  Call LeagueVidPreserveUserData

  leaguevid_init_done:
!macroend

!macro customInstall
  Call LeagueVidRestoreUserData

  # A silent update came from LeagueVid itself. Starting here also bridges the
  # first upgrade from older builds whose helper did not reliably reopen it.
  ${If} ${Silent}
    Exec '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --updated'
  ${EndIf}
!macroend

!endif

# Used by the uninstaller embedded in this and later releases. Remove only the
# application payload; leave recordings, clips, and any other user-owned files
# in the chosen folder.
!macro customRemoveFiles
  RMDir /r "$INSTDIR\locales"
  RMDir /r "$INSTDIR\resources"
  Delete "$INSTDIR\chrome_100_percent.pak"
  Delete "$INSTDIR\chrome_200_percent.pak"
  Delete "$INSTDIR\d3dcompiler_47.dll"
  Delete "$INSTDIR\ffmpeg.dll"
  Delete "$INSTDIR\icudtl.dat"
  Delete "$INSTDIR\libEGL.dll"
  Delete "$INSTDIR\libGLESv2.dll"
  Delete "$INSTDIR\LICENSE.electron.txt"
  Delete "$INSTDIR\LICENSES.chromium.html"
  Delete "$INSTDIR\resources.pak"
  Delete "$INSTDIR\snapshot_blob.bin"
  Delete "$INSTDIR\v8_context_snapshot.bin"
  Delete "$INSTDIR\vk_swiftshader.dll"
  Delete "$INSTDIR\vk_swiftshader_icd.json"
  Delete "$INSTDIR\vulkan-1.dll"
  Delete "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  Delete "$INSTDIR\uninstallerIcon.ico"
  RMDir "$INSTDIR"
!macroend
