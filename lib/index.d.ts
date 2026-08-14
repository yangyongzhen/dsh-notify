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
import type { Context } from '@deepseek-ai/cordis';
import { type NotifyChannel } from './notify.js';
/** Stable Cordis plugin name. */
declare const name = "notify";
/** Core services required before the notifier can run. */
declare const inject: string[];
/** Plugin configuration after schema validation. */
export interface NotifyConfig {
    enabled: boolean;
    /** Delivery channels; an empty list disables all delivery. */
    channels: NotifyChannel[];
    /** Quiet time after turn/end before the notification fires. */
    debounceMs: number;
    /** Truncation bound for the assistant-text summary. */
    summaryMaxChars: number;
    /** Prefix for every notification title. */
    titlePrefix: string;
    /** Notify when a turn completes normally. */
    notifyOnCompleted: boolean;
    /** Notify when a turn ends in error. */
    notifyOnError: boolean;
}
declare const Config: z<Schemastery.ObjectS<{
    enabled: z<boolean, boolean>;
    channels: z<({
        type?: "serverchan" | "dingtalk" | "feishu" | "generic" | null | undefined;
        url?: string | null | undefined;
        secret?: string | null | undefined;
        titlePrefix?: string | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
        type: z<"serverchan" | "dingtalk" | "feishu" | "generic", "serverchan" | "dingtalk" | "feishu" | "generic">;
        url: z<string, string>;
        secret: z<string, string>;
        titlePrefix: z<string, string>;
    }>[]>;
    debounceMs: z<number, number>;
    summaryMaxChars: z<number, number>;
    titlePrefix: z<string, string>;
    notifyOnCompleted: z<boolean, boolean>;
    notifyOnError: z<boolean, boolean>;
}>, Schemastery.ObjectT<{
    enabled: z<boolean, boolean>;
    channels: z<({
        type?: "serverchan" | "dingtalk" | "feishu" | "generic" | null | undefined;
        url?: string | null | undefined;
        secret?: string | null | undefined;
        titlePrefix?: string | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<{
        type: z<"serverchan" | "dingtalk" | "feishu" | "generic", "serverchan" | "dingtalk" | "feishu" | "generic">;
        url: z<string, string>;
        secret: z<string, string>;
        titlePrefix: z<string, string>;
    }>[]>;
    debounceMs: z<number, number>;
    summaryMaxChars: z<number, number>;
    titlePrefix: z<string, string>;
    notifyOnCompleted: z<boolean, boolean>;
    notifyOnError: z<boolean, boolean>;
}>>;
/**
 * Mount the notifier: subscribe to the event firehose, debounce, and flush
 * pending notifications on dispose (async cleanup is awaited by Cordis within
 * the shutdown window).
 */
declare function apply(ctx: Context, config: NotifyConfig): void;
export { Config, apply, inject, name };
export { buildMessage, sendNotification, summarize, dingtalkSignature } from './notify.js';
