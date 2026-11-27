LightSSH 2.0 (Hark × Claude Edition)  —  简洁温润的 SSH 客户端 / A calm, tactile SSH client

【中文】
1. 安装：运行 LightSSH-Setup-vX.Y.Z.exe（装在当前用户下，不需要管理员权限）；或解压 zip 直接运行 LightSSH.exe。
   首次运行如出现 Windows SmartScreen 提示，点「更多信息」→「仍要运行」。
2. 主机管理：点「新建主机」添加服务器，或点「导入 SSH 配置」从 ~/.ssh/config 一键导入（自动关联 ProxyJump 跳板）。
   支持密码或私钥，凭据使用 Windows DPAPI 加密保存；支持分组胶囊筛选与卡片/列表视图切换。
3. Omni 输入台：搜索框既可筛选主机，也可直接输入 user@host:端口 回车直连。
4. 终端与分屏：支持多标签与最多 4 个并排分屏（Ctrl+Shift+D）；Ctrl+B 可一键收起左侧边栏获得沉浸视野。
5. 端口转发：支持本地转发、远程转发与动态 SOCKS5 代理（规则所用主机需保存密码或使用私钥）。
6. 命令片段：保存常用运维命令，在片段页或终端闪电按钮内一键执行（按住 Shift 仅粘贴不回车）。
7. SFTP 文件面板：点击终端文件夹图标展开，支持路径面包屑跳转、文件和文件夹递归上传/下载、拖放上传、重命名与删除。
8. Ctrl+K 打开命令面板；侧栏底部可一键切换浅色（羊皮）/ 深色（暖炭）与中英文。

快捷键：Ctrl+K 命令面板 · Ctrl+B 侧边栏 · Ctrl+F 查找 · Ctrl+C/V（或 Ctrl+Shift+C/V）复制粘贴 · Ctrl+Shift+D 分屏
        Ctrl+Tab 切换标签 · Ctrl+Shift+W 关闭 · Ctrl+Shift+T 回工作台 · Ctrl +/-/0 字号 · Enter 重连
数据保存位置：%APPDATA%\LightSSH（卸载时会保留）

[English]
1. Install with LightSSH-Setup-vX.Y.Z.exe (per-user, no admin), or unzip and run LightSSH.exe.
   If SmartScreen appears: "More info" -> "Run anyway".
2. Hosts: click "New Host" or "Import SSH config" (~/.ssh/config with ProxyJump). Password & key secrets are encrypted with Windows DPAPI. Filter by group pills or switch between Card and List views.
3. Omni Composer: filter hosts instantly, or type user@host:port to connect right away.
4. Terminal & Split Panes: multi-tab WebGL terminals with up to 4 split panes (Ctrl+Shift+D); press Ctrl+B to collapse the sidebar.
5. Port Forwarding: local, remote, and dynamic SOCKS5 tunnels with one-click switches.
6. Snippets: save frequent shell commands and run them in any active session (hold Shift to paste only).
7. SFTP Panel: Artifact-style file browser with clickable breadcrumbs, recursive file & folder upload/download, and drag & drop.
8. Press Ctrl+K for the Command Palette; toggle Parchment / Warm Umber theme and language right from the sidebar footer.

Shortcuts: Ctrl+K palette · Ctrl+B sidebar · Ctrl+F find · Ctrl+C/V (or Ctrl+Shift+C/V) copy/paste · Ctrl+Shift+D split
           Ctrl+Tab switch · Ctrl+Shift+W close · Ctrl+Shift+T workspace · Ctrl +/-/0 zoom · Enter reconnect
Data folder: %APPDATA%\LightSSH (kept on uninstall)
