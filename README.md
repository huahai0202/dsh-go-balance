# 渠道余额 · Channel Balance

[dsh-go](https://github.com/huahai0202) 手机 App 的原生插件：在输入框上方加一个「渠道余额」胶囊，点开就能看各渠道的余额、签到、切渠道、开关模型和管理账号。

数据来自 **Jet Hub**（`/api/jet-hub` 的进程内 RPC）和 dsh-go 自己保存的 ChatGPT 登录，插件本身不发任何第三方请求、不存任何密钥。

## 功能

| 面板 | 做什么 |
|---|---|
| **当前渠道余额** | 合计余额；按到期时间拆成「临期 / 长期 / 永久」三档（Jet Hub 声明按到期分档的渠道才有）；一键签到所有有账号的渠道；ChatGPT 额度窗口与重置券 |
| **模型与账号** | 一个面板两个标签：模型开关（单个 / 批量 / 分页）、账号管理（添加账号走浏览器登录、启停、改名、刷新凭据、测试、重置限流、删除） |
| **选择渠道** | 在已配置的渠道之间切换，或跟随当前对话 |

胶囊在输入框上方；长按 AI 回复的菜单里也有「看看余额」；面板在对话详情页的「插件」页签和「全部功能」里。

## 安装

插件装在**主机**上（手机本机引擎或远程主机都行）：

```sh
git clone https://github.com/huahai0202/dsh-go-channel-balance.git
dsh plugin --profile web add ./dsh-go-channel-balance
```

装上是链接方式，**目录不能删**。`lib/` 里的代码改了要重启引擎才生效；`package.json` 改了会自动重读。

卸载：

```sh
dsh plugin --profile web remove local-balance
```

## 前提

- 主机上要装 **Jet Hub**（`dsh-providers-hub` 之类提供 `/api/jet-hub` 的插件），余额、签到、模型和账号都经由它。没有它插件会提示「没有连接」。
- 没有 Jet Hub 也没关系：ChatGPT / Codex 那条线走 dsh-go 自己的 OAuth 凭据（`llm-pi-ai/openai-codex`），可以单独用。
- 需要 dsh `>=0.2.1-rc.2 <0.3.0`；原生界面需要带 dsh-go 桥接的 App（手机本机引擎默认有）。

## 配置

没有配置文件，也不需要填密钥：

- 渠道和账号都在 Jet Hub 里配置，插件只读。
- 修改某一项时走 Jet Hub 自己的 RPC，和你直接在 Jet Hub 面板里改是同一份数据，两边会同步。
- ChatGPT 的登录用 dsh-go 凭据库；插件只读凭据、不写、不回显。
- 插件自己只存一个「上次选的渠道」，在 `$DSH_HOME/dsh-go/local-balance.json`。

## 开发

```sh
npm test          # 29 个单测：分档逻辑 + 签到文案格式化
```

纯函数在 `lib/split.js`（余额分档）和 `lib/checkin.js`（签到结果格式化），这两块有单测；其余是面板和 RPC 胶水。

```
lib/
  index.js          入口，挂三个面板
  runtime.js        三个面板共享的状态与缓存
  jet-hub.js        Jet Hub RPC 封装
  codex.js          ChatGPT 额度与重置券
  split.js          余额分档（纯函数，有单测）
  checkin.js        签到文案（纯函数，有单测）
  labels.js         渠道 id → 展示名
  prefs.js          「上次选的渠道」的读写
  panels/           balance / manage / channels 三个面板
```

## 说明

- 非官方插件，不在 DSH 官方目录里。用的是 Jet Hub 和 Codex 客户端的内部接口，上游一变就可能失效。
- 源码里没有任何令牌、账号或手机号；之前本机跑过的数据不会被带进仓库。
- 只在你自己的主机上跑，别拿去当公共服务。

## 许可

MIT
