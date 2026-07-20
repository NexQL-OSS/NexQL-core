/**
 * Abstraction over AI provider credential storage. Implemented by the AI
 * assistant feature (AiCredentialsService), which registers itself on
 * SecretStorageService at activation. Core code never imports the AI
 * feature directly — it only talks to this interface.
 */
export interface AiCredentialsProviderLike {
  getApiKey(provider: string): Promise<string | undefined>;
  setApiKey(provider: string, apiKey: string | undefined): Promise<void>;
  getCursorApiKey(): Promise<string | undefined>;
  setCursorApiKey(apiKey: string | undefined): Promise<void>;
}
