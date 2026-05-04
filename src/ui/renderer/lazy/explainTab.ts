export async function mountExplainTab(
  explainWrapper: HTMLElement,
  explainPlan: unknown,
): Promise<void> {
  const { ExplainVisualizer } = await import('../../../renderer/components/ExplainVisualizer');
  if (explainPlan) {
    try {
      new ExplainVisualizer(explainWrapper, explainPlan).render();
    } catch (e) {
      explainWrapper.textContent = 'Failed to render explain plan: ' + String(e);
    }
  } else {
    explainWrapper.textContent =
      'No explain plan data available. Run EXPLAIN (ANALYZE, FORMAT JSON) to get a visual plan.';
  }
}
