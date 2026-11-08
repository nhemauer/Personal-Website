// Chat with the NYC taxi agent. The agent runs on Cloud Run (chat_server.py in
// github.com/nhemauer/NYC-Traffic-Analysis), which only accepts this site's origins.

const LOCAL = ["localhost", "127.0.0.1"].includes(location.hostname);
const API = LOCAL
  ? "http://localhost:8080"
  : "https://taxi-chat-351453896697.us-central1.run.app";

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("year").textContent = new Date().getFullYear();

  const log = document.getElementById("log");
  const starter = document.getElementById("starter");
  const form = document.getElementById("form");
  const box = document.getElementById("question");
  const send = document.getElementById("send");
  let sessionId = null;
  let busy = false;

  const add = (className, build) => {
    const el = document.createElement("div");
    el.className = `msg ${className}`;
    build(el);
    log.append(el);
    log.scrollTop = log.scrollHeight;
    return el;
  };

  const renderMarkdown = (text) => {
    if (!window.marked || !window.DOMPurify) {
      const p = document.createElement("p");
      p.textContent = text;
      return p;
    }
    const div = document.createElement("div");
    // Text formatting only: no images (which load from other sites), forms or styles.
    div.innerHTML = DOMPurify.sanitize(marked.parse(text), {
      FORBID_TAGS: ["img", "style", "form", "input", "button", "textarea", "select"],
    });
    div.querySelectorAll("table").forEach((table) => {
      const wrap = document.createElement("div");
      wrap.className = "table-wrap";
      table.replaceWith(wrap);
      wrap.append(table);
    });
    div.querySelectorAll("a").forEach((a) => {
      a.target = "_blank";
      a.rel = "noopener noreferrer";
    });
    return div;
  };

  const showWork = (el, sql, tools) => {
    if (!sql.length && !tools.length) return;
    const details = document.createElement("details");
    details.className = "work";
    const summary = document.createElement("summary");
    summary.textContent = sql.length
      ? `How it answered (${sql.length} ${sql.length === 1 ? "query" : "queries"})`
      : "How it answered";
    details.append(summary);
    sql.forEach((query) => {
      const pre = document.createElement("pre");
      pre.textContent = query.trim();
      details.append(pre);
    });
    if (tools.length) {
      const p = document.createElement("p");
      p.textContent = `Tools used: ${tools.join(", ")}`;
      details.append(p);
    }
    el.append(details);
  };

  const ask = async (question) => {
    if (busy || !question) return;
    busy = true;
    send.disabled = true;
    starter.hidden = true;
    add("msg-user", (el) => { el.textContent = question; });
    box.value = "";
    fit();
    // Steps the agent has taken so far; the last one is still running.
    const progress = add("progress", (el) => {
      el.innerHTML = '<ol><li class="current">Thinking</li></ol>';
    });
    const steps = progress.querySelector("ol");
    const addStep = (text) => {
      steps.querySelector(".current")?.classList.remove("current");
      const li = document.createElement("li");
      li.className = "current";
      li.textContent = text;
      steps.append(li);
      log.scrollTop = log.scrollHeight;
    };

    // The answer as Gemini writes it, redrawn at most once per frame.
    let draft = null;
    let draftText = "";
    let redraw = 0;
    const showDraft = () => {
      redraw = 0;
      const answer = renderMarkdown(draftText);
      answer.className = "answer";
      draft.replaceChildren(answer);
      log.scrollTop = log.scrollHeight;
    };
    const dropDraft = () => {
      cancelAnimationFrame(redraw);
      draft?.remove();
      draft = null;
      draftText = "";
    };

    const handle = (item) => {
      if (item.type === "step") {
        // Text before a tool call was the model thinking aloud, not the answer.
        dropDraft();
        progress.hidden = false;
        addStep(item.text);
      } else if (item.type === "delta") {
        progress.hidden = true;
        if (!draft) draft = add("msg-agent", () => {});
        draftText += item.text;
        if (!redraw) redraw = requestAnimationFrame(showDraft);
      } else if (item.type === "done") {
        sessionId = item.session_id;
        dropDraft();
        progress.remove();
        add("msg-agent", (el) => {
          const answer = renderMarkdown(item.answer);
          answer.classList.add("answer");
          el.append(answer);
          showWork(el, item.sql || [], item.tools || []);
        });
        return true;
      } else if (item.type === "error") {
        throw new Error(item.detail);
      }
      return false;
    };

    try {
      const res = await fetch(`${API}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: question, session_id: sessionId }),
      });
      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        const detail = typeof data.detail === "string" ? data.detail : null;
        throw new Error(detail || "Something went wrong. Try again in a moment.");
      }

      // One JSON object per line; a read can end partway through a line.
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      let finished = false;
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        const lines = buffer.split("\n");
        buffer = lines.pop();
        for (const line of lines) {
          if (line.trim() && handle(JSON.parse(line))) finished = true;
        }
      }
      if (!finished && buffer.trim()) finished = handle(JSON.parse(buffer));
      if (!finished) throw new Error("The connection dropped before the answer finished. Try again.");
    } catch (err) {
      dropDraft();
      progress.remove();
      const message = err instanceof TypeError
        ? "Couldn't reach the agent. Check your connection and try again."
        : err.message;
      add("msg-error", (el) => { el.textContent = message; });
    } finally {
      busy = false;
      send.disabled = false;
      box.focus();
    }
  };

  // Grow the box with its text, up to the CSS max-height.
  const fit = () => {
    box.style.height = "auto";
    box.style.height = `${box.scrollHeight + 2}px`;
  };
  box.addEventListener("input", fit);

  // Enter sends; Shift+Enter adds a new line.
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    ask(box.value.trim());
  });

  starter.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => ask(button.textContent));
  });

  document.getElementById("reset").addEventListener("click", () => {
    if (busy) return;
    sessionId = null;
    log.querySelectorAll(".msg").forEach((el) => el.remove());
    starter.hidden = false;
    box.focus();
  });
});
