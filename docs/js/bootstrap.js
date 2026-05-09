function wireLandingChrome() {
  document.getElementById("btn-landing-home")?.addEventListener("click", () => {
    const minimized = document.body.classList.contains("editor-minimized");
    if (minimized) {
      document.querySelector(".hero-shell")?.scrollTo({ top: 0, behavior: "smooth" });
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    setEditorMinimizedState(true);
  });

  document.getElementById("btn-landing-live-demo")?.addEventListener("click", () => {
    setEditorMinimizedState(false);
    openFile("query");
    switchSidebarPanel("pgstudio");
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
