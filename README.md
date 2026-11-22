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

## 从手机界面登录

1. 在 DSH-Go 选择**本机引擎**，打开 **设置 → 插件 → 已安装 → 小鱼 → 小鱼设置**。也可以在聊天页点 **呼叫小鱼**，尚未登录时会打开这个面板。
2. 点 **登录陌海账号**，在系统浏览器打开 `formohai.top` 的账号授权页并确认连接。回到 DSH-Go 后，面板会更新登录和订阅状态。
3. 如果显示「本机待绑定」，点 **绑定本机**。如果显示已绑定其他设备，先解除旧设备的绑定，再点 **刷新状态**。
4. 返回聊天并开启 **呼叫小鱼**。发送一条消息后，状态条显示匹配结果和验证词。

聊天页的「插件」菜单和「全部功能」也可以打开小鱼设置。老版本 App 可以从**对话详情 → 插件**进入。**设置 → 引擎参数 → 插件 → 小鱼**可以调整聊天状态条。

切换模型后，下一条请求会按新的模型 ID 匹配。退出登录、切换账号或重启引擎后，需要在对话里重新开启「呼叫小鱼」。

### 终端备用入口

在 DSH-Go 本机交互终端运行以下命令。密码不回显，登录完成后终端只显示结果。

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

会话凭据和设备私钥位于引擎应用私有目录 `${DSH_HOME:-$HOME/.dsh}/dsh-go/xiaoyu/`，文件权限为 `0600`。设备私钥用于保持当前绑定，退出账号不会重建设备身份。需要二次验证时，使用浏览器登录入口。

```sh
node /root/.dsh/dsh-go/plugins/dsh-xiaoyu-go/lib/account-cli.js logout
dsh plugin --profile web remove dsh-xiaoyu-go
```

## 发布和分享

公开包包含客户端代码。提示词正文按当次授权从云端取得，应用到当次模型请求。生成分享文件和验证步骤见工作区 `mobile/发布与验证.md`。

