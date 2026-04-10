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

  it('stays disabled when configuration turns telemetry off', () => {
    let enabled = false;

    sandbox.stub(vscode.workspace, 'getConfiguration').callsFake((section?: string) => {
      if (section === 'postgresExplorer.telemetry') {
        return {
          get: <T>(_key: string, defaultValue?: T) => (enabled as unknown as T) ?? defaultValue as T
        } as any;
      }

      return {
        get: <T>(_key: string, defaultValue?: T) => defaultValue as T
      } as any;
    });

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

    expect(createOutputChannelStub.called).to.be.false;
    expect(context.subscriptions).to.have.lengthOf(1);

    expect(service.startSpan('query.execute')).to.equal('');
    service.recordMetric('rows', 5, 'count');
    expect(service.getSummary()).to.deep.equal({ enabled: false, activeSpans: 0, spanNames: [] });

    enabled = true;
    configurationHandler.current?.({ affectsConfiguration: (setting: string) => setting === 'postgresExplorer.telemetry' });
    expect(service.isEnabled()).to.be.true;
  });

  it('records spans, metrics, and errors when telemetry is enabled', async () => {
    let enabled = true;
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
          get: <T>(_key: string, defaultValue?: T) => (enabled as unknown as T) ?? defaultValue as T
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

    const service = TelemetryService.getInstance();
    const context = createContext();
    service.initialize(context);

    expect(appendLine.firstCall.args[0]).to.contain('Telemetry initialized');
    expect(context.subscriptions).to.have.lengthOf(1);

    const clock = sandbox.useFakeTimers({ now: 1_000 });

    const spanId = service.startSpan('query.execute', { rows: 1 });
    expect(spanId).to.match(/^query.execute-\d+-/);
    expect(service.getSummary()).to.deep.equal({ enabled: true, activeSpans: 1, spanNames: ['query.execute'] });

    clock.tick(25);
    service.endSpan(spanId, { rows: 2 });
    expect(appendLine.getCalls().some((call) => String(call.args[0]).includes('[END] query.execute (25ms)'))).to.be.true;

    service.recordMetric('rows', 10, 'count');
    expect(appendLine.getCalls().some((call) => String(call.args[0]).includes('[METRIC] rows: 10 count'))).to.be.true;

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
    expect(appendLine.getCalls().some((call) => String(call.args[0]).includes('[ERROR] query.stream'))).to.be.true;

    enabled = false;
    configurationHandler?.({ affectsConfiguration: (setting: string) => setting === 'postgresExplorer.telemetry' });
    expect(service.isEnabled()).to.be.false;

    expect(service.getSummary()).to.deep.equal({ enabled: false, activeSpans: 0, spanNames: [] });
  });
});