// ── SQL Assistant helpers ─────────────────────────────────
function streamChatMessage(logId, role, html, onDone) {
  if (role !== "assistant") { appendChatMessage(logId, role, html); onDone?.(); return; }
  const log = document.getElementById(logId);
  if (!log) return;
  const msg = document.createElement("div");
  msg.className = "chat-msg assistant";
  log.appendChild(msg);
  const temp = document.createElement("div");
  temp.innerHTML = html.replace(/\n/g, "<br>");
  const tokens = [];
  temp.childNodes.forEach(node => {
    if (node.nodeType === Node.TEXT_NODE) {
      node.textContent.split("").forEach(ch => tokens.push({ type: "char", content: ch }));
    } else {
      tokens.push({ type: "element", content: node.cloneNode(true) });
    }
  });
  let i = 0;
  const body = document.getElementById("assistant-body");
  const interval = setInterval(() => {
    if (i >= tokens.length) {
      clearInterval(interval);
      log.scrollTop = log.scrollHeight;
      if (body) body.scrollTop = body.scrollHeight;
      onDone?.();
      return;
    }
    const token = tokens[i++];
    if (token.type === "char") {
      msg.appendChild(document.createTextNode(token.content));
    } else {
      msg.appendChild(token.content);
    }
    log.scrollTop = log.scrollHeight;
    if (body) body.scrollTop = body.scrollHeight;
  }, 18);
}

function appendChatMessage(logId, role, text) {
  const log = document.getElementById(logId);
  if (!log) return;
  const msg = document.createElement("div");
  msg.className = `chat-msg ${role}`;
  if (role === "assistant") {
    msg.innerHTML = text.replace(/\n/g, "<br>");
  } else {
    const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    msg.innerHTML = escaped
      .replace(/\n/g, "<br>")
      .replace(/&lt;code&gt;([\s\S]*?)&lt;\/code&gt;/g, "<code>$1</code>");
  }
  log.appendChild(msg);
  log.scrollTop = log.scrollHeight;
  const body = document.getElementById("assistant-body");
  if (body) body.scrollTop = body.scrollHeight;
}

function getActiveLogId() {
  const tab = document.querySelector(".assistant-tab.active")?.getAttribute("data-atab") ?? "sql";
  return { sql: "sql-chat-log", chat: "chat-log", codex: "codex-log", claude: "claude-log" }[tab] ?? "sql-chat-log";
}

function showTypingIndicator(logId) {
  const log = document.getElementById(logId);
  if (!log) return null;
  const el = document.createElement("div");
  el.className = "chat-typing-dots";
  el.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span>';
  log.appendChild(el);
  log.scrollTop = log.scrollHeight;
  const body = document.getElementById("assistant-body");
  if (body) body.scrollTop = body.scrollHeight;
  return el;
}

function resetAssistantConversation() {
  document.querySelectorAll(".chat-typing-dots").forEach((el) => el.remove());

  const log = document.getElementById("sql-chat-log");
  if (log) log.innerHTML = "";

  const cards = document.querySelector(".action-cards");
  if (cards) cards.style.display = "grid";

  const body = document.getElementById("assistant-body");
  if (body) body.scrollTop = 0;
}

function sendAssistantPreset(promptKey) {
  const resp = ASSISTANT_RESPONSES[promptKey];
  if (!resp) return;
  const cards = document.querySelector(".action-cards");
  if (cards) cards.style.display = "none";
  const logId = "sql-chat-log";
  openFile("query");
  appendChatMessage(logId, "user", resp.user);
  window.setTimeout(() => {
    const typing = showTypingIndicator(logId);
    window.setTimeout(() => {
      typing?.remove();
      streamChatMessage(logId, "assistant", resp.reply);
    }, 650);
  }, 100);
}

function showProductReadmeHighlight(highlightKey) {
  resetAssistantConversation();
  const cards = document.querySelector(".action-cards");
  if (cards) cards.style.display = "none";
  const highlight = PRODUCT_HIGHLIGHTS[highlightKey];
  if (!highlight) return;

  const logId = "sql-chat-log";
  appendChatMessage(logId, "user", highlight.user);
  window.setTimeout(() => {
    const typing = showTypingIndicator(logId);
    window.setTimeout(() => {
      typing?.remove();
      streamChatMessage(logId, "assistant", renderProductHighlightHtml(highlight), () => {
        window.setTimeout(() => appendNextProductHighlightBubble(logId, highlightKey), 120);
      });
    }, 650);
  }, 100);
}

function renderProductHighlightHtml(highlight) {
  const points = (highlight.points ?? [])
    .map((point) => `<li><span class="chat-rich-li-icon" aria-hidden="true">✓</span><span>${point}</span></li>`)
    .join("");

  const icon = highlight.icon ?? "✨";
  return `<div class="chat-rich-response"><div class="chat-rich-kicker"><span class="chat-rich-kicker-icon" aria-hidden="true">✨</span>Quick highlight</div><div class="chat-rich-title"><span class="chat-rich-title-icon" aria-hidden="true">${icon}</span><span>${highlight.title}</span></div><div class="chat-rich-summary">${highlight.summary}</div><ul class="chat-rich-list">${points}</ul><div class="chat-rich-tip"><span class="chat-rich-tip-icon" aria-hidden="true">💡</span><span class="chat-rich-tip-label">Tip:</span><span>${highlight.tip}</span></div></div>`;
}

function getNextProductHighlightKey(currentKey) {
  const currentIndex = PRODUCT_HIGHLIGHT_ORDER.indexOf(currentKey);
  if (currentIndex === -1) return PRODUCT_HIGHLIGHT_ORDER[0];
  return PRODUCT_HIGHLIGHT_ORDER[(currentIndex + 1) % PRODUCT_HIGHLIGHT_ORDER.length];
}

function appendNextProductHighlightBubble(logId, currentKey) {
  const log = document.getElementById(logId);
  const nextKey = getNextProductHighlightKey(currentKey);
  const nextHighlight = PRODUCT_HIGHLIGHTS[nextKey];
  if (!log || !nextHighlight) return;

  const bubble = document.createElement("div");
  bubble.className = "chat-msg assistant chat-topic-suggestion";
  bubble.tabIndex = 0;
  bubble.setAttribute("role", "button");
  bubble.innerHTML = `<span>Tip:</span> <strong>${nextHighlight.title}</strong>`;

  const openNext = () => {
    showProductReadmeHighlight(nextKey);
  };

  bubble.addEventListener("click", openNext);
  bubble.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openNext();
    }
  });

  log.appendChild(bubble);
  log.scrollTop = log.scrollHeight;
  const body = document.getElementById("assistant-body");
  if (body) body.scrollTop = body.scrollHeight;
}

// ── SQL Assistant wiring ──────────────────────────────────
function wireAssistant() {
  const TYPING_DELAY_MS = 650;
  const newChatButton = document.querySelector('.assistant-subheader-btn[aria-label="New chat"]');

  newChatButton?.addEventListener("click", () => {
    resetAssistantConversation();
  });

  function hideActionCards() {
    const cards = document.querySelector(".action-cards");
    if (cards) cards.style.display = "none";
  }

  // Action cards
  document.querySelectorAll(".action-card[data-product-highlight]").forEach((card) => {
    card.addEventListener("click", () => {
      hideActionCards();
      showProductReadmeHighlight(card.getAttribute("data-product-highlight"));
    });
  });

  // Snippet pills — show canned response in chat
  document.querySelectorAll(".snippet-pill[data-snippet]").forEach((pill) => {
    pill.addEventListener("click", () => {
      hideActionCards();
      const snippet = pill.getAttribute("data-snippet");
      const logId = getActiveLogId();
      const snippetReply = SNIPPET_RESPONSES[snippet];
      appendChatMessage(logId, "user", pill.textContent);
      window.setTimeout(() => {
        const typing = showTypingIndicator(logId);
        window.setTimeout(() => {
          typing?.remove();
          if (snippetReply) {
            appendChatMessage(logId, "assistant", snippetReply);
          } else {
            appendChatMessage(logId, "assistant", "Snippet ready — copy it into the query editor:\n\n<code>" + snippet + "</code>");
          }
        }, TYPING_DELAY_MS);
      }, 100);
    });
  });

  // Assistant tab switching
  document.querySelectorAll(".assistant-tab[data-atab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".assistant-tab").forEach((t) => { t.classList.remove("active"); t.setAttribute("aria-selected", "false"); });
      tab.classList.add("active"); tab.setAttribute("aria-selected", "true");
      const pId = `atab-${tab.getAttribute("data-atab")}`;
      document.querySelectorAll(".assistant-panel").forEach((p) => p.classList.remove("active"));
      document.getElementById(pId)?.classList.add("active");
    });
  });

  // Send / Enter — free-form input → teaser + install CTA
  const input = document.getElementById("assistant-input");
  const sendBtn = document.getElementById("assistant-send");
  if (!input || !sendBtn) return;

  function handleSend() {
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    sendBtn.disabled = true;
    hideActionCards();
    const logId = getActiveLogId();
    appendChatMessage(logId, "user", text);
    window.setTimeout(() => {
      const typing = showTypingIndicator(logId);
      window.setTimeout(() => {
        typing?.remove();
        const teaserLines = buildFreeFormTeaser(text);
        const opener = teaserLines[0];
        const bullets = teaserLines.slice(1).join("\n");
        streamChatMessage(logId, "assistant",
          opener + "\n\n" + bullets + "\n\n" +
          "Install NexQL and I'll run this against your actual database — no copy-paste required. Takes about 30 seconds.\n\n" +
          '<a class="chat-install-cta" href="https://marketplace.visualstudio.com/items?itemName=ric-v.postgres-explorer" target="_blank">⬇ Install free — live answers in VS Code →</a>',
          () => { sendBtn.disabled = false; }
        );
      }, 900);
    }, 100);
  }

  // Toggle attach menu
  const btnAttach = document.getElementById("btn-attach");
  const attachMenu = document.getElementById("chat-attach-menu");
  if (btnAttach && attachMenu) {
    btnAttach.addEventListener("click", () => {
      attachMenu.classList.toggle("visible");
      attachMenu.setAttribute("aria-hidden", !attachMenu.classList.contains("visible"));
    });

    document.querySelectorAll(".attach-menu-item").forEach(item => {
      item.addEventListener("click", () => {
        const ctx = item.getAttribute("data-ctx");
        if (ctx && input) {
          const val = input.value;
          input.value = val ? val + " @" + ctx + " " : "@" + ctx + " ";
          input.focus();
        }
        attachMenu.classList.remove("visible");
        attachMenu.setAttribute("aria-hidden", "true");
      });
    });

    // Close menu if clicking outside
    document.addEventListener("click", (e) => {
      if (!btnAttach.contains(e.target) && !attachMenu.contains(e.target)) {
        attachMenu.classList.remove("visible");
        attachMenu.setAttribute("aria-hidden", "true");
      }
    });
  }

  sendBtn.addEventListener("click", handleSend);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleSend(); } });
}

