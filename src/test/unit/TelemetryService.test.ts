import { expect } from 'chai';
import * as sinon from 'sinon';
import * as vscode from 'vscode';

import { TelemetryService } from '../../services/TelemetryService';

function createContext() {
  return {
    subscriptions: [] as any[],
    extensionUri: { fsPath: '/ext' } as any,
    extension: { packageJSON: { version: '0.0.0' } },
    workspaceState: {
      get: () => undefined,
      update: async () => undefined
    },
    globalState: {
      get: () => undefined,
      update: async () => undefined
    },
    secrets: {
      get: async () => undefined,
      store: async () => undefined,
      delete: async () => undefined
    }
  } as any;
}

describe('TelemetryService', () => {
  let sandbox: sinon.SinonSandbox;

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    (TelemetryService as any).instance = undefined;
  });

  afterEach(() => {
    sandbox.restore();
    (TelemetryService as any).instance = undefined;
  });

  it('stays disabled when telemetry mode is off', () => {
    let mode: 'off' | 'basic' | 'detailed' = 'off';

    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string) => {
      if (section === 'postgresExplorer.telemetry') {
        return {
          get: <T>(key: string, defaultValue?: T) => {
            if (key === 'mode') return mode as unknown as T;
            if (key === 'allowUsage') return true as unknown as T;
            if (key === 'allowPerformance') return false as unknown as T;
            return defaultValue as T;
          }
        } as any;
      }

      return {
        get: <T>(_key: string, defaultValue?: T) => defaultValue as T
      } as any;
    });

    sandbox.stub(vscode.env, 'isTelemetryEnabled').value(true);
    const createOutputChannelStub = sandbox.stub(vscode.window, 'createOutputChannel');
    const configurationHandler: { current?: (event: any) => void } = {};
    sandbox.stub(vscode.workspace, 'onDidChangeConfiguration').callsFake((cb: any) => {
      configurationHandler.current = cb;
      return { dispose: () => undefined };
    });

    const service = TelemetryService.getInstance();
    expect(service.isEnabled()).to.be.false;

    const context = createContext();
    service.initialize(context);

    expect(createOutputChannelStub.called).to.be.true;
    expect(context.subscriptions).to.have.lengthOf(1);

    expect(service.startSpan('query.execute')).to.equal('');
    service.recordMetric('rows', 5, 'count');
    expect(service.getSummary()).to.deep.equal({ enabled: false, activeSpans: 0, spanNames: [] });

    mode = 'basic';
    configurationHandler.current?.({ affectsConfiguration: (setting: string) => setting === 'postgresExplorer.telemetry' });
    expect(service.isEnabled()).to.be.true;
  });

  it('records spans and events when telemetry is enabled', async () => {
    let mode: 'off' | 'basic' | 'detailed' = 'detailed';
    let configurationHandler: ((event: any) => void) | undefined;
    const appendLine = sandbox.stub();
    const outputChannel = {
      appendLine,
      show: sandbox.stub(),
      dispose: sandbox.stub()
    } as any;

    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string) => {
      if (section === 'postgresExplorer.telemetry') {
        return {
          get: <T>(key: string, defaultValue?: T) => {
            if (key === 'mode') return mode as unknown as T;
            if (key === 'allowUsage') return true as unknown as T;
            if (key === 'allowPerformance') return true as unknown as T;
            if (key === 'maxBatchSize') return 10 as unknown as T;
            if (key === 'flushIntervalMs') return 5000 as unknown as T;
            return defaultValue as T;
          }
        } as any;
      }

      return {
        get: <T>(_key: string, defaultValue?: T) => defaultValue as T
      } as any;
    });

    sandbox.stub(vscode.workspace, 'onDidChangeConfiguration').callsFake((cb: any) => {
      configurationHandler = cb;
      return { dispose: () => undefined };
    });
    sandbox.stub(vscode.window, 'createOutputChannel').returns(outputChannel);
    sandbox.stub(vscode.env, 'isTelemetryEnabled').value(true);

    const service = TelemetryService.getInstance();
    const context = createContext();
    service.initialize(context);

    expect(context.subscriptions).to.have.lengthOf(1);

    const clock = sandbox.useFakeTimers({ now: 1_000 });

    const spanId = service.startSpan('query.execute', { rows: 1 });
    expect(spanId).to.match(/^query.execute-\d+-/);
    expect(service.getSummary()).to.deep.equal({ enabled: true, activeSpans: 1, spanNames: ['query.execute'] });

    clock.tick(25);
    service.endSpan(spanId, { rows: 2 });

    service.trackEvent('command_invoked', { group: 'connection' });

    const traced = await service.trace('ai.request', async () => 42, { model: 'test' });
    expect(traced).to.equal(42);

    let thrown: Error | undefined;
    try {
      await service.trace('ai.generate', async () => {
        throw new Error('boom');
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown?.message).to.equal('boom');

    const errorSpanId = service.startSpan('query.stream');
    service.recordError(errorSpanId, new Error('failure'));
    expect(service.getSummary().activeSpans).to.equal(0);

    mode = 'off';
    configurationHandler?.({ affectsConfiguration: (setting: string) => setting === 'postgresExplorer.telemetry' });
    expect(service.isEnabled()).to.be.false;

    expect(service.getSummary()).to.deep.equal({ enabled: false, activeSpans: 0, spanNames: [] });
  });

  it('injects version into all tracked events', async () => {
    const appendLine = sandbox.stub();
    const outputChannel = {
      appendLine,
      show: sandbox.stub(),
      dispose: sandbox.stub()
    } as any;

    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string) => {
      if (section === 'postgresExplorer.telemetry') {
        return {
          get: <T>(key: string, defaultValue?: T) => {
            if (key === 'mode') return 'basic' as unknown as T;
            if (key === 'allowUsage') return true as unknown as T;
            if (key === 'allowPerformance') return false as unknown as T;
            return defaultValue as T;
          }
        } as any;
      }

      return {
        get: <T>(_key: string, defaultValue?: T) => defaultValue as T
      } as any;
    });

    sandbox.stub(vscode.workspace, 'onDidChangeConfiguration').returns({ dispose: () => undefined } as any);
    sandbox.stub(vscode.window, 'createOutputChannel').returns(outputChannel);
    sandbox.stub(vscode.env, 'isTelemetryEnabled').value(true);

    const service = TelemetryService.getInstance();
    const context = createContext();
    context.extension.packageJSON.version = '1.2.3';
    service.initialize(context);

    service.trackEvent('command_invoked', { group: 'test' });
    service.trackEvent('extension_activated', {});
    service.trackEvent('daily_active_user', {});

    expect(appendLine.callCount).to.be.greaterThan(0);
    const calls = appendLine.getCalls();
    const lines = calls.map(c => c.args[0] as string);

    lines.forEach(line => {
      if (line.includes('[telemetry]')) {
        expect(line).to.include('"version":"1.2.3"', `Line should contain version: ${line}`);
      }
    });
  });

  it('registers dropped events in EVENT_SCHEMA', async () => {
    const appendLine = sandbox.stub();
    const outputChannel = {
      appendLine,
      show: sandbox.stub(),
      dispose: sandbox.stub()
    } as any;

    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string) => {
      if (section === 'postgresExplorer.telemetry') {
        return {
          get: <T>(key: string, defaultValue?: T) => {
            if (key === 'mode') return 'basic' as unknown as T;
            if (key === 'allowUsage') return true as unknown as T;
            if (key === 'allowPerformance') return false as unknown as T;
            return defaultValue as T;
          }
        } as any;
      }

      return {
        get: <T>(_key: string, defaultValue?: T) => defaultValue as T
      } as any;
    });

    sandbox.stub(vscode.workspace, 'onDidChangeConfiguration').returns({ dispose: () => undefined } as any);
    sandbox.stub(vscode.window, 'createOutputChannel').returns(outputChannel);
    sandbox.stub(vscode.env, 'isTelemetryEnabled').value(true);

    const service = TelemetryService.getInstance();
    const context = createContext();
    service.initialize(context);

    // These should now be accepted (previously silently dropped)
    service.trackEvent('platform_preset_selected', { preset: 'vanilla' });
    service.trackEvent('agentic_loop_started', { provider: 'claude', database: 'testdb' });
    service.trackEvent('agentic_pseudo_tool_call_recovered', { provider: 'claude', count: 2 });
    service.trackEvent('agentic_loop_completed', { provider: 'claude', turns: 3, database: 'testdb', success: true });

    expect(appendLine.callCount).to.be.greaterThan(0);
    const calls = appendLine.getCalls();
    const lines = calls.map(c => c.args[0] as string);

    expect(lines.some(line => line.includes('platform_preset_selected'))).to.be.true;
    expect(lines.some(line => line.includes('agentic_loop_started'))).to.be.true;
    expect(lines.some(line => line.includes('agentic_pseudo_tool_call_recovered'))).to.be.true;
    expect(lines.some(line => line.includes('agentic_loop_completed'))).to.be.true;
  });
});