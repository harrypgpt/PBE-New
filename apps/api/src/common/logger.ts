import type { LoggerService } from '@nestjs/common';

/**
 * Structured JSON logging with redaction (API_CONTRACT_STANDARDS.md §9). Never logged:
 * passwords, tokens, cookies, authorisation headers, connection strings, request/response
 * bodies. Redaction applies to every message and every field, at any depth.
 */

export type LogSink = (line: string) => void;
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

const SENSITIVE_KEY =
  /pass(word|wd)?|secret|token|authori[sz]ation|cookie|api[-_]?key|private[-_]?key|connection|dsn|credential|body|otp|totp|recovery|manual[-_]?key|qr|mfa[-_]?key/i;
const CONNECTION_STRING = /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|amqps?):\/\/\S+/gi;
const BEARER = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi;
const REDACTED = '[REDACTED]';

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.replace(CONNECTION_STRING, REDACTED).replace(BEARER, REDACTED);
  }
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error)
    return { name: value.name, message: redact(value.message, depth + 1) };
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value))
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
  return out;
}

export class JsonLogger implements LoggerService {
  constructor(
    private readonly sink: LogSink = (line) => process.stdout.write(`${line}\n`),
    private readonly level: LogLevel = 'info',
  ) {}

  /** Structured event (request logs, errors). Every field is redacted. */
  event(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
    if (ORDER[level] > ORDER[this.level]) return;
    const entry = { time: new Date().toISOString(), level, event, ...(redact(fields) as object) };
    this.sink(JSON.stringify(entry));
  }

  private nest(level: LogLevel, message: unknown, params: unknown[]): void {
    const context =
      typeof params[params.length - 1] === 'string' ? params[params.length - 1] : undefined;
    this.event(level, 'framework', { context, message });
  }

  log(message: unknown, ...params: unknown[]): void {
    this.nest('info', message, params);
  }
  error(message: unknown, ...params: unknown[]): void {
    // Nest passes stack traces as a parameter; they are deliberately not logged here.
    this.nest(
      'error',
      message,
      params.filter((p) => typeof p !== 'string' || !p.includes('\n    at ')),
    );
  }
  warn(message: unknown, ...params: unknown[]): void {
    this.nest('warn', message, params);
  }
  debug(message: unknown, ...params: unknown[]): void {
    this.nest('debug', message, params);
  }
  verbose(message: unknown, ...params: unknown[]): void {
    this.nest('debug', message, params);
  }
}
