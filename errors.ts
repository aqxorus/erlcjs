import { ErrorCode, isPrivateServerOfflineError } from './types.js';
import type { APIError } from './types.js';

export class PRCAPIError extends Error {
  code?: number;
  status?: number;
  statusText?: string;
  retryAfter?: number;
  method?: string;
  path?: string;
  url?: string;
  responseBody?: string;

  constructor(params: {
    code?: number;
    message: string;
    status?: number;
    statusText?: string;
    retryAfter?: number;
    method?: string;
    path?: string;
    url?: string;
    responseBody?: string;
  }) {
    super(params?.message || 'PRC API Error');
    this.name = 'PRCAPIError';

    this.code = params?.code;
    this.status = params?.status;
    this.statusText = params?.statusText;
    this.retryAfter = params?.retryAfter;

    this.method = params?.method;
    this.path = params?.path;
    this.url = params?.url;
    this.responseBody = params?.responseBody;
  }

  static fromResponse(
    response: Response,
    body: any,
    request: { method?: string; path?: string; url?: string } = {},
    rawText: string = ''
  ): PRCAPIError {
    const code = body?.code ?? body?.errorCode ?? 0;
    const message =
      body?.message ||
      body?.error ||
      body?.Error ||
      `HTTP ${response?.status || 0}: ${response?.statusText || 'Error'}`;

    let retryAfterMs: number | undefined;
    if (typeof body?.retry_after === 'number' && body.retry_after > 0) {
      retryAfterMs = Math.max(0, Math.round(body.retry_after * 1000));
    }

    return new PRCAPIError({
      code,
      message,
      status: response?.status,
      statusText: response?.statusText,
      retryAfter: retryAfterMs,
      method: request?.method,
      path: request?.path,
      url: request?.url || response?.url,
      responseBody: rawText ? rawText.slice(0, 1024) : undefined,
    });
  }

  get isRateLimit(): boolean {
    return this.code === ErrorCode.RATE_LIMITED || this.status === 429;
  }

  get isServerOffline(): boolean {
    return (
      this.code === ErrorCode.SERVER_OFFLINE ||
      isPrivateServerOfflineError(this)
    );
  }

  get isAuthError(): boolean {
    const authErrors = [
      ErrorCode.NO_SERVER_KEY,
      ErrorCode.INVALID_SERVER_KEY_FORMAT,
      ErrorCode.INVALID_SERVER_KEY,
      ErrorCode.INVALID_GLOBAL_KEY,
      ErrorCode.BANNED_SERVER_KEY,
    ];
    return authErrors.includes(this.code as any);
  }

  get isRetryable(): boolean {
    const retryableErrors = [
      ErrorCode.ROBLOX_ERROR,
      ErrorCode.INTERNAL_ERROR,
      ErrorCode.RATE_LIMITED,
      ErrorCode.SERVER_OFFLINE,
    ];
    return retryableErrors.includes(this.code as any);
  }
}
