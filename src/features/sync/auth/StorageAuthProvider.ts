/** Shared auth contract for user-owned storage backends. */
export interface StorageAuthProvider {
  readonly providerId: string;
  signIn(): Promise<{ account: string }>;
  getAccessToken(): Promise<string | undefined>;
  signOut(): Promise<void>;
  isSignedIn(): Promise<boolean>;
}
