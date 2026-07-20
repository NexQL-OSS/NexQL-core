/**
 * Build-tier detection. `__NEXQL_PRO__` is injected by esbuild `--define`:
 * `true` in pro bundles, `false` in free bundles. Under tsc/ts-node (tests,
 * typecheck) the identifier does not exist at runtime, so this helper guards
 * with `typeof` and defaults to the free tier.
 *
 * Always call `isProBuild()` — never reference the bare global — so code
 * behaves identically across esbuild bundles and ts-node test runs.
 */
declare const __NEXQL_PRO__: boolean;

export function isProBuild(): boolean {
  try {
    return typeof __NEXQL_PRO__ !== 'undefined' && __NEXQL_PRO__ === true;
  } catch {
    return false;
  }
}
