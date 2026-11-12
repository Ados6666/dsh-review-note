# dsh-review-note · 交付批注

把 DeepSeek Harness 里的人工确认，从「一题一答」变成**一屏逐条批注**：模型把交付内容交过来，
你在正文上划词、在每个确认点上写意见，一次性把结构化结果发回去。

- **交付评审** —— 模型调用 `request_review`，带上交付正文、待确认条目和产出文件；右侧栏弹出评审单，
  你像计划评审那样批注，工具返回 `approved` / `changes_requested` / `dismissed` 及逐条意见。
- **自动验收** —— 模型用 `present` 声明交付文件后，插件**自动**发起一次文件级验收；不需要你下任何指令。
- **批量确认** —— 单次 `ask_user_question` 达到 3 题及以上时，接管原生卡片，一屏列全、一次提交。

## 环境

- DeepSeek Harness `0.2.x`，用**带界面**的客户端打开（桌面应用，或 `dsh web` 打开的页面；面板就长在这个界面里）。
- 一个可安装 bundle 的 profile。
- 系统：macOS / Windows / Linux 均可。插件里没有 shell 命令、没有平台相关路径拼接，Windows 盘符路径（`C:\Users\...`）、UNC 路径和含空格/中文的文件名都按 URI 规则编码；CI 在三个平台上各跑一遍测试。

## 安装

从 GitHub 安装：

```bash
dsh plugin --profile <profile> add github:Ados6666/dsh-review-note
```

从本地目录安装：

```bash
dsh plugin --profile <profile> add /path/to/dsh-review-note
```

装完重启 DSH，或硬刷新 Web 客户端。卸载：`dsh plugin --profile <profile> remove dsh-review-note`。

## 用法

### 1. 交付评审

交付件需要你确认时，模型会调用：

```text
request_review(
  title: "募投方案 · 第二节口径确认",
  detail: "……交付正文 Markdown……",
  items: [
    { id: "capex", prompt: "研发投入是否按全费用化口径？", quote: "研发投入按全费用化口径测算" },
    { id: "working-capital", prompt: "铺底流动资金是否全部自筹？" }
  ],
  files: ["reports/plan.md"]
)
```

右侧栏出现评审单：左侧正文可划词加批注，右侧每个确认点各有一条批注框；`quote` 会把条目钉在
对应句子上。提交后模型收到：

```json
{
  "decision": "changes_requested",
  "review_id": "rv_…",
  "annotations": [
    {
      "id": "capex",
      "prompt": "研发投入是否按全费用化口径？",
      "action": "需修改",
      "quote": "研发投入按全费用化口径测算",
      "note": "改成两套并列"
    }
  ],
  "note": "整体意见"
}
```

`decision` 取值：`approved`、`changes_requested`、`dismissed`、`unavailable`。
直接关闭面板按 `dismissed` 上报 —— **不会被当成通过**。

### 2. `present` 之后自动验收

```text
present(files: ["reports/plan.docx", "reports/plan.md"])
```

插件会对这些文件发起一次文件级验收，并把结论追加到 `present` 的工具结果里，模型当轮就能拿到你的判断。

- 关闭：插件配置里 `autoReviewPresent: false`；
- 冷却：同一会话每 `autoReviewCooldownMs`（默认 120 秒）最多自动发起一次；
- 关闭面板 = 未确认，结果里会写明「不要视为通过」；
- 自动验收失败或被取消，绝不破坏原来的 `present` 结果。

### 3. 多题确认

模型一次问 3 题及以上时，插件接管输入区，把全部问题列在侧栏评审单里。没作答的题按跳过提交
（`selected: []`），整体意见写进末尾备注。单题确认、计划评审、审批提示仍走原生卡片。

## 设置

设置 → 交付批注：

- **接管门槛** —— 默认 `3`（即超过 2 题才接管）；调高可让中等长度的确认继续走原生卡片。
- **自动展开侧栏** —— 默认开。

改动在下一轮确认请求生效。

## 实现要点

| 点 | 做法 | 原因 |
| --- | --- | --- |
| 抢占输入区 | `conversation.composer`，`priority: -1` | 内置问题卡片注册为 `0`；chain 按 priority 升序取首个非 null |
| 评审识别 | `detail` 顶部 base64 HTML 注释信封 | 不依赖私有交互类型；插件关闭时该提示仍按普通卡片渲染 |
| 回传 | `pending.answer({ answers: [...] })` | 走官方答案契约，模型侧无需适配 |
| 关闭 | `dismiss()`（不带 `wait`），Host 收到 `ASK_CANCELLED` 后收束本轮 | 不会把这一轮挂死 |
| 锚定 | CSS Custom Highlight API + `{ quote, occurrence }` | 不修改正文 DOM；不支持时降级为条目编号 |
| Markdown | 自带渲染器（标题、列表、引用、代码、管道表格） | 不把 Harness 客户端包当模块加载，升级不会把面板渲染白 |
| 草稿 | `sessionStorage`，按 session + callId | 刷新不丢，提交即清 |

## 与 dsh-plan-note 的关系

本插件是 [dsh-plan-note](https://github.com/0-0-user/dsh-plan-note) 的姊妹插件，站在它的肩膀上：
「待确认内容就地批注」的思路、段落锚定批注模型、`{ quote, occurrence }` 定位方式都来自它。
dsh-plan-note 负责计划评审，本插件把同一套交互延伸到任务执行期的交付节点。两者不抢输入区：
本插件明确排除 `plan-review` 与 `approval` 交互，计划评审仍归 dsh-plan-note（需要在 profile 里启用
`dsh-plan-mode`）。

## 已知限制

- 面板长在 Web 界面上——也就是桌面应用里你现在看到的这个页面，或 `dsh web` 打开的页面。DSH 目前只有这一种对话界面，没有命令行对话客户端，所以这个面板在别处不会出现。
- 子代理不能发起评审（`userQuestions` 会以 `DELEGATED_CALLER` 拒绝），需由主代理汇总后调用。
- Markdown 支持面刻意做小：标题、列表、引用、围栏代码、管道表格、行内代码、加粗、斜体、
  http(s) 链接；其余按文本渲染。
- 设置与草稿存在本浏览器，不跨设备同步。
- 带倒计时的超时问句不接管。

## 开发

```bash
node --check lib/client.js
node --check lib/index.js
node --test test/*.test.mjs   # 或 npm test
```

目录：

```text
lib/index.js          Host：request_review 工具、自动验收钩子、提示词段落
lib/client.js         Client：接管输入区、侧栏评审单、设置页
lib/review-format.js  信封编解码、条目归一化、答案解析（Host 与测试共用）
test/                 Format 与 Host 两半的单元测试
docs/                 详情页配图
```

## 许可

MIT —— 见 [LICENSE](LICENSE)。
