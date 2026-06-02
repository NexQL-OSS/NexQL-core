async function loadHtmlPartials() {
  const partialRoots = Array.from(document.querySelectorAll("[data-partial]"));
  if (!partialRoots.length) return;

  await Promise.all(partialRoots.map(async (root) => {
    const path = root.getAttribute("data-partial");
    if (!path) return;

    try {
      const response = await fetch(path, { cache: "no-cache" });
      if (!response.ok) {
        throw new Error(`Failed to load partial: ${path}`);
      }
      root.outerHTML = await response.text();
    } catch (error) {
      console.error(error);
      root.innerHTML = "";
    }
  }));

  document.dispatchEvent(new CustomEvent('partials-loaded'));
}
