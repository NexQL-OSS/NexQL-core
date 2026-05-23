/**
 * Handles paginated FETCH requests for sliding-window SELECT results (SCROLL cursor).
 */

import * as vscode from 'vscode';
import { IMessageHandler } from '../MessageHandler';
import { ResultCursorService } from '../ResultCursorService';
import { safelyPostMessage } from './messaging';

export class CursorWindowHandler implements IMessageHandler {
  async handle(
    message: {
      type: string;
      requestId: string;
      sessionId: string;
      pageStartRow: number;
    },
    context: {
      postMessage?: (msg: any) => Thenable<boolean>;
    }
  ): Promise<void> {
    const postMessage = context.postMessage;
    if (!postMessage) {
      return;
    }

    const { requestId, sessionId, pageStartRow } = message;
    const start =
      typeof pageStartRow === 'number' && Number.isFinite(pageStartRow)
        ? Math.max(1, Math.floor(pageStartRow))
        : 1;

    try {
      const page = await ResultCursorService.fetchPage(sessionId, start);
      if (!page) {
        await safelyPostMessage(
          postMessage,
          {
            type: 'resultCursorResponse',
            requestId,
            sessionId,
            error: 'Cursor session expired or closed. Re-run the query to refresh results.',
            rows: [],
            windowStartRow: start,
            hasMoreBefore: false,
            hasMoreAfter: false,
            slidingWindow: undefined,
          },
          { contextLabel: 'Cursor window', notifyOnFailure: false },
        );
        return;
      }

      await safelyPostMessage(
        postMessage,
        {
          type: 'resultCursorResponse',
          requestId,
          sessionId,
          rows: page.rows,
          windowStartRow: page.windowStartRow,
          hasMoreBefore: page.hasMoreBefore,
          hasMoreAfter: page.hasMoreAfter,
          slidingWindow: {
            sessionId,
            windowStartRow: page.windowStartRow,
            windowSize: page.windowSize,
            hasMoreBefore: page.hasMoreBefore,
            hasMoreAfter: page.hasMoreAfter,
            totalRows: (page as any).totalRows,
            countAttempted: (page as any).countAttempted,
            countError: (page as any).countError,
          },
        },
        { contextLabel: 'Cursor window', notifyOnFailure: false },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await vscode.window.showWarningMessage(`Could not load result page: ${msg}`);
      await safelyPostMessage(
        postMessage,
        {
          type: 'resultCursorResponse',
          requestId,
          sessionId,
          error: msg,
          rows: [],
          windowStartRow: start,
          hasMoreBefore: false,
          hasMoreAfter: false,
        },
        { contextLabel: 'Cursor window', notifyOnFailure: false },
      );
    }
  }
}
