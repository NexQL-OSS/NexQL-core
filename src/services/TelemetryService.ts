import * as https from 'https';
import * as vscode from 'vscode';

type TelemetryValue = string | number | boolean;
type TelemetryMode = 'off' | 'basic' | 'detailed';
type TelemetryEventKind = 'usage' | 'performance';

const DEFAULT_FLUSH_INTERVAL_MS = 10_000;
const DEFAULT_MAX_BATCH_SIZE = 25;
/** Cap queued envelopes so bursty callers cannot grow memory unbounded; oldest dropped first. */
const MAX_QUEUED_EVENTS = 500;
const MAX_PROPERTY_VALUE_LENGTH = 200;
const REDACTED_VALUE = '[redacted]';

const SENSITIVE_KEY_PATTERN = /(password|secret|token|authorization|cookie|sql|query|database|schema|host|user|email|name|credential|connection)/i;

const EVENT_SCHEMA: Record<string, { kind: TelemetryEventKind; allowedProps: Set<string> }> = {
  extension_activated: { kind: 'usage', allowedProps: new Set(['version']) },
  extension_deactivated: { kind: 'usage', allowedProps: new Set(['durationBucket']) },
  command_invoked: { kind: 'usage', allowedProps: new Set(['group']) },
  command_repeat_rate: { kind: 'usage', allowedProps: new Set(['command', 'repeatCountBucket']) },
  feature_used: { kind: 'usage', allowedProps: new Set(['feature']) },
  connection_opened: { kind: 'usage', allowedProps: new Set(['connectionKind']) },
  connection_closed: { kind: 'usage', allowedProps: new Set(['reason']) },
  connection_error: { kind: 'usage', allowedProps: new Set(['errorCategory']) },
  error_captured: { kind: 'usage', allowedProps: new Set(['errorType', 'errorMessage', 'errorContext']) },
  cloud_auth_selected: { kind: 'usage', allowedProps: new Set(['authKind']) },
  query_executed: { kind: 'performance', allowedProps: new Set(['success', 'durationBucket', 'resultSizeBucket']) },
  ai_request: { kind: 'usage', allowedProps: new Set(['provider', 'success', 'providerUsageCount']) },
  nexql_free_request: { kind: 'usage', allowedProps: new Set(['model', 'success', 'tier']) },
  ai_settings_error: { kind: 'usage', allowedProps: new Set(['errorType', 'errorMessage']) },
  notebook_executed: { kind: 'usage', allowedProps: new Set(['cellCountBucket']) },
  saved_query_used: { kind: 'usage', allowedProps: new Set(['queryAgeBucket', 'querySize']) },
  schema_diff_generated: { kind: 'usage', allowedProps: new Set(['tableCountBucket', 'diffSizeBucket']) },
  dashboard_opened: { kind: 'usage', allowedProps: new Set([]) },
  gate_decision: { kind: 'usage', allowedProps: new Set(['feature', 'enforcement', 'allowed', 'paid']) },
  daily_active_user: { kind: 'usage', allowedProps: new Set(['version']) },
  span_completed: { kind: 'performance', allowedProps: new Set(['spanName', 'durationBucket', 'success']) },
  sync_setup_completed: { kind: 'usage', allowedProps: new Set(['provider']) },
  sync_run: { kind: 'usage', allowedProps: new Set(['pushed', 'pulled', 'conflicts', 'skipped', 'durationMs', 'provider']) },
  sync_failure: { kind: 'usage', allowedProps: new Set(['failureClass', 'provider']) },
  sentinel_gate_open: { kind: 'usage', allowedProps: new Set(['environment']) },
  sentinel_transition: { kind: 'usage', allowedProps: new Set(['fromEnv', 'toEnv']) },
  sentinel_settings_change: { kind: 'usage', allowedProps: new Set(['key']) },
};

interface TelemetryEnvelope {
  event: string;
  timestamp: string;
  distinctId: string;
  properties: Record<string, TelemetryValue>;
}

interface SpanData {
  name: string;
  startTime: number;
  attributes: Record<string, TelemetryValue>;
}

interface TelemetryConfig {
  mode: TelemetryMode;
  allowUsage: boolean;
  allowPerformance: boolean;
  flushIntervalMs: number;
  maxBatchSize: number;
  posthogApiKey: string;
  posthogHost: string;
}

interface TelemetrySink {
  send(events: TelemetryEnvelope[]): Promise<void>;
  dispose(): void;
}

class DebugSink implements TelemetrySink {
  constructor(private readonly output: vscode.OutputChannel) {}

  async send(events: TelemetryEnvelope[]): Promise<void> {
    for (const event of events) {
      this.output.appendLine(`[telemetry] ${event.event} ${JSON.stringify(event.properties)}`);
    }
  }

  dispose(): void {
    // no-op
  }
}

class PostHogSink implements TelemetrySink {
  constructor(private readonly host: string, private readonly apiKey: string) {}

  async send(events: TelemetryEnvelope[]): Promise<void> {
    if (events.length === 0) {
      return;
    }

    const url = new URL('/capture/', this.host);
    const payload = {
      api_key: this.apiKey,
      batch: events.map((event) => ({
        event: event.event,
        distinct_id: event.distinctId,
        properties: {
          ...event.properties,
          timestamp: event.timestamp,
        },
      })),
    };

    await new Promise<void>((resolve, reject) => {
      const requestBody = JSON.stringify(payload);
      const req = https.request({
        hostname: url.hostname,
        port: url.port ? Number(url.port) : 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(requestBody),
        },
      }, (res) => {
        res.resume();
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`PostHog responded with status ${res.statusCode}`));
          return;
        }
        resolve();
      });

      req.on('error', reject);
      req.write(requestBody);
      req.end();
    });
  }

  dispose(): void {
    // no-op
  }
}

export class TelemetryService {
  private static instance: TelemetryService;
  private outputChannel: vscode.OutputChannel | null = null;
  private context: vscode.ExtensionContext | null = null;
  private spans: Map<string, SpanData> = new Map();
  private queue: TelemetryEnvelope[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private sinks: TelemetrySink[] = [];
  private installId = '';
  private sessionStartMs = Date.now();
  private lastCommand = '';
  private commandRepeatCount = 0;
  private lastDailyActiveDate = '';
  private aiProviderUsageMap: Map<string, number> = new Map();
  private config: TelemetryConfig = {
    mode: 'off',
    allowUsage: true,
    allowPerformance: false,
    flushIntervalMs: DEFAULT_FLUSH_INTERVAL_MS,
    maxBatchSize: DEFAULT_MAX_BATCH_SIZE,
    posthogApiKey: '',
    posthogHost: 'https://us.i.posthog.com',
  };

  private constructor() {}

  public static getInstance(): TelemetryService {
    if (!TelemetryService.instance) {
      TelemetryService.instance = new TelemetryService();
    }
    return TelemetryService.instance;
  }

  public initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    this.sessionStartMs = Date.now();
    this.installId = this.resolveInstallId(context);
    this.outputChannel = vscode.window.createOutputChannel('NexQL Telemetry');
    this.loadSettings();
    this.rebuildSinks();
    this.startFlushTimer();

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('postgresExplorer.telemetry')) {
          this.loadSettings();
          this.rebuildSinks();
        }
      }),
      {
        dispose: () => {
          void this.flush();
          this.stopFlushTimer();
          this.disposeSinks();
        },
      },
    );
  }

  public isEnabled(): boolean {
    return this.config.mode !== 'off' && this.config.allowUsage && vscode.env.isTelemetryEnabled;
  }

  public trackEvent(event: string, properties?: Record<string, TelemetryValue>): void {
    const schema = EVENT_SCHEMA[event];
    if (!schema || !this.isTelemetryAllowedFor(schema.kind)) {
      return;
    }

    const sanitized = this.sanitizeProperties(schema.allowedProps, properties ?? {});
    const envelope: TelemetryEnvelope = {
      event,
      timestamp: new Date().toISOString(),
      distinctId: this.installId,
      properties: {
        mode: this.config.mode,
        ...sanitized,
      },
    };

    this.queue.push(envelope);
    if (this.queue.length > MAX_QUEUED_EVENTS) {
      const overflow = this.queue.length - MAX_QUEUED_EVENTS;
      this.queue.splice(0, overflow);
    }
    if (this.queue.length >= this.config.maxBatchSize) {
      void this.flush();
    }
  }

  public async flush(): Promise<void> {
    if (this.queue.length === 0 || this.sinks.length === 0) {
      return;
    }

    const batch = this.queue.splice(0, this.config.maxBatchSize);
    for (const sink of this.sinks) {
      try {
        await sink.send(batch);
      } catch (error) {
        this.outputChannel?.appendLine(`[telemetry] sink send failed: ${String(error)}`);
      }
    }
  }

  /** One usage event on shutdown; avoids duplicate session_ended + extension_deactivated. */
  public trackExtensionDeactivate(): void {
    const bucket = this.bucketDuration(Date.now() - this.sessionStartMs);
    this.trackEvent('extension_deactivated', { durationBucket: bucket });
  }

  /** Public so callers can align performance buckets with span/query telemetry. */
  public durationBucket(durationMs: number): string {
    return this.bucketDuration(durationMs);
  }

  public startSpan(name: string, attributes?: Record<string, TelemetryValue>): string {
    if (!this.isTelemetryAllowedFor('performance')) {
      return '';
    }
    const spanId = `${name}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    this.spans.set(spanId, {
      name,
      startTime: Date.now(),
      attributes: attributes ?? {},
    });
    return spanId;
  }

  public endSpan(spanId: string, attributes?: Record<string, TelemetryValue>): void {
    if (!spanId) {
      return;
    }
    const span = this.spans.get(spanId);
    if (!span) {
      return;
    }

    const durationMs = Date.now() - span.startTime;
    this.trackEvent('span_completed', {
      spanName: span.name,
      durationBucket: this.bucketDuration(durationMs),
      success: true,
      ...span.attributes,
      ...(attributes ?? {}),
    });
    this.spans.delete(spanId);
  }

  public recordError(spanId: string, error: Error): void {
    if (!spanId) {
      return;
    }
    const span = this.spans.get(spanId);
    if (!span) {
      return;
    }

    const durationMs = Date.now() - span.startTime;
    this.trackEvent('span_completed', {
      spanName: span.name,
      durationBucket: this.bucketDuration(durationMs),
      success: false,
    });
    this.spans.delete(spanId);
  }

  public recordMetric(name: string, value: number, unit?: string): void {
    this.trackEvent('feature_used', { feature: `metric:${name}:${unit ?? 'count'}:${value}` });
  }

  public async trace<T>(name: string, fn: () => Promise<T>, attributes?: Record<string, TelemetryValue>): Promise<T> {
    const spanId = this.startSpan(name, attributes);
    try {
      const result = await fn();
      this.endSpan(spanId);
      return result;
    } catch (error) {
      this.recordError(spanId, error as Error);
      throw error;
    }
  }

  public getSummary(): TelemetrySummary {
    return {
      enabled: this.isEnabled(),
      activeSpans: this.spans.size,
      spanNames: Array.from(this.spans.values()).map((s) => s.name),
    };
  }

  /**
   * Track command repeat - captures if same command invoked consecutively
   */
  public trackCommandRepeat(commandName: string): void {
    if (commandName === this.lastCommand) {
      this.commandRepeatCount++;
    } else {
      if (this.lastCommand && this.commandRepeatCount > 0) {
        const bucket = this.bucketCommandRepeatCount(this.commandRepeatCount);
        this.trackEvent('command_repeat_rate', {
          command: this.lastCommand,
          repeatCountBucket: bucket,
        });
      }
      this.lastCommand = commandName;
      this.commandRepeatCount = 0;
    }
  }

  /**
   * Track generic errors with type, message, and context
   */
  public trackError(errorType: string, errorMessage: string, errorContext?: string): void {
    this.trackEvent('error_captured', {
      errorType,
      errorMessage: this.truncateString(errorMessage, 100),
      ...(errorContext && { errorContext: this.truncateString(errorContext, 100) }),
    });
  }

  /**
   * Track saved query usage with age and size info
   */
  public trackSavedQueryUsed(queryAgeBucket: string, querySize?: number): void {
    this.trackEvent('saved_query_used', {
      queryAgeBucket,
      ...(querySize !== undefined && { querySize: this.bucketQuerySize(querySize) }),
    });
  }

  /**
   * Track schema diff generation with table count and diff size
   */
  public trackSchemaDiffGenerated(tableCountBucket: string, diffSizeBucket?: string): void {
    this.trackEvent('schema_diff_generated', {
      tableCountBucket,
      ...(diffSizeBucket && { diffSizeBucket }),
    });
  }

  /**
   * Track dashboard open event
   */
  public trackDashboardOpened(): void {
    this.trackEvent('dashboard_opened', {});
  }

  /**
   * Track a license gate decision so feature-gating conversion can be measured.
   * `feature` is the ProFeature key, `enforcement` is off/soft/hard, `allowed`
   * whether the feature proceeded, `paid` the current entitlement state.
   */
  public trackGateDecision(feature: string, enforcement: string, allowed: boolean, paid: boolean): void {
    this.trackEvent('gate_decision', { feature, enforcement, allowed, paid });
  }

  /**
   * Track daily active user - fires once per calendar day
   */
  public trackDailyActiveUser(version: string): void {
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
    if (today !== this.lastDailyActiveDate) {
      this.lastDailyActiveDate = today;
      this.trackEvent('daily_active_user', { version });
    }
  }

  /**
   * Track AI settings panel error
   */
  public trackAiSettingsError(errorType: string, errorMessage: string): void {
    this.trackEvent('ai_settings_error', {
      errorType,
      errorMessage: this.truncateString(errorMessage, 100),
    });
  }

  /**
   * Track AI provider usage and increment counter
   */
  public trackAiProviderUsage(provider: string): number {
    const count = (this.aiProviderUsageMap.get(provider) ?? 0) + 1;
    this.aiProviderUsageMap.set(provider, count);
    return count;
  }

  /**
   * Get AI provider usage count for tracking
   */
  public getAiProviderUsageCount(provider: string): number {
    return this.aiProviderUsageMap.get(provider) ?? 0;
  }

  /**
   * Track NexQL-free AI request with model and tier info
   */
  public trackNexqlFreeRequest(model: string, success: boolean): void {
    const tier = model === 'smart' ? 'free' : model === 'engineer' ? 'sponsor' : 'singularity';
    this.trackEvent('nexql_free_request', { model, success, tier });
  }

  private bucketCommandRepeatCount(count: number): string {
    if (count === 1) return 'once';
    if (count < 5) return 'lt_5';
    if (count < 10) return '5_10';
    if (count < 20) return '10_20';
    return 'gte_20';
  }

  private bucketQuerySize(sizeBytes: number): string {
    if (sizeBytes < 1024) return 'lt_1kb';
    if (sizeBytes < 10 * 1024) return '1_10kb';
    if (sizeBytes < 100 * 1024) return '10_100kb';
    if (sizeBytes < 1024 * 1024) return '100kb_1mb';
    return 'gte_1mb';
  }

  private truncateString(str: string, maxLen: number): string {
    return str.length > maxLen ? str.slice(0, maxLen) : str;
  }

  private loadSettings(): void {
    const config = vscode.workspace.getConfiguration('postgresExplorer.telemetry');
    const legacyEnabled = config.get<boolean>('enabled', false);
    const mode = config.get<TelemetryMode>('mode', legacyEnabled ? 'basic' : 'off');
    this.config = {
      mode,
      allowUsage: config.get<boolean>('allowUsage', true),
      allowPerformance: config.get<boolean>('allowPerformance', mode === 'detailed'),
      flushIntervalMs: config.get<number>('flushIntervalMs', DEFAULT_FLUSH_INTERVAL_MS),
      maxBatchSize: config.get<number>('maxBatchSize', DEFAULT_MAX_BATCH_SIZE),
      posthogApiKey: config.get<string>('posthogApiKey', 'phc_ok5KcqPzWKC52rJHJV8Q9ALQWPKQYukgPFJj56WP8s9N'),
      posthogHost: config.get<string>('posthogHost', 'https://us.i.posthog.com'),
    };
  }

  private rebuildSinks(): void {
    this.disposeSinks();
    if (!this.outputChannel) {
      return;
    }
    this.sinks.push(new DebugSink(this.outputChannel));
    if (this.isEnabled() && this.config.posthogApiKey.trim()) {
      this.sinks.push(new PostHogSink(this.config.posthogHost, this.config.posthogApiKey.trim()));
    }
  }

  private disposeSinks(): void {
    for (const sink of this.sinks) {
      sink.dispose();
    }
    this.sinks = [];
  }

  private startFlushTimer(): void {
    this.stopFlushTimer();
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.config.flushIntervalMs);
    this.flushTimer.unref();
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  private resolveInstallId(context: vscode.ExtensionContext): string {
    const key = 'postgresExplorer.telemetry.installId.v1';
    const existing = context.globalState.get<string>(key);
    if (existing) {
      return existing;
    }
    const created = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    void context.globalState.update(key, created);
    return created;
  }

  private isTelemetryAllowedFor(kind: TelemetryEventKind): boolean {
    if (!vscode.env.isTelemetryEnabled || this.config.mode === 'off') {
      return false;
    }
    if (kind === 'usage') {
      return this.config.allowUsage;
    }
    if (kind === 'performance') {
      return this.config.mode === 'detailed' || this.config.allowPerformance;
    }
    return false;
  }

  private sanitizeProperties(allowedProps: Set<string>, properties: Record<string, TelemetryValue>): Record<string, TelemetryValue> {
    const sanitized: Record<string, TelemetryValue> = {};
    for (const [key, value] of Object.entries(properties)) {
      if (!allowedProps.has(key)) {
        continue;
      }
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        sanitized[key] = REDACTED_VALUE;
        continue;
      }
      sanitized[key] = this.sanitizeValue(value);
    }
    return sanitized;
  }

  private sanitizeValue(value: TelemetryValue): TelemetryValue {
    if (typeof value === 'string') {
      const normalized = value.trim();
      if (normalized.length > MAX_PROPERTY_VALUE_LENGTH) {
        return normalized.slice(0, MAX_PROPERTY_VALUE_LENGTH);
      }
      return normalized;
    }
    return value;
  }

  private bucketDuration(durationMs: number): string {
    if (durationMs < 100) return 'lt_100ms';
    if (durationMs < 500) return '100_500ms';
    if (durationMs < 1_000) return '500ms_1s';
    if (durationMs < 5_000) return '1_5s';
    if (durationMs < 30_000) return '5_30s';
    return 'gte_30s';
  }
}

export interface TelemetrySummary {
  enabled: boolean;
  activeSpans: number;
  spanNames: string[];
}

export const SpanNames = {
  QUERY_EXECUTE: 'query.execute',
  QUERY_STREAM: 'query.stream',
  POOL_ACQUIRE: 'pool.acquire',
  POOL_RELEASE: 'pool.release',
  AI_REQUEST: 'ai.request',
  AI_GENERATE: 'ai.generate',
  AI_OPTIMIZE: 'ai.optimize',
  EXTENSION_ACTIVATE: 'extension.activate',
  TREE_REFRESH: 'tree.refresh',
  NOTEBOOK_EXECUTE: 'notebook.execute',
  EXPORT_DATA: 'export.data',
} as const;
