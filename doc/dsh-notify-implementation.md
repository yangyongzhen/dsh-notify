# dsh-notify 实现详解：一个"简单"通知插件里的设计决策

> 本文拆解 dsh-notify（DeepSeek Harness 任务完成通知插件）的实现：渠道抽象、事件触发、防抖、以及最容易翻车的 **dispose 异步 flush**。它看起来比会话导出插件简单，但藏着几个值得细讲的点——尤其是"进程退出时如何安全地发完最后一条 HTTP 请求"。
>
> 配套源码：`../`（dsh-notify 项目根）；姊妹篇：[dsh-session-export 插件开发实战](../dsh-session-export/doc/dsh-plugin-development-guide.md)（讲插件机制全流程，本文不再重复基础）。

---

## 1. 插件定位

dsh 的会话是 event-sourced 的事件日志（`turn/start`、`assistant/message`、`tool/call`…）。任何"观察会话"的插件都做同一件事：**订阅 `session/event` 事件流 → 在 `turn/end` 时做点什么**。会话导出插件把它渲染成 Markdown 落盘；通知插件把它压缩成一条消息发出去。

两者的差异决定了实现取舍：

| | 会话导出（dsh-session-export） | 通知（dsh-notify） |
|---|---|---|
| 输出 | 文件（本地磁盘） | HTTP 请求（网络） |
| 写操作 | 同步 `writeFileSync` | 异步 `fetch` |
| dispose 时序 | 同步 flush，毫秒级 | 异步 flush，需要等待 |
| 内容 | 全量事件渲染 | 一行摘要 |

核心复杂度不在"发通知"（一个 fetch 的事），而在**渠道差异**和**退出时序**。

## 2. 架构：纯函数 + 薄插件

两个模块，职责完全分离：

```
src/
├── notify.ts    # 纯函数：summarize / buildMessage / sendNotification —— 零 dsh 运行时依赖
└── index.ts     # 插件：事件订阅、防抖、dispose flush —— 只做编排
```

`notify.ts` 不 import 任何 Cordis/dsh 代码（只引类型），可以脱离 dsh 单独单测；`index.ts` 只处理"什么时候发"。

## 3. 渠道抽象

四个渠道（Server酱 / 钉钉 / 飞书 / 通用 Webhook）的差别只有两处：**URL 是否需要签名参数**、**payload 的 MIME 与结构**。抽象成一个配置对象：

```ts
export interface NotifyChannel {
  type: 'serverchan' | 'dingtalk' | 'feishu' | 'generic';
  url: string;
  secret?: string;      // 仅钉钉加签模式
  titlePrefix?: string;
}
```

`schema` 里用 schemastery 的 union 校验：

```ts
const ChannelConfig = z.object({
  type: z.union([z.const('serverchan'), z.const('dingtalk'), z.const('feishu'), z.const('generic')]),
  url: z.string().required(),
  secret: z.string(),
  titlePrefix: z.string()
});
const Config = z.object({
  channels: z.array(ChannelConfig).default([]),  // 空数组 = 不发送
  ...
});
```

发送时按 type 分支构造请求（`src/notify.ts` 的 `sendNotification`）：

```ts
switch (channel.type) {
  case 'serverchan':
    // form 表单（application/x-www-form-urlencoded）
    body = new URLSearchParams({ title: message.title, desp: message.content }).toString();
    break;
  case 'dingtalk':
    if (channel.secret !== undefined) {
      url += '&' + dingtalkSignature(channel.secret).slice(1);  // 加签参数拼进 URL
    }
    body = JSON.stringify({ msgtype: 'text', text: { content: `${title}\n${content}` } });
    break;
  case 'feishu':
    body = JSON.stringify({ msg_type: 'text', content: { text: `${title}\n${content}` } });
    break;
  default: // generic
    body = JSON.stringify({ title, content, timestamp: new Date().toISOString() });
}
```

**钉钉加签**（机器人安全设置 → 加签）是唯一的"算法"点：`timestamp + "\n" + secret` 做 HMAC-SHA256，base64 后 URL 编码，拼成 `&timestamp=...&sign=...` 追加到 webhook URL：

```ts
export function dingtalkSignature(secret: string): string {
  const timestamp = Date.now();
  const hmac = createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64');
  return `&timestamp=${timestamp}&sign=${encodeURIComponent(hmac)}`;
}
```

fetch 统一加 10s 超时（`AbortController`），失败抛可读错误，由插件层记日志——**通知失败绝不影响 agent 运行**。

## 4. 摘要聚合

`summarize(events)` 遍历事件流一次，收集通知需要的全部事实：

```ts
export function summarize(events: readonly SessionEvent[]): NotifySummary {
  // turns / toolCalls / tokens(input, output, cacheRead, cacheWrite)
  // model（取自第一个 request/header.config）
  // reason（最后一个 turn/end 的 kind）
  // lastAssistantText（最后一个非空 assistant/message 文本）
  // durationMs（首事件 time → 末事件 time）
}
```

`buildMessage` 拼人类可读文本，`clip` 截断摘要（`summaryMaxChars`，默认 500）：

```
[dsh] 任务完成
模型：deepseek-official/deepseek-v4-flash
耗时：1m 5s
工具调用：2 次
tokens：100 in / 50 out（缓存读 20 / 写 0）
---
<最后一条助手消息摘要>
```

注意 `summarize` 与导出插件的 `summarizeStats` 有重叠——这是刻意的：两个插件保持独立（互不依赖），重复的十几行聚合逻辑换来了"装一个不用装另一个"的独立性。社区插件宁重复、勿耦合。

## 5. 触发与防抖

```ts
ctx.on('session/event', (session, event) => {
  if (event.type !== 'turn/end') return;
  if (!shouldNotify(config, event.data.reason.kind)) return;  // 按结果类型过滤
  pending.set(id, session);
  clearTimeout(timers.get(id));        // 防抖：同一会话的新 turn 重置窗口
  timers.set(id, setTimeout(() => { ...deliver... }, config.debounceMs));
});
```

`shouldNotify` 按配置过滤：`notifyOnCompleted`（completed）、`notifyOnError`（error/max-tokens）。默认两者都开。

**为什么防抖**：一个会话可能有多个 turn（用户跑完一轮又问一句）。立即在每个 turn/end 通知会轰炸手机；防抖窗口内若出现新 turn 则重置，等于"这轮对话安静了再通知"。长任务（几十秒到几小时）结束后没有后续 turn，防抖到期即发。

## 6. 最容易翻车的点：dispose 异步 flush

headless 场景：`dsh --profile headless "任务"` 跑完，agent 停稳后**进程立刻退出**。此时防抖窗口（默认 10s）大概率还没走完——如果什么都不做，通知就丢了，而"任务完成通知"恰恰是 headless 用户最需要的。

解决方案分两层：

**第一层：防抖兜底**。`turn/end` 时把 session 放进 `pending` Map（不只是 timer 闭包持有），dispose 时对 `pending` 里所有会话直接发送，不等防抖。

**第二层：异步 cleanup 被框架 await**。这是关键——dsh 的 shutdown 有 5 秒 dispose 窗口，且 **Cordis 会 await `ctx.effect` 返回的 cleanup promise**（框架文档：异步处置器并发执行）：

```ts
ctx.effect(() => () => {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  const sessions = [...pending.values()];
  pending.clear();
  return Promise.all(sessions.map((s) => deliver(ctx, s, config))).then(() => undefined);
});
```

对比导出插件用 `writeFileSync`（同步、毫秒级），通知是 HTTP 不能同步等，所以 cleanup 返回 promise，让 Cordis 在退出窗口内等它发完（fetch 10s 超时 < 5s 窗口，实际 2s 内完成）。

**验证时序**（真实 headless 跑任务 + 本地 webhook）：

```
任务开始（agent 创建会话）
  → turn/start → user/message → assistant/message → turn/end（reason: completed）
  → 插件 pending 该会话，启动 2s 防抖 timer
  → agent 停稳，headless runner 请求退出
  → dispose：清 timer，对 pending 立即 deliver → fetch POST http://127.0.0.1:9999/hook
  → 进程退出
```

本地接收服务器收到 payload 即证明链路完整（包括 dispose flush——因为防抖 2s 还没到期，能送达全靠 cleanup）。

## 7. 端到端验证：不需要真实 webhook

没有 Server酱/钉钉账号也能完整验证——用**本地 HTTP 服务器**当 webhook：

`test/hook-server.mjs`（20 行）：监听 `127.0.0.1:9999`，把每个 POST 的 body 追加到 `test/hook-received.jsonl`。

`test/notify-patch.yml`（测试 overlay）：把 notify 插件指向本地服务器——`--patch` 会**替换该配置行的整个 config**，所以测试 config 里写全字段：

```yaml
- id: notify
  config:
    enabled: true
    channels:
      - type: generic
        url: http://127.0.0.1:9999/hook
    debounceMs: 2000
    summaryMaxChars: 300
    titlePrefix: '[test] '
    notifyOnCompleted: true
    notifyOnError: true
```

跑法：

```sh
dsh plugin --profile headless add file:C:/Users/GL2682/dsh-notify
node test/hook-server.mjs &          # 或 hub start
dsh --profile headless --patch ./test/notify-patch.yml "写一个 Python 函数"
cat test/hook-received.jsonl
```

`hook-received.jsonl` 里应有一条真实通知：

```json
{"title":"[test] [dsh] 任务完成",
 "content":"模型：deepseek-official/deepseek-v4-flash\n耗时：4s\ntokens：8247 in / 122 out（缓存读 0 / 写 0）\n---\ndef fibonacci(n: int): ...",
 "timestamp":"..."}
```

## 8. 配置与使用

```yaml
- id: notify
  config:
    enabled: true
    debounceMs: 10000
    summaryMaxChars: 500
    titlePrefix: ''
    notifyOnCompleted: true
    notifyOnError: true
    channels:
      - type: serverchan
        url: https://sctapi.ftqq.com/<SENDKEY>.send
      - type: dingtalk
        url: https://oapi.dingtalk.com/robot/send?access_token=<TOKEN>
        secret: <可选>
      - type: feishu
        url: https://open.feishu.cn/open-apis/bot/v2/hook/<TOKEN>
      - type: generic
        url: https://example.com/hook
```

安装：`dsh plugin --profile <web|tui|headless> add file:/path/to/dsh-notify`（或 git 仓库 URL）。

## 9. 小结：可复用的设计模式

1. **纯函数分离**：`summarize/buildMessage/sendNotification` 零运行时依赖，可单测、可被其他插件 import（`dsh-notify` 已 re-export）。
2. **渠道 = 配置对象 + 一个 switch**：加新渠道（Telegram、企业微信…）只需加一个枚举值和一段 payload 构造。
3. **防抖 + pending 兜底 + 异步 cleanup**：所有"会话结束后做点事"的插件（导出、通知、报表、备份）都是这个骨架。
4. **本地服务器做 e2e**：外部服务不可用/不想打扰别人时，本地 webhook + patch overlay 是最快的验证路径。

参考：

- [dsh-notify 仓库（GitHub）](https://github.com/yangyongzhen/dsh-notify) ｜ [GitCode 镜像](https://gitcode.com/qq8864/dsh-notify)
- [dsh 插件机制教程（姊妹篇）](../dsh-session-export/doc/dsh-plugin-development-guide.md)
- [DeepSeek Harness 官方文档](https://deepseek-harness.github.io/deepseek-harness/develop/framework/)
