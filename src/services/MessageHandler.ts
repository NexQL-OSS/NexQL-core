import * as vscode from 'vscode';
import { HandlerMessageBase } from '../core/types/handlerMessages';
import { debugWarn } from '../common/logger';

export interface MessageEnvelope extends HandlerMessageBase {
  [key: string]: unknown;
}

export interface MessageHandlerContext {
  editor?: vscode.NotebookEditor | undefined;
  webview?: vscode.Webview | undefined;
  postMessage?: (message: unknown) => Thenable<boolean>;
  [key: string]: unknown;
}

export interface IMessageHandler {
  handle(message: any, context: MessageHandlerContext): Promise<void>;
}

export class MessageHandlerRegistry {
  private static instance: MessageHandlerRegistry;
  private handlers: Map<string, IMessageHandler> = new Map();

  private constructor() { }

  public static getInstance(): MessageHandlerRegistry {
    if (!MessageHandlerRegistry.instance) {
      MessageHandlerRegistry.instance = new MessageHandlerRegistry();
    }
    return MessageHandlerRegistry.instance;
  }

  public register(type: string, handler: IMessageHandler) {
    if (this.handlers.has(type)) {
      debugWarn(`Overwriting handler for message type: ${type}`);
    }
    this.handlers.set(type, handler);
  }

  private isValidEnvelope(message: unknown): message is MessageEnvelope {
    return (
      typeof message === 'object' &&
      message !== null &&
      typeof (message as MessageEnvelope).type === 'string' &&
      (message as MessageEnvelope).type.trim().length > 0
    );
  }

  public async handleMessage(message: unknown, context: MessageHandlerContext) {
    if (!this.isValidEnvelope(message)) {
      debugWarn('Rejected invalid message envelope:', message);
      return;
    }

    const handler = this.handlers.get(message.type);
    if (handler) {
      try {
        await handler.handle(message, context);
      } catch (error) {
        console.error(`Error handling message ${message.type}:`, error);
        vscode.window.showErrorMessage(`Error processing ${message.type}: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      debugWarn(`No handler registered for message type: ${message.type}`);
    }
  }
}
