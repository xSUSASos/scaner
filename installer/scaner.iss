; Установщик Inno Setup. Обычно собирается из build.ps1 (он передаёт /DAppVersion=...).
; Вручную: ISCC.exe /DAppVersion=1.0.0 installer\scaner.iss
;
; PrivilegesRequired=lowest: установка для текущего пользователя в
; %LOCALAPPDATA%\Programs — без запроса прав администратора (UAC).
; В мастере можно выбрать «для всех пользователей» — тогда в Program Files.

#ifndef AppVersion
  #define AppVersion "1.0.0"
#endif
#define AppName "Сканер документов"
#define AppExe "Scaner.exe"

[Setup]
AppId={{6F1C2B7A-3D4E-4B8A-9C21-5A7E0D9F4B13}
AppName={#AppName}
AppVersion={#AppVersion}
AppVerName={#AppName} {#AppVersion}
DefaultDirName={autopf}\Scaner
DefaultGroupName={#AppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputDir=..\dist
OutputBaseFilename=Scaner-Setup-{#AppVersion}
SetupIconFile=..\assets\icon.ico
UninstallDisplayIcon={app}\{#AppExe}
UninstallDisplayName={#AppName}
WizardStyle=modern
Compression=lzma2/max
SolidCompression=yes
; Сжатие в отдельном процессе: ISCC 32-битный, ultra64 не влезает в его память.
LZMAUseSeparateProcess=yes
CloseApplications=yes

[Languages]
Name: "ru"; MessagesFile: "compiler:Languages\Russian.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
; Вся папка сборки PyInstaller (exe + _internal с Qt, OpenCV и Tesseract).
Source: "..\dist\Scaner\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
; При обновлении убираем старую _internal целиком: иначе остаются DLL прошлых версий.
Type: filesandordirs; Name: "{app}\_internal"

[Icons]
Name: "{autoprograms}\{#AppName}"; Filename: "{app}\{#AppExe}"
Name: "{autodesktop}\{#AppName}"; Filename: "{app}\{#AppExe}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#AppExe}"; Description: "{cm:LaunchProgram,{#AppName}}"; Flags: nowait postinstall skipifsilent
