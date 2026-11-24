LightSSH 1.6  —  简洁的 SSH 客户端 / A clean SSH client

【中文】
1. 安装：运行 LightSSH-Setup-vX.Y.Z.exe（装在当前用户下，不需要管理员权限）；或解压 zip 直接运行 LightSSH.exe。
   首次运行如出现 Windows SmartScreen 提示，点「更多信息」→「仍要运行」。
2. 「新建主机」添加服务器，或点「导入 SSH 配置」从 ~/.ssh/config 一键导入（自动关联 ProxyJump）。支持密码或私钥，密码用 Windows 系统加密保存。
3. 跳板机：编辑主机时选「跳板机」，会先连上跳板机再连目标，可多级。
4. 点主机即连接，支持多标签；搜索框输入 user@host:端口 回车可快速连接。
5. 分屏：终端右上角分屏按钮或 Ctrl+Shift+D，最多 4 个，可把已打开的会话合进来。
6. 「端口转发」：本地（访问本机端口 → 服务器能访问的目标）、远程（服务器端口 → 本机目标）、动态 SOCKS5 代理。
   规则所用主机需要保存密码或使用私钥。
7. 「片段」：保存常用命令，在终端闪电图标里一键执行（按住 Shift 只粘贴不执行）。
8. 终端文件图标打开 SFTP：双击进入或下载，支持文件和文件夹递归上传/下载、重命名、删除、复制路径、拖放上传。
9. Ctrl+K 命令面板；「设置」里有主题、终端配色、语言、字号、字体、光标、选中即复制。

快捷键：Ctrl+K 命令面板 · Ctrl+F 查找 · Ctrl+Shift+C/V 复制粘贴 · Ctrl+Shift+D 分屏 · Ctrl+Tab 切换标签
        Ctrl+Shift+W 关闭 · Ctrl+Shift+T 回主页 · Ctrl +/- 字号，Ctrl+0 还原 · 断开后按 Enter 重连
数据保存位置：%APPDATA%\LightSSH（卸载时会保留）

[English]
1. Install with LightSSH-Setup-vX.Y.Z.exe (per-user, no admin), or unzip and run LightSSH.exe.
   If SmartScreen appears: "More info" -> "Run anyway".
2. "New Host" adds a server, or click "Import SSH config" to import from ~/.ssh/config (including ProxyJump). Password or private key auth, encrypted with Windows DPAPI.
3. Jump host: pick one in the host editor; LightSSH connects through it (chains allowed).
4. Click a host to connect; multiple tabs. Type user@host:port in the search box to quick connect.
5. Split panes: the split button or Ctrl+Shift+D, up to 4 panes; existing sessions can join.
6. Port Forwarding: local, remote and dynamic SOCKS5 rules. The host needs a saved password or a key.
7. Snippets run from the lightning icon in the terminal (hold Shift to paste only).
8. The folder icon opens SFTP with file & recursive folder upload/download, rename, delete and drag & drop.
9. Ctrl+K command palette; Settings has theme, terminal colors, language, font, cursor, copy on select.

Shortcuts: Ctrl+K palette · Ctrl+F find · Ctrl+Shift+C/V copy/paste · Ctrl+Shift+D split · Ctrl+Tab switch
           Ctrl+Shift+W close · Ctrl+Shift+T home · Ctrl +/- font, Ctrl+0 reset · Enter to reconnect
Data folder: %APPDATA%\LightSSH (kept on uninstall)
