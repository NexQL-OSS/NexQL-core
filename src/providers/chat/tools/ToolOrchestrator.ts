import * as vscode from 'vscode';
import { ChatMessage, ToolCall } from '../types';
import { ToolExecutor } from './ToolExecutor';
import { DB_TOOLS } from './ToolSpec';
import { extractPseudoToolCalls } from './pseudoToolCallParser';
import { AiService } from '../AiService';
import { debugLog } from '../../../common/logger';
import { TelemetryService } from '../../../services/TelemetryService';

export class ToolOrchestrator {
  private readonly toolExecutor: ToolExecutor;
  private readonly maxTurns = 6;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly aiService: AiService,
    private readonly connectionId: string,
    private readonly databaseName: string
  ) {
    this.toolExecutor = new ToolExecutor(context, connectionId, databaseName);
  }

  async run(
    provider: string,
    initialMessages: ChatMessage[],
    config: vscode.WorkspaceConfiguration,
    customSystemPrompt?: string,
    scope: any = 'chat',
    cancellationToken?: vscode.CancellationToken,
    onTurnComplete?: (messages: ChatMessage[], toolTurns: number) => Promise<void> | void
  ): Promise<{ messages: ChatMessage[]; text: string; usage?: string; toolTurns: number }> {
    const telemetry = TelemetryService.getInstance();
    telemetry.trackEvent('agentic_loop_started', { provider, database: this.databaseName });

    // Work on a copy of messages to keep history mutation controlled
    let currentMessages = [...initialMessages];
    let turns = 0;
    // Turns where the model actually requested tools — the UI reports this, not raw
    // provider round-trips, so a text-only answer shows no "database agent" activity.
    let toolTurns = 0;
    let finalResponseText = '';
    let finalUsage = '';
    let finishedNaturally = false;

    while (turns < this.maxTurns) {
      if (cancellationToken?.isCancellationRequested) {
        debugLog('[ToolOrchestrator] Loop cancelled.');
        break;
      }

      turns++;
      debugLog(`[ToolOrchestrator] Starting turn ${turns}/${this.maxTurns}`);

      // Set the history in AiService before calling provider
      this.aiService.setMessages(currentMessages);

      // Call the AI provider with our database tools passed in
      const response = await this.aiService.callProvider(
        provider,
        '', // userMessage is empty since history is fully populated in setMessages
        config,
        customSystemPrompt,
        scope,
        DB_TOOLS
      );

      if (response.usage) {
        finalUsage = response.usage;
      }

      // Weak/cheap models sometimes narrate a tool invocation as prose or a fenced
      // code block instead of emitting structured tool_calls — recover it here so the
      // tool still runs and the raw pseudo-call never reaches the user.
      if (!response.toolCalls?.length) {
        const recovered = extractPseudoToolCalls(response.text, DB_TOOLS);
        if (recovered.calls.length > 0) {
          debugLog(
            `[ToolOrchestrator] Recovered ${recovered.calls.length} pseudo tool call(s) narrated as text.`
          );
          telemetry.trackEvent('agentic_pseudo_tool_call_recovered', {
            provider,
            count: recovered.calls.length
          });
          response.toolCalls = recovered.calls;
          response.text = recovered.cleanedText;
        }
      }

      finalResponseText = response.text;

      // Check if the provider returned any tool calls
      if (response.toolCalls && response.toolCalls.length > 0) {
        debugLog(`[ToolOrchestrator] Model requested ${response.toolCalls.length} tool calls.`);
        toolTurns++;

        // Add assistant message representing the tool calls
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: response.text || 'Calling database tools...',
          toolCalls: response.toolCalls
        };
        currentMessages.push(assistantMsg);
        if (onTurnComplete) {
          await onTurnComplete(currentMessages, toolTurns);
        }

        // Execute each tool call. A provider's chat-completions API requires every
        // `tool_calls` entry on an assistant message to have a matching `tool` reply
        // on the next turn — if we break out on cancellation without one, the next
        // request (regenerate/resend) sends an unanswered tool_call and the upstream
        // API rejects the whole request with a 400.
        const toolResults: ChatMessage[] = [];
        let cancelled = false;
        for (const call of response.toolCalls) {
          if (cancellationToken?.isCancellationRequested) {
            debugLog('[ToolOrchestrator] Tool execution cancelled.');
            cancelled = true;
            break;
          }

          let resultStr: string;
          try {
            resultStr = await this.toolExecutor.executeTool(call.name, call.arguments);
          } catch (e: any) {
            resultStr = JSON.stringify({ error: e.message || String(e) });
          }

          toolResults.push({
            role: 'tool',
            name: call.name,
            toolCallId: call.id,
            content: resultStr
          });
        }

        if (cancelled) {
          const answeredIds = new Set(toolResults.map((r) => r.toolCallId));
          for (const call of response.toolCalls) {
            if (!answeredIds.has(call.id)) {
              toolResults.push({
                role: 'tool',
                name: call.name,
                toolCallId: call.id,
                content: JSON.stringify({ cancelled: true })
              });
            }
          }
        }

        currentMessages.push(...toolResults);

        if (cancelled) {
          // Cancellation happens mid-turn, before the model produces a final text
          // reply — without this, the transcript is left ending on a `tool` message
          // and the UI's "Running database tools..." placeholder never clears.
          currentMessages.push({ role: 'assistant', content: 'Agent run cancelled.' });
        }

        if (onTurnComplete) {
          await onTurnComplete(currentMessages, toolTurns);
        }

        if (cancelled) {
          break;
        }
      } else {
        // No tool calls: the agent is finished and returned text response
        debugLog('[ToolOrchestrator] Model completed loop with text response.');
        currentMessages.push({
          role: 'assistant',
          content: response.text || ''
        });
        finishedNaturally = true;
        break;
      }
    }

    if (turns >= this.maxTurns && !finishedNaturally) {
      debugLog('[ToolOrchestrator] Warning: Max turn iteration limit reached.');
      const limitMsg: ChatMessage = {
        role: 'assistant',
        content: `Reached the ${this.maxTurns}-step limit for this agentic run. Send "continue" if you'd like the agent to keep going.`
      };
      currentMessages.push(limitMsg);
      finalResponseText = limitMsg.content;
      if (onTurnComplete) {
        await onTurnComplete(currentMessages, toolTurns);
      }
    }

    telemetry.trackEvent('agentic_loop_completed', {
      provider,
      turns,
      database: this.databaseName,
      success: true
    });

    return {
      messages: currentMessages,
      text: finalResponseText,
      usage: finalUsage,
      toolTurns
    };
  }
}
