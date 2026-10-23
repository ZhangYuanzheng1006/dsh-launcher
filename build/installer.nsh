; Stable installer identity is configured in package.json. Never delete user data
; from this hook: upgrades replace program files only.
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "$(LauncherWelcomeTitle)"
  !define MUI_WELCOMEPAGE_TEXT "$(LauncherWelcomeText)"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customHeader
  LangString LauncherWelcomeTitle 2052 "安装或升级 DSH Launcher"
  LangString LauncherWelcomeTitle 1033 "Install or update DSH Launcher"
  LangString LauncherWelcomeText 2052 "本安装器可用于首次安装，也可直接覆盖升级已有版本。$\r$\n$\r$\n以后下载新版安装 EXE，退出启动器（包括托盘）后直接运行，无需卸载旧版。升级会沿用已有安装位置。$\r$\n$\r$\n程序文件与用户资料分开保存。安装和升级保留启动器设置、网页登录资料及 DSH 数据；DSH 运行版本由应用内单独管理。$\r$\n$\r$\n首次部署 DSH 运行环境需要联网。升级前建议备份数据；详细路径与恢复步骤见安装目录 resources/INSTALLATION.md。$\r$\n$\r$\n点击“下一步”继续。"
  LangString LauncherWelcomeText 1033 "Use this installer for a fresh installation or an in-place upgrade.$\r$\n$\r$\nFor future updates, download the new Setup EXE, quit the launcher (including its tray icon), and run the installer. Keep the existing installation; do not uninstall first.$\r$\n$\r$\nProgram files are separate from user data. Setup preserves launcher settings, browser profiles and DSH data. DSH runtime versions are managed separately inside the app.$\r$\n$\r$\nInitial DSH runtime deployment requires internet access. Back up your data before upgrading. See resources/INSTALLATION.md for paths and recovery steps.$\r$\n$\r$\nClick Next to continue."
!macroend
