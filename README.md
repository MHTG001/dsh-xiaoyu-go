# 小鱼 · DSH-Go

小鱼手机插件按实际请求的模型 ID 从 `https://formohai.top` 取得已发布的系统提示词。开关初始关闭，按当前对话生效。匹配及授权通过后，插件只替换当前请求的系统消息，保留用户消息、历史和工具定义。关闭、未匹配或请求失败时继续使用原提示词，状态条会显示原因。

## 手机本机引擎安装

已适配 DSH `0.2.2-rc.1`，需要 Node `24.9.0` 或更新版本。DSH-Go 的本机终端可以用 `dsh --version` 确认引擎。原生按钮、状态条和面板需要本机的 DSH-Go 桥接。

解压本地安装 ZIP，把完整的 `dsh-xiaoyu-go` 文件夹放到手机「下载」。开启 DSH-Go 设置中的「访问手机文件」，在本机终端执行以下命令。

```sh
mkdir -p /root/.dsh/dsh-go/plugins
cp -r /sdcard/Download/dsh-xiaoyu-go /root/.dsh/dsh-go/plugins/
dsh plugin --profile web add /root/.dsh/dsh-go/plugins/dsh-xiaoyu-go
```

## 登录和使用

在 DSH-Go 本机交互终端运行以下命令。密码不回显，登录完成后终端只显示结果。订阅必须已经开通，首次在手机上使用时需要确认绑定。若账号已绑定其他设备，请用现有的解绑流程处理。

```sh
node /root/.dsh/dsh-go/plugins/dsh-xiaoyu-go/lib/account-cli.js login
node /root/.dsh/dsh-go/plugins/dsh-xiaoyu-go/lib/account-cli.js bind
node /root/.dsh/dsh-go/plugins/dsh-xiaoyu-go/lib/account-cli.js status
```

从分享码安装后，若目录位置未知，在 DSH-Go 本机终端用下述方式定位入口。

```sh
plugin_cli="$(find "${DSH_HOME:-$HOME/.dsh}/profiles/web/node_modules" -path '*/dsh-xiaoyu-go/lib/account-cli.js' -print -quit)"
test -n "$plugin_cli" && node "$plugin_cli" login
test -n "$plugin_cli" && node "$plugin_cli" bind
```

打开一个对话并开启「呼叫小鱼」，再发送一条消息。状态条显示匹配结果及验证词。切换模型后，下一条请求会自动按新的模型 ID 匹配。开关在重启引擎或换账号后需重新开启。

会话凭据和设备私钥位于引擎应用私有目录 `${DSH_HOME:-$HOME/.dsh}/dsh-go/xiaoyu/`，文件权限为 `0600`。手机插件使用 Linux 文件权限保护这些文件，未接入 Android Keystore。设备私钥用于保持当前绑定，退出账号不会重建设备身份。当前终端登录暂不支持二次验证。

```sh
node /root/.dsh/dsh-go/plugins/dsh-xiaoyu-go/lib/account-cli.js logout
dsh plugin --profile web remove dsh-xiaoyu-go
```

## 发布和分享

公开包包含客户端代码。提示词正文按当次授权从云端取得，应用到当次模型请求。生成分享文件和验证步骤见工作区 `mobile/发布与验证.md`。

