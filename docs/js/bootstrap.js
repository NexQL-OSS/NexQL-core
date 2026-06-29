function scrollToLandingAnchor(anchorId) {
  const target = document.getElementById(anchorId);
  if (!target) return;

  const scrollTarget = () => {
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    const nav = document.getElementById("site-nav");
    nav?.classList.remove("show");
    document.getElementById("btn-toggle-topbar")?.setAttribute("aria-expanded", "false");
    syncSiteHeaderOffset();
  };

  if (document.body.classList.contains("editor-minimized")) {
    scrollTarget();
    return;
  }
  setEditorMinimizedState(true);
  window.setTimeout(scrollTarget, 400);
}

function wireSiteHeaderScrollState() {
  const header = document.querySelector(".site-header.landing-topbar");
  if (!header) return;

  const sync = () => {
    header.classList.toggle("is-scrolled", window.scrollY > 8);
  };

  window.addEventListener("scroll", sync, { passive: true });
  sync();
}

function wireLandingChrome() {
  document.querySelectorAll('.site-nav a[href^="#"], a.site-logo[href^="#"]').forEach((link) => {
    link.addEventListener("click", (e) => {
      const hash = link.getAttribute("href");
      if (!hash || hash === "#") return;
      e.preventDefault();
      scrollToLandingAnchor(hash.slice(1));
    });
  });

  document.getElementById("footer-landing-pricing")?.addEventListener("click", (e) => {
    e.preventDefault();
    scrollToLandingAnchor("pricing");
  });

  document.querySelectorAll("[data-landing-open-demo]").forEach((node) => {
    node.addEventListener("click", (e) => {
      e.preventDefault();
      setEditorMinimizedState(false);
      openFile("query");
      switchSidebarPanel("nexql");
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

function wireReleaseBanner() {
  const banner = document.getElementById("release-banner");
  const closeBtn = document.getElementById("btn-close-banner");
  if (!banner || !closeBtn) return;

  const dismissKey = "nexql-release-2.0.0-banner-dismissed";
  if (localStorage.getItem(dismissKey) === "true") {
    document.body.classList.add("banner-dismissed");
  }

  closeBtn.addEventListener("click", () => {
    localStorage.setItem(dismissKey, "true");
    document.body.classList.add("banner-dismissed");
    syncSiteHeaderOffset();
  });
}

function initializeDesktopExperience() {
  wireReleaseBanner();
  wireThemeToggle();
  wireTour();
  wireSiteHeaderScrollState();
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

function syncSiteHeaderOffset() {
  const header = document.querySelector(".site-header.landing-topbar");
  if (!header) {
    return;
  }
  document.documentElement.style.setProperty(
    "--site-header-offset",
    `${Math.ceil(header.getBoundingClientRect().height)}px`,
  );
}

function wireMobileUiToggles() {
  const btnTop = document.getElementById("btn-toggle-topbar");
  const topLinks = document.getElementById("site-nav");
  if (btnTop && topLinks) {
    btnTop.addEventListener("click", () => {
      const open = topLinks.classList.toggle("show");
      btnTop.setAttribute("aria-expanded", open ? "true" : "false");
      requestAnimationFrame(syncSiteHeaderOffset);
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
  if (window.NexqlThemes?.ready) {
    await window.NexqlThemes.ready.catch(() => {});
  }

  if (typeof loadHtmlPartials === "function") {
    await loadHtmlPartials();
  }

  initializeDesktopExperience();
  wireMobileUiToggles();
  syncSiteHeaderOffset();
  window.addEventListener("resize", syncSiteHeaderOffset, { passive: true });
});
