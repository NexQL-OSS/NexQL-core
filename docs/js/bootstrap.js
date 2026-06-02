function scrollToLandingAnchor(anchorId) {
  const target = document.getElementById(anchorId);
  if (!target) return;

  const scrollTarget = () => {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    document.querySelector(".desktop-topbar-links")?.classList.remove("show");
  };

  if (document.body.classList.contains("editor-minimized")) {
    scrollTarget();
    return;
  }
  setEditorMinimizedState(true);
  window.setTimeout(scrollTarget, 400);
}

function scrollToLandingPricing() {
  scrollToLandingAnchor("landing-price-title");
}

function wireLandingChrome() {
  document.querySelectorAll("[data-landing-scroll]").forEach((node) => {
    node.addEventListener("click", () => {
      const anchor = node.getAttribute("data-landing-scroll");
      if (anchor) scrollToLandingAnchor(anchor);
    });
  });

  document.getElementById("btn-landing-pricing")?.addEventListener("click", () => scrollToLandingPricing());
  document.getElementById("footer-landing-pricing")?.addEventListener("click", () => scrollToLandingPricing());

  document.querySelectorAll('a[href="#install"]').forEach((link) => {
    link.addEventListener("click", (e) => {
      e.preventDefault();
      scrollToLandingAnchor("install");
    });
  });

  document.querySelectorAll("[data-landing-open-demo]").forEach((node) => {
    node.addEventListener("click", (e) => {
      e.preventDefault();
      setEditorMinimizedState(false);
      openFile("query");
      switchSidebarPanel("pgstudio");
    });
  });
}

function wireEditorLayoutToggles() {
  const wb = document.querySelector(".workbench");
  const btnExplorer = document.getElementById("btn-toggle-explorer-sidebar");
  const btnAssistant = document.getElementById("btn-toggle-assistant-sidebar");
  if (!wb || !btnExplorer || !btnAssistant) return;

  function syncLayoutToggleUi() {
    const leftHidden = wb.classList.contains("panel-left-hidden");
    const rightHidden = wb.classList.contains("panel-right-hidden");
    btnExplorer.setAttribute("aria-pressed", leftHidden ? "true" : "false");
    btnAssistant.setAttribute("aria-pressed", rightHidden ? "true" : "false");
    btnExplorer.setAttribute("title", leftHidden ? "Show Explorer sidebar" : "Hide Explorer sidebar");
    btnAssistant.setAttribute("title", rightHidden ? "Show SQL Assistant" : "Hide SQL Assistant");
  }

  btnExplorer.addEventListener("click", (e) => {
    e.stopPropagation();
    wb.classList.toggle("panel-left-hidden");
    if (wb.classList.contains("panel-left-hidden")) {
      wb.classList.remove("show-left");
    }
    syncLayoutToggleUi();
  });

  btnAssistant.addEventListener("click", (e) => {
    e.stopPropagation();
    wb.classList.toggle("panel-right-hidden");
    if (wb.classList.contains("panel-right-hidden")) {
      wb.classList.remove("show-right");
    }
    syncLayoutToggleUi();
  });

  syncLayoutToggleUi();
}

function initializeDesktopExperience() {
  wireThemeToggle();
  wireTour();
  wireLandingChrome();
  wireWindowControls();
  wireActivityBar();
  wireEditorLayoutToggles();
  wireNavigation();
  wireTabClose();
  wireSearch();
  wireQueryRunAnimation();
  wireQueryToolbarActions();
  wireFeatureCards();
  if (typeof wireCapabilityModal === "function") wireCapabilityModal();
  wireConnectionSimulation();
  wireAssistant();
  hydrateMarketplaceStats();
  showStartupToast();
  preloadAssistantConversation();
  openFile("query");

  document.addEventListener("click", (e) => {
    const tab = e.target.closest("[data-open='query']");
    if (tab) window.setTimeout(animateSqlTyping, 200);
    // On first workbench interaction: schedule context node fade and suppress command palette
    if (e.target.closest(".shell")) {
      if (!document.body.classList.contains("nodes-faded")) {
        window.setTimeout(() => document.body.classList.add("nodes-faded"), 6000);
      }
      if (!document.body.classList.contains("shell-engaged")) {
        document.body.classList.add("shell-engaged");
      }
    }
  });
}

function wireMobileUiToggles() {
  const btnTop = document.getElementById("btn-toggle-topbar");
  const topLinks = document.querySelector(".desktop-topbar-links");
  if (btnTop && topLinks) {
    btnTop.addEventListener("click", () => {
      topLinks.classList.toggle("show");
    });
  }

  const btnLeft = document.getElementById("btn-toggle-left");
  const btnRight = document.getElementById("btn-toggle-right");
  const btnCloseEditor = document.getElementById("btn-close-editor");
  const workbench = document.querySelector(".workbench");
  const body = document.body;

  if (btnLeft && workbench) {
    btnLeft.addEventListener("click", () => {
      workbench.classList.toggle("show-left");
      workbench.classList.remove("show-right");
    });
  }

  if (btnRight && workbench) {
    btnRight.addEventListener("click", () => {
      workbench.classList.toggle("show-right");
      workbench.classList.remove("show-left");

      const rp = document.querySelector(".right-panel");
      if (rp && !rp.classList.contains("expanded")) {
        rp.classList.add("expanded");
      }
    });
  }

  if (btnCloseEditor && body) {
    btnCloseEditor.addEventListener("click", () => {
      const nextMinimized = !body.classList.contains("editor-minimized");
      setEditorMinimizedState(nextMinimized);
    });
  }

  if (workbench) {
    workbench.addEventListener("click", (e) => {
      if (e.target.closest(".editor-region") && (workbench.classList.contains("show-left") || workbench.classList.contains("show-right"))) {
        workbench.classList.remove("show-left");
        workbench.classList.remove("show-right");
      }
    });
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  if (typeof loadHtmlPartials === "function") {
    await loadHtmlPartials();
  }

  initializeDesktopExperience();
  wireMobileUiToggles();
});
