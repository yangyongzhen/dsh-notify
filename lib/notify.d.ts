import type { SessionEvent } from '@deepseek-ai/dsh-session';
/** One configured delivery channel. */
export interface NotifyChannel {
    /** Channel flavor; selects the payload shape. */
    type: 'serverchan' | 'dingtalk' | 'feishu' | 'generic';
    /** Webhook endpoint. */
    url: string;
    /** DingTalk signed-mode secret; ignored by other channels. */
    secret?: string;
    /** Optional prefix for the notification title. */
    titlePrefix?: string;
}
/** Aggregated facts about the turn that just finished. */
export interface NotifySummary {
    sessionId: string;
    model?: string;
    turns: number;
    toolCalls: number;
    tokens: {
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
    };
    durationMs: number;
    reason?: string;
    lastAssistantText: string;
    createdAt?: number;
}
/** Aggregate turn facts from the session event log. */
export declare function summarize(events: readonly SessionEvent[]): NotifySummary;
/** Build the human-readable notification message body. */
export declare function buildMessage(summary: NotifySummary, maxChars: number, titlePrefix: string): {
    title: string;
    content: string;
};
/** DingTalk signed-mode query suffix (timestamp + hmac-sha256 signature). */
export declare function dingtalkSignature(secret: string): string;
/**
 * Deliver one notification to one channel. Resolves when the HTTP request
 * completes; rejects with a readable error when the endpoint fails.
 */
export declare function sendNotification(channel: NotifyChannel, message: {
    title: string;
    content: string;
}): Promise<void>;
