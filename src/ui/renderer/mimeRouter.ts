import type { ActivationFunction, RendererContext } from 'vscode-notebook-renderer';
import type { NoticeLogEntry } from '../../common/types';
import {
  renderNoticesLiveStream,
} from '../../renderer/components/notices/NoticesPanel';
import { createTopBar, type TopBarOptions } from '../../renderer/components/TopBar';
import type { SentinelNotebookHeaderPayload } from '../../features/sentinel/types';
import { renderPostgresNotebookResult } from './queryResult/renderQueryResult';

const HEADER_MIME = 'application/x-postgres-notebook-header+json';

function payloadToTopBarOptions(payload: SentinelNotebookHeaderPayload): TopBarOptions {
  return {
    connectionName: payload.connectionName,
    host: payload.host,
    port: payload.port,
    database: payload.database,
    username: payload.username,
    environment: payload.environment,
    readOnlyMode: payload.readOnlyMode,
    isConnected: payload.isConnected,
    showContextStrip: payload.enabled,
    onRunAll: () => { /* wired via postMessage below */ },
    onClearOutputs: () => {},
    onAddCodeCell: () => {},
    onAddMarkdownCell: () => {},
  };
}

function renderNotebookHeader(
  context: RendererContext<void>,
  payload: SentinelNotebookHeaderPayload,
  element: HTMLElement,
): void {
  element.replaceChildren();

  if (!payload.enabled) {
    return;
  }

  const postMessage = (msg: unknown) => {
    void context.postMessage?.(msg);
  };

  const options = payloadToTopBarOptions(payload);
  options.onRunAll = () => postMessage({ type: 'runAll' });
  options.onClearOutputs = () => postMessage({ type: 'clearOutputs' });
  options.onAddCodeCell = () => postMessage({ type: 'addCodeCell' });
  options.onAddMarkdownCell = () => postMessage({ type: 'addMarkdownCell' });

  element.appendChild(createTopBar(options, postMessage));
}

export const activate: ActivationFunction = (context) => {
  let headerElement: HTMLElement | undefined;

  context.onDidReceiveMessage?.((message: unknown) => {
    if (
      typeof message === 'object'
      && message !== null
      && (message as { type?: string }).type === 'sentinel/header'
      && headerElement
    ) {
      const payload = (message as { payload: SentinelNotebookHeaderPayload }).payload;
      renderNotebookHeader(context, payload, headerElement);
    }
  });

  return {
    renderOutputItem(data, element) {
      if (data.mime === HEADER_MIME) {
        const payload = data.json() as SentinelNotebookHeaderPayload;
        headerElement = element;
        renderNotebookHeader(context, payload, element);
        return;
      }

      if (data.mime === 'application/vnd.postgres-notebook.notices-live') {
        const live = data.json() as { notices?: NoticeLogEntry[] };
        const entries = Array.isArray(live?.notices) ? live.notices : [];
        element.replaceChildren(renderNoticesLiveStream(entries));
        return;
      }

      renderPostgresNotebookResult(context, data, element);
    },
  };
};
