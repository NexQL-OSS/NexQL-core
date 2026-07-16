/**
 * Visibility rule for the chat panel's NexQL sign-in banner. The banner only
 * nags when the free NexQL provider is active, the user is unsigned, and they
 * have never dismissed it — every other provider works without an account.
 */
export function shouldShowNexqlSignInBanner(
  provider: string | undefined,
  signedIn: boolean,
  dismissed: boolean,
): boolean {
  return provider === 'nexql-free' && !signedIn && !dismissed;
}
