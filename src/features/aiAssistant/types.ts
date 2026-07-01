/** Providers that use a per-provider API key in secret storage. */
export type DirectApiKeyProvider =
  | 'openai'
  | 'anthropic'
  | 'gemini'
  | 'deepseek'
  | 'moonshot'
  | 'mistral'
  | 'custom';

export const DIRECT_API_KEY_PROVIDERS: readonly DirectApiKeyProvider[] = [
  'openai',
  'anthropic',
  'gemini',
  'deepseek',
  'moonshot',
  'mistral',
  'custom',
] as const;

export type AiProviderId =
  | 'vscode-lm'
  | 'nexql-free'
  | 'github'
  | 'cursor'
  | 'opencode'
  | DirectApiKeyProvider
  | 'ollama'
  | 'lmstudio';

export type AiConfigScope = 'chat' | 'notebook';

export interface AiScopeSettings {
  provider: AiProviderId;
  model: string;
}

export interface AiCatalogEntry {
  selectionId: string;
  provider: AiProviderId;
  modelId: string;
  label: string;
  groupLabel: string;
}

export interface AiModelCatalogPayload {
  catalog: AiCatalogEntry[];
  activeSelectionId: string;
  activeModelLabel: string;
}
