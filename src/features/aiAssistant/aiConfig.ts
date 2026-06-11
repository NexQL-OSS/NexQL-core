import * as vscode from 'vscode';
import type { AiConfigScope, AiProviderId, AiScopeSettings } from './types';
export type { AiConfigScope } from './types';

const SCOPED_SETTINGS_MIGRATION_FLAG = 'postgresExplorer.aiScopedSettingsMigrated';
const LAST_MODELS_KEY = 'postgresExplorer.ai.lastModelsByProvider';

const DEFAULT_PROVIDER: AiProviderId = 'vscode-lm';

export function getScopedProviderKey(scope: AiConfigScope): string {
  return scope === 'chat' ? 'ai.chat.provider' : 'ai.notebook.provider';
}

export function getScopedModelKey(scope: AiConfigScope): string {
  return scope === 'chat' ? 'ai.chat.model' : 'ai.notebook.model';
}

export function readAiScopeSettings(
  config: vscode.WorkspaceConfiguration,
  scope: AiConfigScope,
): AiScopeSettings {
  const provider =
    (config.get<string>(getScopedProviderKey(scope)) as AiProviderId | undefined) ||
    (config.get<string>('aiProvider') as AiProviderId | undefined) ||
    DEFAULT_PROVIDER;
  const model =
    config.get<string>(getScopedModelKey(scope)) || config.get<string>('aiModel') || '';
  return { provider, model };
}

export async function writeAiScopeSettings(
  scope: AiConfigScope,
  settings: Partial<AiScopeSettings>,
): Promise<void> {
  const config = vscode.workspace.getConfiguration('postgresExplorer');
  if (settings.provider !== undefined) {
    await config.update(
      getScopedProviderKey(scope),
      settings.provider,
      vscode.ConfigurationTarget.Global,
    );
  }
  if (settings.model !== undefined) {
    await config.update(
      getScopedModelKey(scope),
      settings.model,
      vscode.ConfigurationTarget.Global,
    );
  }
}

export async function migrateAiScopedSettings(context: vscode.ExtensionContext): Promise<void> {
  if (context.globalState.get<boolean>(SCOPED_SETTINGS_MIGRATION_FLAG)) {
    return;
  }

  const config = vscode.workspace.getConfiguration('postgresExplorer');
  const legacyProvider = config.get<string>('aiProvider');
  const legacyModel = config.get<string>('aiModel') || '';

  if (legacyProvider) {
    const chatProvider = config.get<string>(getScopedProviderKey('chat'));
    const notebookProvider = config.get<string>(getScopedProviderKey('notebook'));
    if (!chatProvider) {
      await config.update(
        getScopedProviderKey('chat'),
        legacyProvider,
        vscode.ConfigurationTarget.Global,
      );
    }
    if (!notebookProvider) {
      await config.update(
        getScopedProviderKey('notebook'),
        legacyProvider,
        vscode.ConfigurationTarget.Global,
      );
    }
    const chatModel = config.get<string>(getScopedModelKey('chat'));
    const notebookModel = config.get<string>(getScopedModelKey('notebook'));
    if (!chatModel && legacyModel) {
      await config.update(getScopedModelKey('chat'), legacyModel, vscode.ConfigurationTarget.Global);
    }
    if (!notebookModel && legacyModel) {
      await config.update(
        getScopedModelKey('notebook'),
        legacyModel,
        vscode.ConfigurationTarget.Global,
      );
    }
  }

  await context.globalState.update(SCOPED_SETTINGS_MIGRATION_FLAG, true);
}

export function buildSelectionId(provider: AiProviderId, modelId: string): string {
  return `${provider}:${modelId}`;
}

export function parseSelectionId(selectionId: string): { provider: AiProviderId; modelId: string } | undefined {
  const idx = selectionId.indexOf(':');
  if (idx <= 0) {
    return undefined;
  }
  const provider = selectionId.slice(0, idx) as AiProviderId;
  const modelId = selectionId.slice(idx + 1);
  if (!modelId) {
    return undefined;
  }
  return { provider, modelId };
}

export async function rememberLastModelForProvider(
  context: vscode.ExtensionContext,
  provider: AiProviderId,
  model: string,
): Promise<void> {
  if (!model.trim()) {
    return;
  }
  const map =
    context.globalState.get<Record<string, string>>(LAST_MODELS_KEY) || {};
  map[provider] = model;
  await context.globalState.update(LAST_MODELS_KEY, map);
}

export function getLastModelForProvider(
  context: vscode.ExtensionContext,
  provider: AiProviderId,
): string | undefined {
  const map = context.globalState.get<Record<string, string>>(LAST_MODELS_KEY);
  return map?.[provider];
}

export function providerDisplayName(provider: AiProviderId): string {
  switch (provider) {
    case 'vscode-lm':
      return 'VS Code LM';
    case 'github':
      return 'GitHub Models';
    case 'cursor':
      return 'Cursor';
    case 'opencode':
      return 'OpenCode';
    case 'openai':
      return 'OpenAI';
    case 'anthropic':
      return 'Anthropic';
    case 'gemini':
      return 'Gemini';
    case 'custom':
      return 'Custom';
    case 'ollama':
      return 'Ollama';
    case 'lmstudio':
      return 'LM Studio';
    default:
      return provider;
  }
}
