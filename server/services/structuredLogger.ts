/**
 * AICLIPER Fase 0B — Structured JSON Logger with Automatic Secret Redaction
 *
 * Ensures every cloud/worker/dispatcher/API lifecycle event is logged in
 * Cloud Logging-compatible structured JSON while strictly redacting tokens,
 * passwords, private keys, API keys, cookies, and authorization headers.
 */

export type LogSeverity = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

const SENSITIVE_KEY_PATTERN =
  /(?:token|password|passwd|secret|apikey|api_key|authorization|auth_header|cookie|private_key|privatekey|credential|client_secret|refresh_token|access_token|id_token|gcp_access_token|sql_password)/i;

const BEARER_OR_JWT_PATTERN =
  /(?:Bearer\s+[A-Za-z0-9._\-+/=]+|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|ya29\.[A-Za-z0-9._-]{12,}|AIza[0-9A-Za-z_-]{20,})/g;

export function redactSensitiveString(input: string): string {
  return input.replace(BEARER_OR_JWT_PATTERN, '[REDACTED]');
}

export function redactSensitiveData(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return redactSensitiveString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactSensitiveString(value.message),
      code: (value as { code?: unknown }).code,
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveData(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = redactSensitiveData(val, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

export function sanitizeCorrelationId(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const cleaned = String(raw)
    .trim()
    .replace(/[^a-zA-Z0-9._:-]/g, '')
    .slice(0, 128);
  return cleaned || undefined;
}

export interface StructuredLogPayload {
  service: string;
  event: string;
  severity?: LogSeverity;
  correlationId?: string;
  renderJobId?: string;
  userUid?: string;
  clipId?: string;
  executionName?: string;
  renderProfile?: string;
  renderFingerprint?: string;
  sourceFingerprint?: string;
  queueTaskName?: string;
  stage?: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  retryCount?: number;
  errorCode?: string;
  errorMessage?: string;
  [key: string]: unknown;
}

export function formatStructuredLog(payload: StructuredLogPayload): string {
  const sanitized = redactSensitiveData(payload) as Record<string, unknown>;
  const entry = {
    timestamp: new Date().toISOString(),
    severity: payload.severity ?? 'INFO',
    ...sanitized,
  };
  return JSON.stringify(entry);
}

export function logStructuredEvent(payload: StructuredLogPayload): string {
  const serialized = formatStructuredLog(payload);
  const sev = payload.severity ?? 'INFO';
  if (sev === 'ERROR') {
    console.error(serialized);
  } else if (sev === 'WARNING') {
    console.warn(serialized);
  } else if (process.env.AICLIPER_SILENCE_INFO_LOGS !== 'true') {
    console.log(serialized);
  }
  return serialized;
}
