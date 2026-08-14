/**
 * Pure notification assembly and delivery. No dsh runtime dependency: feed
 * any `SessionEvent[]` and a channel config, get a human-readable summary and
 * the HTTP request that pushes it.
 *
 * @module dsh-notify/notify
 */
import { createHmac } from 'node:crypto';
const REASON_LABEL = {
    completed: '完成',
    'max-tokens': '达到输出上限',
    error: '出错',
    aborted: '被中断',
    blocked: '被阻塞',
    interrupted: '被中断（恢复）'
};
function textOf(content) {
    const parts = [];
    for (const block of content) {
        if (block.type === 'text' && block.text !== undefined)
            parts.push(block.text);
        else if (block.type === 'tool-result' && block.content !== undefined)
            parts.push(textOf(block.content));
    }
    return parts.join('\n\n');
}
function clip(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, maxChars)}…`;
}
function fmtDuration(ms) {
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rest = s % 60;
    return h > 0 ? `${h}h ${m}m ${rest}s` : m > 0 ? `${m}m ${rest}s` : `${rest}s`;
}
/** Aggregate turn facts from the session event log. */
export function summarize(events) {
    let turns = 0;
    let toolCalls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let model;
    let reason;
    let lastAssistantText = '';
    let startTime;
    let endTime;
    for (const event of events) {
        if (startTime === undefined)
            startTime = event.time;
        endTime = event.time;
        switch (event.type) {
            case 'turn/start':
                turns += 1;
                break;
            case 'turn/end':
                reason = event.data.reason.kind;
                break;
            case 'tool/call':
                toolCalls += 1;
                break;
            case 'assistant/message': {
                const text = textOf(event.data.message.content);
                if (text !== '')
                    lastAssistantText = text;
                const usage = event.data.usage;
                if (usage !== undefined) {
                    inputTokens += usage.inputTokens ?? 0;
                    outputTokens += usage.outputTokens ?? 0;
                    cacheReadTokens += usage.cacheReadTokens ?? 0;
                    cacheWriteTokens += usage.cacheWriteTokens ?? 0;
                }
                break;
            }
            case 'request/header': {
                const config = event.data.header.config;
                if (config !== undefined && model === undefined)
                    model = `${config.provider}/${config.model}`;
                break;
            }
            default: break;
        }
    }
    return {
        sessionId: '',
        model,
        turns,
        toolCalls,
        tokens: { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
        durationMs: startTime !== undefined && endTime !== undefined ? Math.max(0, endTime - startTime) : 0,
        reason,
        lastAssistantText
    };
}
/** Build the human-readable notification message body. */
export function buildMessage(summary, maxChars, titlePrefix) {
    const reasonLabel = summary.reason !== undefined ? (REASON_LABEL[summary.reason] ?? summary.reason) : '未知';
    const title = `${titlePrefix}[dsh] 任务${reasonLabel}`;
    const lines = [];
    if (summary.model !== undefined)
        lines.push(`模型：${summary.model}`);
    lines.push(`耗时：${fmtDuration(summary.durationMs)}`);
    if (summary.toolCalls > 0)
        lines.push(`工具调用：${summary.toolCalls} 次`);
    const t = summary.tokens;
    lines.push(`tokens：${t.inputTokens} in / ${t.outputTokens} out（缓存读 ${t.cacheReadTokens} / 写 ${t.cacheWriteTokens}）`);
    if (summary.lastAssistantText !== '') {
        lines.push('---');
        lines.push(clip(summary.lastAssistantText, maxChars));
    }
    return { title, content: lines.join('\n') };
}
/** DingTalk signed-mode query suffix (timestamp + hmac-sha256 signature). */
export function dingtalkSignature(secret) {
    const timestamp = Date.now();
    const hmac = createHmac('sha256', secret).update(`${timestamp}\n${secret}`).digest('base64');
    const sign = encodeURIComponent(hmac);
    return `&timestamp=${timestamp}&sign=${sign}`;
}
/**
 * Deliver one notification to one channel. Resolves when the HTTP request
 * completes; rejects with a readable error when the endpoint fails.
 */
export async function sendNotification(channel, message) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
        let url = channel.url;
        let body;
        let headers = { 'Content-Type': 'application/json' };
        switch (channel.type) {
            case 'serverchan': {
                const form = new URLSearchParams({ title: message.title, desp: message.content });
                body = form.toString();
                headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
                break;
            }
            case 'dingtalk': {
                if (channel.secret !== undefined)
                    url = `${channel.url}${channel.url.includes('?') ? '&' : '?'}${dingtalkSignature(channel.secret).slice(1)}`;
                body = JSON.stringify({ msgtype: 'text', text: { content: `${message.title}\n${message.content}` } });
                break;
            }
            case 'feishu': {
                body = JSON.stringify({ msg_type: 'text', content: { text: `${message.title}\n${message.content}` } });
                break;
            }
            default: {
                body = JSON.stringify({ title: message.title, content: message.content, timestamp: new Date().toISOString() });
                break;
            }
        }
        const response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal });
        if (!response.ok) {
            throw new Error(`${channel.type} HTTP ${response.status}: ${clip(await response.text(), 200)}`);
        }
    }
    finally {
        clearTimeout(timeout);
    }
}
