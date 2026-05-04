import type { ActivationFunction } from 'vscode-notebook-renderer';
import type { NoticeLogEntry } from '../../common/types';
import {
  renderNoticesLiveStream,
} from '../../renderer/components/notices/NoticesPanel';
import { renderPostgresNotebookResult } from './queryResult/renderQueryResult';

export const activate: ActivationFunction = (context) => ({
  renderOutputItem(data, element) {
    if (data.mime === 'application/x-postgres-notebook-header+json') {
      element.innerHTML = '';
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
});
