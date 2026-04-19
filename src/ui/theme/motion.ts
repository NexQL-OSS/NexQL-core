/**
 * Branch when JS must skip motion (e.g. imperative scroll animations).
 * Webviews should also use a prefers-reduced-motion media query in CSS
 * (see template styles under templates/).
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
