/**
 * dsh-notify — task-completion notifications for DeepSeek Harness.
 *
 * Listens on the `session/event` firehose; when a `turn/end` event lands it
 * debounces `debounceMs` of quiet, then pushes a summary (model, duration,
 * tool calls, token usage, last assistant text) to every configured channel.
 * Pending notifications flush on dispose so one-shot (headless) runs still
 * deliver.
 *
 * @module dsh-notify
 */
import z from '@deepseek-ai/schemastery';
import { buildMessage, sendNotification, summarize } from './notify.js';
/** Stable Cordis plugin name. */
const name = 'notify';
/** Core services required before the notifier can run. */
const inject = ['sessions'];
const ChannelConfig = z.object({
    type: z.union([z.const('serverchan'), z.const('dingtalk'), z.const('feishu'), z.const('generic')]),
    url: z.string().required(),
    secret: z.string(),
    titlePrefix: z.string()
});
const Config = z.object({
    enabled: z.boolean().default(true),
    channels: z.array(ChannelConfig).default([]),
    debounceMs: z.number().default(10_000),
    summaryMaxChars: z.number().default(500),
    titlePrefix: z.string().default(''),
    notifyOnCompleted: z.boolean().default(true),
    notifyOnError: z.boolean().default(true)
});
function shouldNotify(config, reason) {
    if (config.notifyOnCompleted && (reason === 'completed' || reason === undefined))
        return true;
    if (config.notifyOnError && (reason === 'error' || reason === 'max-tokens'))
        return true;
    return false;
}
/**
 * Mount the notifier: subscribe to the event firehose, debounce, and flush
 * pending notifications on dispose (async cleanup is awaited by Cordis within
 * the shutdown window).
 */
function apply(ctx, config) {
    if (!config.enabled || config.channels.length === 0)
        return;
    const timers = new Map();
    const pending = new Map();
    ctx.on('session/event', (session, event) => {
        if (event.type !== 'turn/end')
            return;
        if (!shouldNotify(config, event.data.reason.kind))
            return;
        const id = session.id;
        pending.set(id, session);
        clearTimeout(timers.get(id));
        timers.set(id, setTimeout(() => {
            timers.delete(id);
            pending.delete(id);
            void deliver(ctx, session, config);
        }, config.debounceMs));
    });
    ctx.effect(() => () => {
        for (const timer of timers.values())
            clearTimeout(timer);
        timers.clear();
        const sessions = [...pending.values()];
        pending.clear();
        return Promise.all(sessions.map((session) => deliver(ctx, session, config))).then(() => undefined);
    });
}
/** Build and send one session notification to every channel, logging failures. */
async function deliver(ctx, session, config) {
    try {
        const summary = summarize(session.events);
        summary.sessionId = session.id;
        if (summary.lastAssistantText === '' && summary.reason !== 'error')
            return;
        const message = buildMessage(summary, config.summaryMaxChars, config.titlePrefix);
        await Promise.allSettled(config.channels.map((channel) => sendNotification(channel, message).then(() => ctx.logger.info(`dsh-notify: delivered to ${channel.type}`), (error) => ctx.logger.warn(`dsh-notify: ${channel.type} failed: ${error instanceof Error ? error.message : String(error)}`))));
    }
    catch (error) {
        ctx.logger.warn(`dsh-notify: ${error instanceof Error ? error.message : String(error)}`);
    }
}
export { Config, apply, inject, name };
export { buildMessage, sendNotification, summarize, dingtalkSignature } from './notify.js';
