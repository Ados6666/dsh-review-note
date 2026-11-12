window.__ModuleLoader__.load({
  id: "dsh-review-note",
  factory: (require) => {
    var React = require("react");
    var h = React.createElement;

    // ------------------------------------------------------------------
    // Constants
    // ------------------------------------------------------------------

    var TAB_ID = "review-note";
    var TAB_KIND = "review-note";
    var REQUEST_RE = /^<!--dsh-review:v1\s+([A-Za-z0-9+/=]+)\s*-->/;
    var ANSWER_RE = /<!--dsh-review-answer:v1\s+([A-Za-z0-9+/=]+)\s*-->/;
    var SETTINGS_KEY = "dsh-review-note:settings:v1";
    var DRAFT_PREFIX = "dsh-review-note:draft:";
    var HIGHLIGHT_ITEM = "review-note-item";
    var HIGHLIGHT_NOTE = "review-note-comment";
    var HIGHLIGHT_STYLE_ID = "dsh-review-note-highlight-style";
    var BORDER = "1px solid rgba(127,127,127,0.32)";
    var SOFT_BG = "rgba(127,127,127,0.07)";
    var MUTED = "rgba(127,127,127,0.9)";
    var ERROR = "#c0392b";
    var DEFAULT_SETTINGS = { minQuestions: 3, autoOpen: true };

    // ------------------------------------------------------------------
    // Base64 + envelopes
    // ------------------------------------------------------------------

    function utf8ToBinary(text) {
      var bytes = new TextEncoder().encode(text);
      var binary = "";
      for (var i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
      return binary;
    }

    function binaryToUtf8(binary) {
      var bytes = new Uint8Array(binary.length);
      for (var i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
      return new TextDecoder().decode(bytes);
    }

    function b64encode(value) {
      return btoa(utf8ToBinary(JSON.stringify(value)));
    }

    function b64decode(text) {
      return binaryToUtf8(atob(text));
    }

    function decodeEnvelope(prefixRe, text) {
      if (typeof text !== "string") return null;
      var match = prefixRe.exec(text);
      if (!match) return null;
      try {
        var value = JSON.parse(b64decode(match[1]));
        return value && typeof value === "object" ? value : null;
      } catch (error) {
        return null;
      }
    }

    function encodeAnswerPayload(payload) {
      return "<!--dsh-review-answer:v1 " + b64encode(payload) + "-->";
    }

    // ------------------------------------------------------------------
    // Settings (per browser profile, editable in Settings -> 交付批注)
    // ------------------------------------------------------------------

    var settingsListeners = new Set();
    var settingsCache = null;

    function loadSettings() {
      if (settingsCache !== null) return settingsCache;
      try {
        var raw = window.localStorage.getItem(SETTINGS_KEY);
        var parsed = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== "object") {
          settingsCache = Object.assign({}, DEFAULT_SETTINGS);
          return settingsCache;
        }
        var min = Number(parsed.minQuestions);
        settingsCache = {
          minQuestions: Number.isFinite(min) ? Math.max(2, Math.min(20, Math.round(min))) : DEFAULT_SETTINGS.minQuestions,
          autoOpen: parsed.autoOpen !== false,
        };
        return settingsCache;
      } catch (error) {
        settingsCache = Object.assign({}, DEFAULT_SETTINGS);
        return settingsCache;
      }
    }

    function saveSettings(next) {
      settingsCache = next;
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
      } catch (error) {
        /* private mode */
      }
      settingsListeners.forEach(function (listener) { listener(); });
    }

    // ------------------------------------------------------------------
    // Review state store
    // ------------------------------------------------------------------

    var state = {
      pending: null,
      mode: null,
      meta: null,
      body: "",
      questions: [],
      comments: [],
      choices: {},
      note: "",
      selection: null,
      error: null,
      busy: false,
      key: null,
    };
    var listeners = new Set();
    var freeCommentSeq = 1;

    function emit() {
      listeners.forEach(function (listener) { listener(); });
    }

    function patch(changes) {
      state = Object.assign({}, state, changes);
      emit();
    }

    function subscribe(listener) {
      listeners.add(listener);
      return function () { listeners.delete(listener); };
    }

    function useStore() {
      return React.useSyncExternalStore(subscribe, function () { return state; }, function () { return state; });
    }

    // ------------------------------------------------------------------
    // Pending interaction detection
    // ------------------------------------------------------------------

    function isPendingQuestion(pending) {
      return pending !== null
        && typeof pending === "object"
        && Array.isArray(pending.questions)
        && typeof pending.answer === "function"
        && typeof pending.dismiss === "function";
    }

    function reviewOf(pending) {
      if (!isPendingQuestion(pending) || pending.questions.length !== 1) return null;
      var question = pending.questions[0];
      if (!question || typeof question.detail !== "string") return null;
      var meta = decodeEnvelope(REQUEST_RE, question.detail);
      if (!meta || meta.v !== 1 || !Array.isArray(meta.items)) return null;
      var match = REQUEST_RE.exec(question.detail);
      return { meta: meta, body: question.detail.slice(match[0].length) };
    }

    function isTimed(pending) {
      try {
        var snapshot = typeof pending.getSnapshot === "function" ? pending.getSnapshot() : pending.snapshot;
        if (!snapshot || typeof snapshot !== "object") return false;
        return snapshot.remainingMs !== undefined || snapshot.deadline !== undefined;
      } catch (error) {
        return false;
      }
    }

    function batchOf(pending, minQuestions) {
      if (!isPendingQuestion(pending)) return null;
      if (reviewOf(pending) !== null) return null;
      var questions = pending.questions;
      if (questions.length < minQuestions) return null;
      var blocked = questions.some(function (question) {
        var kind = question && question.intent && question.intent.kind;
        return kind === "plan-review" || kind === "approval";
      });
      if (blocked) return null;
      if (isTimed(pending)) return null;
      return pending;
    }

    function modeOf(pending) {
      if (reviewOf(pending) !== null) return "review";
      if (batchOf(pending, loadSettings().minQuestions) !== null) return "batch";
      return null;
    }

    // ------------------------------------------------------------------
    // Drafts
    // ------------------------------------------------------------------

    function hashQuestions(questions) {
      var text = JSON.stringify(questions || []);
      var hash = 2166136261;
      for (var i = 0; i < text.length; i += 1) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return (hash >>> 0).toString(36);
    }

    function draftKeyOf(pending, meta) {
      var base = meta
        ? String(meta.reviewId || "review")
        : String(pending.callId || hashQuestions(pending.questions));
      return DRAFT_PREFIX + String(pending.sessionId || "session") + ":" + base;
    }

    function loadDraft(key) {
      try {
        var raw = window.sessionStorage.getItem(key);
        if (!raw) return { comments: [], choices: {}, note: "" };
        var parsed = JSON.parse(raw);
        return {
          comments: Array.isArray(parsed.comments) ? parsed.comments : [],
          choices: parsed.choices && typeof parsed.choices === "object" ? parsed.choices : {},
          note: typeof parsed.note === "string" ? parsed.note : "",
        };
      } catch (error) {
        return { comments: [], choices: {}, note: "" };
      }
    }

    function saveDraft() {
      if (!state.key) return;
      try {
        window.sessionStorage.setItem(state.key, JSON.stringify({
          comments: state.comments,
          choices: state.choices,
          note: state.note,
        }));
      } catch (error) {
        /* storage unavailable */
      }
    }

    function clearDraft() {
      if (!state.key) return;
      try { window.sessionStorage.removeItem(state.key); } catch (error) { /* ignore */ }
    }

    // ------------------------------------------------------------------
    // Bind one pending interaction into the module store
    // ------------------------------------------------------------------

    function bind(pending, ctx, mode) {
      var review = mode === "review" ? reviewOf(pending) : null;
      var meta = review ? review.meta : null;
      var key = draftKeyOf(pending, meta);
      var saved = loadDraft(key);
      freeCommentSeq = 1;
      saved.comments.forEach(function (comment) {
        var match = /^free:(\d+)$/.exec(String(comment.key || ""));
        if (match) freeCommentSeq = Math.max(freeCommentSeq, Number(match[1]) + 1);
      });
      state = {
        pending: pending,
        mode: mode,
        meta: meta,
        body: review ? review.body : "",
        questions: pending.questions,
        comments: saved.comments,
        choices: saved.choices,
        note: saved.note,
        selection: null,
        error: null,
        busy: false,
        key: key,
      };
      emit();
      if (loadSettings().autoOpen) {
        try { ctx.sidebarRight.openTab(TAB_KIND); } catch (error) { /* sidebar unavailable */ }
      }
    }

    function unbind() {
      state = {
        pending: null, mode: null, meta: null, body: "", questions: [],
        comments: [], choices: {}, note: "", selection: null, error: null, busy: false, key: null,
      };
      emit();
    }

    // ------------------------------------------------------------------
    // Comment helpers
    // ------------------------------------------------------------------

    function commentOf(itemId) {
      return state.comments.find(function (comment) { return comment.itemId === itemId; }) || null;
    }

    function freeComments() {
      return state.comments.filter(function (comment) { return !comment.itemId; });
    }

    function upsertItemComment(itemId, note, quote) {
      var existing = commentOf(itemId);
      var text = String(note);
      var comments = state.comments.filter(function (comment) { return comment.itemId !== itemId; });
      if (text.trim() !== "" || quote) {
        comments.push({
          key: "item:" + itemId,
          itemId: itemId,
          quote: quote || (existing && existing.quote) || "",
          occurrence: existing ? existing.occurrence : 0,
          note: text,
        });
      }
      patch({ comments: comments });
      saveDraft();
    }

    function addFreeComment(quote, note, occurrence) {
      var comments = state.comments.concat([{
        key: "free:" + String(freeCommentSeq++),
        itemId: null,
        quote: quote,
        occurrence: occurrence || 0,
        note: note,
      }]);
      patch({ comments: comments, selection: null });
      saveDraft();
    }

    function removeComment(key) {
      patch({ comments: state.comments.filter(function (comment) { return comment.key !== key; }) });
      saveDraft();
    }

    function setChoice(questionId, label, multi) {
      var current = state.choices[questionId] || [];
      var next;
      if (multi === true) {
        next = current.indexOf(label) >= 0
          ? current.filter(function (entry) { return entry !== label; })
          : current.concat([label]);
      } else {
        next = current.length === 1 && current[0] === label ? [] : [label];
      }
      var choices = Object.assign({}, state.choices);
      choices[questionId] = next;
      patch({ choices: choices });
      saveDraft();
    }

    function setNote(note) {
      patch({ note: note });
      saveDraft();
    }

    // ------------------------------------------------------------------
    // Answer composition
    // ------------------------------------------------------------------

    function annotationsFromState() {
      var annotations = [];
      var meta = state.meta;
      if (meta) {
        (meta.items || []).forEach(function (item) {
          var comment = commentOf(item.id);
          var selected = state.choices[item.id] || [];
          var note = comment ? String(comment.note || "").trim() : "";
          if (note === "" && selected.length === 0) return;
          annotations.push({
            id: item.id,
            prompt: item.prompt || "",
            action: selected.length > 0 ? selected.join(",") : "comment",
            quote: (comment && comment.quote) || item.quote || "",
            note: note,
          });
        });
      }
      freeComments().forEach(function (comment) {
        annotations.push({
          id: "",
          prompt: "自由批注",
          action: "comment",
          quote: comment.quote || "",
          note: String(comment.note || ""),
        });
      });
      return annotations;
    }

    function renderAnnotationsMarkdown(annotations, note) {
      var parts = [];
      if (annotations.length > 0) {
        parts.push("## 批注（" + annotations.length + " 条）");
        annotations.forEach(function (entry, index) {
          parts.push("");
          var head = entry.id ? "【" + entry.id + "】" : "【自由批注】";
          if (entry.prompt && entry.prompt !== "自由批注") head += entry.prompt;
          parts.push((index + 1) + ". " + head);
          if (entry.quote) parts.push("   原文：「" + String(entry.quote).replace(/\s+/g, " ").trim() + "」");
          if (entry.action && entry.action !== "comment") parts.push("   选择：" + entry.action);
          if (entry.note) parts.push("   意见：" + entry.note);
        });
      }
      if (note.trim() !== "") {
        parts.push("");
        parts.push("## 整体意见");
        parts.push(note.trim());
      }
      return parts.join("\n");
    }

    function submitReview() {
      if (!state.pending || state.busy) return;
      var annotations = annotationsFromState();
      var note = String(state.note || "");
      if (annotations.length === 0 && note.trim() === "") {
        patch({ error: "还没有批注：写几条意见，或直接点「通过」" });
        return;
      }
      var declineLabel = state.meta && typeof state.meta.decline === "string" ? state.meta.decline : "提交批注";
      var payload = { v: 1, decision: "changes_requested", annotations: annotations, note: note.trim() };
      var custom = encodeAnswerPayload(payload) + "\n\n" + renderAnnotationsMarkdown(annotations, note);
      settle(function () {
        return state.pending.answer({ answers: [{ id: "review", selected: [declineLabel], custom: custom }] });
      });
    }

    function approveReview() {
      if (!state.pending || state.busy) return;
      var hasDraft = annotationsFromState().length > 0 || String(state.note || "").trim() !== "";
      if (hasDraft) {
        patch({ error: "还有未发送的批注：请先「提交批注」，或清空批注后再通过" });
        return;
      }
      var approveLabel = state.meta && typeof state.meta.approve === "string" ? state.meta.approve : "通过";
      settle(function () {
        return state.pending.answer({ answers: [{ id: "review", selected: [approveLabel] }] });
      });
    }

    function submitBatch() {
      if (!state.pending || state.busy) return;
      var answers = state.questions.map(function (question) {
        var selected = state.choices[question.id] || [];
        var comment = commentOf(question.id);
        var note = comment ? String(comment.note || "").trim() : "";
        if (note === "") return { id: question.id, selected: selected };
        var text = comment.quote
          ? "原文：「" + String(comment.quote).replace(/\s+/g, " ").trim() + "」\n" + note
          : note;
        return { id: question.id, selected: selected, custom: text };
      });
      var touched = answers.some(function (answer) {
        return answer.selected.length > 0 || typeof answer.custom === "string";
      });
      if (!touched && String(state.note || "").trim() === "") {
        patch({ error: "还没有作答：至少选一项或写一条批注" });
        return;
      }
      if (String(state.note || "").trim() !== "") {
        answers[answers.length - 1] = Object.assign({}, answers[answers.length - 1], {
          custom: [answers[answers.length - 1].custom, "【整体补充】" + state.note.trim()].filter(Boolean).join("\n"),
        });
      }
      settle(function () {
        return state.pending.answer({ answers: answers });
      });
    }

    function settle(send) {
      patch({ busy: true, error: null });
      send().then(function () {
        clearDraft();
        patch({ busy: false });
      }).catch(function (cause) {
        patch({ busy: false, error: cause instanceof Error ? cause.message : String(cause) });
      });
    }

    function dismiss() {
      if (!state.pending || state.busy) return;
      var pending = state.pending;
      patch({ busy: true, error: null });
      pending.dismiss().catch(function (cause) {
        patch({ busy: false, error: cause instanceof Error ? cause.message : String(cause) });
      });
    }

    // ------------------------------------------------------------------
    // Text-range helpers (CSS Custom Highlight API)
    // ------------------------------------------------------------------

    function collectTextNodes(root) {
      var nodes = [];
      var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
      var node = walker.nextNode();
      while (node) {
        nodes.push(node);
        node = walker.nextNode();
      }
      return nodes;
    }

    function findRange(root, quote, occurrence) {
      if (!quote) return null;
      var nodes = collectTextNodes(root);
      var full = nodes.map(function (node) { return node.nodeValue; }).join("");
      var index = -1;
      var from = 0;
      var target = occurrence || 0;
      for (var i = 0; i <= target; i += 1) {
        index = full.indexOf(quote, from);
        if (index < 0) return null;
        from = index + quote.length;
      }
      var startNode = null;
      var startOffset = 0;
      var endNode = null;
      var endOffset = 0;
      var cursor = 0;
      for (var n = 0; n < nodes.length; n += 1) {
        var length = nodes[n].nodeValue.length;
        if (startNode === null && index < cursor + length) {
          startNode = nodes[n];
          startOffset = index - cursor;
        }
        if (startNode !== null && index + quote.length <= cursor + length) {
          endNode = nodes[n];
          endOffset = index + quote.length - cursor;
          break;
        }
        cursor += length;
      }
      if (startNode === null || endNode === null) return null;
      var range = document.createRange();
      range.setStart(startNode, startOffset);
      range.setEnd(endNode, endOffset);
      return range;
    }

    function ensureHighlightStyle() {
      if (document.getElementById(HIGHLIGHT_STYLE_ID)) return;
      var style = document.createElement("style");
      style.id = HIGHLIGHT_STYLE_ID;
      style.textContent =
        "::highlight(" + HIGHLIGHT_ITEM + "){text-decoration:underline;text-decoration-color:rgba(77,107,254,0.85);text-decoration-thickness:2px;text-underline-offset:2px;}" +
        "::highlight(" + HIGHLIGHT_NOTE + "){background-color:rgba(255,196,0,0.22);}";
      document.head.appendChild(style);
    }

    function applyHighlights(root) {
      if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined") return;
      ensureHighlightStyle();
      var itemRanges = [];
      var noteRanges = [];
      if (state.meta) {
        (state.meta.items || []).forEach(function (item) {
          if (!item.quote) return;
          var range = findRange(root, item.quote, 0);
          if (range) itemRanges.push(range);
        });
      }
      state.comments.forEach(function (comment) {
        if (!comment.quote) return;
        var range = findRange(root, comment.quote, comment.occurrence || 0);
        if (range) noteRanges.push(range);
      });
      if (itemRanges.length > 0) CSS.highlights.set(HIGHLIGHT_ITEM, new Highlight(...itemRanges));
      else CSS.highlights.delete(HIGHLIGHT_ITEM);
      if (noteRanges.length > 0) CSS.highlights.set(HIGHLIGHT_NOTE, new Highlight(...noteRanges));
      else CSS.highlights.delete(HIGHLIGHT_NOTE);
    }

    function scrollToQuote(root, quote, occurrence) {
      var range = root ? findRange(root, quote, occurrence || 0) : null;
      if (!range) return;
      var element = range.startContainer.parentElement;
      if (element && typeof element.scrollIntoView === "function") {
        element.scrollIntoView({ block: "center" });
      }
    }

    // ------------------------------------------------------------------
    // Styles
    // ------------------------------------------------------------------

    var S = {
      bar: {
        display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap",
        padding: "8px 12px", border: BORDER, borderRadius: "8px",
        background: SOFT_BG, color: "inherit", font: "inherit", fontSize: "13px",
      },
      pane: { display: "flex", flexDirection: "column", height: "100%", minHeight: "0", font: "inherit" },
      header: { padding: "8px 16px", borderBottom: BORDER, fontSize: "12px", color: MUTED },
      scroll: { flex: "1 1 0", overflow: "auto", padding: "12px 16px", minHeight: "120px" },
      section: { borderTop: BORDER, padding: "10px 16px", background: SOFT_BG },
      item: { border: BORDER, borderRadius: "8px", padding: "8px 10px", marginBottom: "8px", fontSize: "12.5px", lineHeight: "1.55" },
      quote: { color: MUTED, fontSize: "12px", borderLeft: "2px solid rgba(127,127,127,0.4)", paddingLeft: "8px", margin: "4px 0", whiteSpace: "pre-wrap" },
      textarea: { width: "100%", minHeight: "54px", resize: "vertical", border: BORDER, borderRadius: "6px", background: "transparent", color: "inherit", padding: "6px 8px", font: "inherit", fontSize: "12.5px", boxSizing: "border-box" },
      button: { padding: "5px 12px", borderRadius: "6px", border: BORDER, background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", fontSize: "12.5px", lineHeight: "1.2" },
      primary: { padding: "5px 14px", borderRadius: "6px", border: "1px solid rgba(77,107,254,0.65)", background: "rgba(77,107,254,0.14)", color: "inherit", cursor: "pointer", font: "inherit", fontSize: "12.5px", fontWeight: 600, lineHeight: "1.2" },
      chip: { padding: "3px 9px", borderRadius: "999px", border: BORDER, background: "transparent", color: "inherit", cursor: "pointer", font: "inherit", fontSize: "12px" },
      chipActive: { padding: "3px 9px", borderRadius: "999px", border: "1px solid rgba(77,107,254,0.7)", background: "rgba(77,107,254,0.16)", color: "inherit", cursor: "pointer", font: "inherit", fontSize: "12px" },
      muted: { color: MUTED, fontSize: "12px" },
      error: { color: ERROR, fontSize: "12px" },
      row: { display: "flex", gap: "6px", alignItems: "center", flexWrap: "wrap" },
    };

    function buttonStyle(disabled, primary) {
      var base = primary ? Object.assign({}, S.primary) : Object.assign({}, S.button);
      if (disabled) {
        base.opacity = 0.45;
        base.cursor = "default";
      }
      return base;
    }

    // ------------------------------------------------------------------
    // Markdown rendering with a hard fallback
    // ------------------------------------------------------------------

    var Boundary = class Boundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }
      static getDerivedStateFromError() {
        return { failed: true };
      }
      render() {
        if (this.state.failed) return this.props.fallback;
        return this.props.children;
      }
    };

    var MarkdownBoundary = class MarkdownBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { failed: false };
      }
      static getDerivedStateFromError() {
        return { failed: true };
      }
      render() {
        if (this.state.failed) {
          return h("pre", { style: { whiteSpace: "pre-wrap", font: "inherit", margin: 0 } }, this.props.fallbackText);
        }
        return this.props.children;
      }
    };

    // A small, dependency-free renderer. The panel only needs headings, lists,
    // quotes, fenced code and pipe tables from a review body, so the plugin
    // carries its own parser instead of loading a Harness Client package as a
    // module. Everything below builds React nodes from strings, so no input can
    // reach the DOM as markup, and unsafe link targets degrade to plain text.
    var MD_STYLE = {
      h2: { margin: "14px 0 6px", fontSize: "15px", fontWeight: 600, lineHeight: "1.4" },
      h3: { margin: "12px 0 5px", fontSize: "14px", fontWeight: 600, lineHeight: "1.4" },
      h4: { margin: "10px 0 4px", fontSize: "13.5px", fontWeight: 600, lineHeight: "1.4" },
      p: { margin: "6px 0" },
      list: { margin: "6px 0", paddingLeft: "22px" },
      listItem: { margin: "2px 0" },
      quote: { margin: "6px 0", paddingLeft: "10px", borderLeft: "2px solid rgba(127,127,127,0.4)", color: MUTED },
      pre: { margin: "8px 0", padding: "8px 10px", borderRadius: "6px", background: SOFT_BG, overflow: "auto", fontSize: "12px", lineHeight: "1.5" },
      code: { padding: "1px 4px", borderRadius: "4px", background: SOFT_BG, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.92em" },
      table: { borderCollapse: "collapse", margin: "8px 0", fontSize: "12px", width: "100%" },
      th: { border: BORDER, padding: "4px 8px", textAlign: "left", background: SOFT_BG },
      td: { border: BORDER, padding: "4px 8px", verticalAlign: "top" },
      hr: { border: "none", borderTop: BORDER, margin: "10px 0" },
      link: { color: "inherit", textDecoration: "underline" },
    };

    var INLINE_RE = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\s]+\))/g;
    var SAFE_URL_RE = /^https?:\/\//i;

    function inlineMarkdown(text, keyPrefix) {
      var nodes = [];
      var cursor = 0;
      var key = 0;
      var match;
      INLINE_RE.lastIndex = 0;
      while ((match = INLINE_RE.exec(text)) !== null) {
        if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
        var token = match[0];
        var id = keyPrefix + ":i" + key;
        key += 1;
        if (token.charAt(0) === "`") {
          nodes.push(h("code", { key: id, style: MD_STYLE.code }, token.slice(1, -1)));
        } else if (token.slice(0, 2) === "**") {
          nodes.push(h("strong", { key: id }, token.slice(2, -2)));
        } else if (token.charAt(0) === "*") {
          nodes.push(h("em", { key: id }, token.slice(1, -1)));
        } else {
          var link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
          if (link && SAFE_URL_RE.test(link[2])) {
            nodes.push(h("a", { key: id, href: link[2], target: "_blank", rel: "noreferrer noopener", style: MD_STYLE.link }, link[1]));
          } else {
            nodes.push(token);
          }
        }
        cursor = match.index + token.length;
      }
      if (cursor < text.length) nodes.push(text.slice(cursor));
      return nodes;
    }

    function tableCells(line) {
      return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (cell) {
        return cell.trim();
      });
    }

    function isTableDivider(line) {
      return /\|/.test(line) && /^[\s|:-]*-[\s|:-]*$/.test(line);
    }

    function startsBlock(line) {
      return /^\s*```/.test(line)
        || /^#{1,6}\s+/.test(line)
        || /^\s*>\s?/.test(line)
        || /^\s*([-*+]|\d+[.)])\s+/.test(line)
        || /^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line);
    }

    function markdownBlocks(text, keyPrefix) {
      var lines = String(text === null || text === undefined ? "" : text).replace(/\r\n?/g, "\n").split("\n");
      var blocks = [];
      var index = 0;
      var key = 0;
      while (index < lines.length) {
        var line = lines[index];
        var id = keyPrefix + ":b" + key;
        key += 1;
        if (!line.trim()) {
          index += 1;
          continue;
        }
        if (/^\s*```/.test(line)) {
          var code = [];
          index += 1;
          while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
            code.push(lines[index]);
            index += 1;
          }
          index += 1;
          blocks.push(h("pre", { key: id, style: MD_STYLE.pre }, h("code", null, code.join("\n"))));
          continue;
        }
        var heading = /^(#{1,6})\s+(.*)$/.exec(line);
        if (heading) {
          var level = Math.min(heading[1].length + 1, 4);
          blocks.push(h("h" + level, { key: id, style: MD_STYLE["h" + level] }, inlineMarkdown(heading[2], id)));
          index += 1;
          continue;
        }
        if (/^\s*([-*_])\s*(?:\1\s*){2,}$/.test(line)) {
          blocks.push(h("hr", { key: id, style: MD_STYLE.hr }));
          index += 1;
          continue;
        }
        if (/\|/.test(line) && index + 1 < lines.length && isTableDivider(lines[index + 1])) {
          var header = tableCells(line);
          index += 2;
          var rows = [];
          while (index < lines.length && /\|/.test(lines[index]) && lines[index].trim()) {
            rows.push(tableCells(lines[index]));
            index += 1;
          }
          blocks.push(h("table", { key: id, style: MD_STYLE.table },
            h("thead", null, h("tr", null, header.map(function (cell, cellIndex) {
              return h("th", { key: id + ":h" + cellIndex, style: MD_STYLE.th }, inlineMarkdown(cell, id + ":h" + cellIndex));
            }))),
            h("tbody", null, rows.map(function (row, rowIndex) {
              return h("tr", { key: id + ":r" + rowIndex }, header.map(function (_, cellIndex) {
                var cellKey = id + ":r" + rowIndex + "c" + cellIndex;
                return h("td", { key: cellKey, style: MD_STYLE.td }, inlineMarkdown(row[cellIndex] || "", cellKey));
              }));
            }))));
          continue;
        }
        if (/^\s*>\s?/.test(line)) {
          var quoted = [];
          while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
            quoted.push(lines[index].replace(/^\s*>\s?/, ""));
            index += 1;
          }
          blocks.push(h("blockquote", { key: id, style: MD_STYLE.quote }, markdownBlocks(quoted.join("\n"), id)));
          continue;
        }
        if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
          var ordered = /^\s*\d+[.)]\s+/.test(line);
          var itemRe = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
          var items = [];
          while (index < lines.length && itemRe.test(lines[index])) {
            items.push(itemRe.exec(lines[index])[1]);
            index += 1;
          }
          var list = ordered ? "ol" : "ul";
          blocks.push(h(list, { key: id, style: MD_STYLE.list }, items.map(function (item, itemIndex) {
            var itemKey = id + ":l" + itemIndex;
            return h("li", { key: itemKey, style: MD_STYLE.listItem }, inlineMarkdown(item, itemKey));
          })));
          continue;
        }
        var paragraph = [line];
        index += 1;
        while (index < lines.length && lines[index].trim() && !startsBlock(lines[index])) {
          paragraph.push(lines[index]);
          index += 1;
        }
        blocks.push(h("p", { key: id, style: MD_STYLE.p }, inlineMarkdown(paragraph.join("\n"), id)));
      }
      return blocks;
    }

    function MarkdownBody(props) {
      return h(MarkdownBoundary, { fallbackText: props.text },
        h("div", { style: { fontSize: "13px", lineHeight: "1.65" } }, markdownBlocks(props.text, props.keyPrefix || "md")));
    }

    // ------------------------------------------------------------------
    // Composer bar
    // ------------------------------------------------------------------

    function StatusLine() {
      var snapshot = useStore();
      if (!snapshot.pending) return null;
      var count = snapshot.mode === "review"
        ? annotationsFromState().length
        : snapshot.questions.filter(function (question) {
            return (snapshot.choices[question.id] || []).length > 0 || commentOf(question.id) !== null;
          }).length;
      return h("span", { style: S.muted },
        snapshot.mode === "review"
          ? "交付批注 · " + count + " 条"
          : "确认批注 · " + count + "/" + snapshot.questions.length + " 题");
    }

    function ReviewBar(props) {
      var snapshot = useStore();
      var pending = props.matched || props.pendingInteraction;
      var ctx = props.ctx;

      React.useEffect(function () {
        if (!pending) return undefined;
        var mode = modeOf(pending);
        if (!mode) return undefined;
        if (!state.pending || state.pending.key !== pending.key) bind(pending, ctx, mode);
        return function () { /* keep state while the host owns the pending */ };
      }, [pending && pending.key]);

      if (!snapshot.pending) {
        return h("div", { style: S.bar },
          h("span", { style: { fontWeight: 600 } }, "交付批注"),
          h("span", { style: S.muted }, "正在准备评审面板…"));
      }

      var isReview = snapshot.mode === "review";
      var meta = snapshot.meta;

      function openPane() {
        try { ctx.sidebarRight.openTab(TAB_KIND); } catch (error) { /* ignore */ }
      }

      return h("div", null,
        h("div", { style: S.bar },
          h("span", { style: { fontWeight: 600 } }, "交付批注"),
          h(StatusLine),
          snapshot.error ? h("span", { style: S.error }, snapshot.error) : null,
          h("span", { style: { flex: "1 1 auto" } }),
          h("button", { style: buttonStyle(false), onClick: openPane }, "展开面板"),
          isReview
            ? h("button", { style: buttonStyle(snapshot.busy), disabled: snapshot.busy, onClick: submitReview }, "提交批注")
            : h("button", { style: buttonStyle(snapshot.busy), disabled: snapshot.busy, onClick: submitBatch }, "提交作答"),
          isReview
            ? h("button", { style: buttonStyle(snapshot.busy, true), disabled: snapshot.busy, onClick: approveReview }, meta ? meta.approve : "通过")
            : null,
          h("button", { style: buttonStyle(snapshot.busy), disabled: snapshot.busy, onClick: dismiss }, "关闭")
        )
      );
    }

    // ------------------------------------------------------------------
    // Resource addresses (portable across macOS, Linux and Windows)
    // ------------------------------------------------------------------
    // Mirrors the Harness' own fileAddressFor(): backslashes normalize to "/",
    // every segment is percent-encoded except ":" so a Windows drive letter keeps
    // its shape ("C:/tmp/a.docx"), and a path under the workspace root becomes
    // session-relative. Without this, "C:\Users\me\report.docx" would land in the
    // resource URL unencoded and the open button would silently do nothing.

    function encodeAddressSegment(segment) {
      return encodeURIComponent(segment).replace(/%3A/gi, ":");
    }

    function encodeAddressPath(value) {
      return String(value == null ? "" : value).split("/").map(encodeAddressSegment).join("/");
    }

    function isWindowsStylePath(value) {
      return /^[A-Za-z]:[/\\]/.test(value) || value.indexOf("\\\\") === 0;
    }

    function isAbsoluteWorkspacePath(value) {
      return value.charAt(0) === "/" || isWindowsStylePath(value);
    }

    function sessionFileAddress(sessionId, path) {
      var normalized = String(path == null ? "" : path).replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");
      return "dsh-resource://file/session/" + encodeAddressSegment(String(sessionId == null ? "" : sessionId))
        + "/" + encodeAddressPath(normalized);
    }

    function fileAddressFor(sessionId, cwd, path) {
      var normalized = String(path == null ? "" : path).replace(/\\/g, "/");
      if (!isAbsoluteWorkspacePath(normalized)) return sessionFileAddress(sessionId, normalized);
      var root = cwd == null ? "" : String(cwd).replace(/\\/g, "/").replace(/\/+$/, "");
      if (root !== "" && normalized === root) return sessionFileAddress(sessionId, "");
      if (root !== "" && normalized.indexOf(root + "/") === 0) {
        return sessionFileAddress(sessionId, normalized.slice(root.length + 1));
      }
      return sessionFileAddress(sessionId, normalized);
    }

    function baseNameOf(value) {
      var parts = String(value == null ? "" : value).split(/[\\/]/);
      return parts[parts.length - 1] || String(value);
    }

    // ------------------------------------------------------------------
    // Right sidebar pane
    // ------------------------------------------------------------------

    function ReviewPane(props) {
      var snapshot = useStore();
      var bodyRef = React.useRef(null);
      var tabInfo = props && typeof props.useTabInfo === "function" ? props.useTabInfo() : null;
      var ctx = props && props.ctx;

      function openFile(filePath) {
        try {
          var sid = snapshot.pending && snapshot.pending.sessionId;
          var address = fileAddressFor(sid, undefined, filePath);
          ctx.sidebarRight.openResource(address, { params: {} });
        } catch (error) {
          patch({ error: "无法打开文件：" + (error && error.message ? error.message : String(error)) });
        }
      }

      React.useEffect(function () {
        if (bodyRef.current) applyHighlights(bodyRef.current);
      }, [snapshot.comments, snapshot.choices, snapshot.body]);

      if (!snapshot.pending) {
        return h("div", { style: S.pane },
          h("div", { style: S.header }, "交付批注"),
          h("div", { style: { padding: "20px 16px", color: MUTED, fontSize: "13px" } },
            "当前没有待处理的交付评审。",
            h("div", { style: { marginTop: "8px" } }, "当 DSH 需要你逐条确认交付内容，或一次提出多题时，这里会出现评审面板。")));
      }

      function onMouseUp() {
        var container = bodyRef.current;
        var selection = window.getSelection();
        if (!container || !selection || selection.isCollapsed || selection.rangeCount === 0) return;
        var range = selection.getRangeAt(0);
        if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return;
        var quote = selection.toString();
        if (quote.trim() === "") return;
        var occurrence = snapshot.comments.filter(function (comment) { return comment.quote === quote; }).length;
        patch({ selection: { quote: quote, occurrence: occurrence, draft: "" }, error: null });
      }

      function addSelectionComment() {
        var selection = snapshot.selection;
        if (!selection) return;
        var draft = String(selection.draft || "").trim();
        if (draft === "") {
          patch({ error: "先写一句批注，再添加" });
          return;
        }
        addFreeComment(selection.quote, draft, selection.occurrence);
      }

      var isReview = snapshot.mode === "review";
      var meta = snapshot.meta;

      var header = h("div", { style: S.header },
        isReview && meta ? meta.title : "批量确认",
        h("span", { style: { marginLeft: "8px" } },
          isReview ? "· 交付评审" : "· " + snapshot.questions.length + " 个确认点"));

      var reviewBody = isReview
        ? h("div", null,
            meta && Array.isArray(meta.files) && meta.files.length > 0
              ? h("div", { style: Object.assign({}, S.row, { marginBottom: "8px" }) },
                  meta.files.map(function (file) {
                    return h("button", {
                      key: file,
                      style: Object.assign({}, S.chip, { cursor: "pointer" }),
                      title: "在右侧栏打开",
                      onClick: function () { openFile(file); },
                    }, "打开 " + baseNameOf(file));
                  }))
              : null,
            h("div", { style: { fontSize: "13px", lineHeight: "1.7" } },
              h(MarkdownBody, { text: snapshot.body })),
            h("div", { style: Object.assign({}, S.section, { marginTop: "12px", borderRadius: "8px" }) },
              h("div", { style: { fontWeight: 600, marginBottom: "8px" } }, "确认点 " + (meta ? meta.items.length : 0) + " 个"),
              (meta ? meta.items : []).map(function (item) {
                var comment = commentOf(item.id);
                var selected = snapshot.choices[item.id] || [];
                var options = Array.isArray(item.options) ? item.options : [];
                var fileIndex = /^f(\d+)$/.exec(String(item.id));
                var filePath = fileIndex && meta && Array.isArray(meta.files)
                  ? meta.files[Number(fileIndex[1]) - 1]
                  : null;
                return h("div", { key: item.id, style: S.item },
                  h("div", { style: { fontWeight: 600 } }, item.prompt),
                  filePath
                    ? h("button", {
                        style: Object.assign({}, S.button, { marginTop: "4px", padding: "2px 8px", fontSize: "11.5px" }),
                        onClick: function () { openFile(filePath); },
                      }, "打开文件")
                    : null,
                  item.quote
                    ? h("div", { style: S.quote },
                        "「" + item.quote + "」",
                        h("button", {
                          style: Object.assign({}, S.button, { marginLeft: "8px", padding: "1px 6px", fontSize: "11px" }),
                          onClick: function () { scrollToQuote(bodyRef.current, item.quote, 0); },
                        }, "定位"))
                    : null,
                  options.length > 0
                    ? h("div", { style: Object.assign({}, S.row, { margin: "6px 0" }) },
                        options.map(function (option) {
                          var active = selected.indexOf(option.label) >= 0;
                          return h("button", {
                            key: option.label,
                            title: option.description || "",
                            style: active ? S.chipActive : S.chip,
                            onClick: function () { setChoice(item.id, option.label, item.multiSelect === true); },
                          }, option.label);
                        }))
                    : null,
                  h("textarea", {
                    style: S.textarea,
                    placeholder: "对这一条写批注（可留空）",
                    value: comment ? comment.note : "",
                    onChange: function (event) { upsertItemComment(item.id, event.target.value, item.quote); },
                  }),
                  comment && comment.quote && comment.quote !== item.quote
                    ? h("div", { style: S.quote }, "原文：「" + comment.quote + "」")
                    : null);
              })))
        : null;

      var batchBody = !isReview
        ? h("div", null,
            snapshot.questions.map(function (question, index) {
              var comment = commentOf(question.id);
              var selected = snapshot.choices[question.id] || [];
              var options = Array.isArray(question.options) ? question.options : [];
              return h("div", { key: question.id, style: S.item },
                h("div", { style: { fontWeight: 600, marginBottom: "2px" } },
                  (index + 1) + ". " + (question.header ? question.header + " · " : "") + question.question),
                options.length > 0
                  ? h("div", { style: Object.assign({}, S.row, { margin: "6px 0" }) },
                      options.map(function (option) {
                        var active = selected.indexOf(option.label) >= 0;
                        return h("button", {
                          key: option.label,
                          title: option.description || "",
                          style: active ? S.chipActive : S.chip,
                          onClick: function () { setChoice(question.id, option.label, question.multiSelect === true); },
                        }, option.label);
                      }))
                  : null,
                h("textarea", {
                  style: S.textarea,
                  placeholder: "对这一题写批注（可留空）",
                  value: comment ? comment.note : "",
                  onChange: function (event) { upsertItemComment(question.id, event.target.value, ""); },
                }));
            }))
        : null;

      var selectionBox = snapshot.selection
        ? h("div", { style: Object.assign({}, S.section, { borderTop: "none" }) },
            h("div", { style: S.muted }, "已选：「" + snapshot.selection.quote.slice(0, 80) + "」"),
            h("textarea", {
              style: S.textarea,
              placeholder: "针对这段原文写批注",
              value: snapshot.selection.draft || "",
              onChange: function (event) {
                patch({ selection: Object.assign({}, snapshot.selection, { draft: event.target.value }) });
              },
            }),
            h("div", { style: Object.assign({}, S.row, { marginTop: "6px" }) },
              h("button", { style: buttonStyle(false), onClick: addSelectionComment }, "添加批注"),
              h("button", { style: buttonStyle(false), onClick: function () { patch({ selection: null }); } }, "取消")))
        : null;

      var freeList = freeComments();

      return h("div", { style: S.pane },
        header,
        h("div", { style: S.scroll, ref: bodyRef, onMouseUp: onMouseUp },
          reviewBody,
          batchBody,
          freeList.length > 0
            ? h("div", { style: Object.assign({}, S.section, { marginTop: "10px", borderRadius: "8px" }) },
                h("div", { style: { fontWeight: 600, marginBottom: "6px" } }, "划词批注 " + freeList.length + " 条"),
                freeList.map(function (comment) {
                  return h("div", { key: comment.key, style: S.item },
                    h("div", { style: S.quote }, "「" + String(comment.quote || "").slice(0, 140) + "」"),
                    h("div", { style: { whiteSpace: "pre-wrap" } }, comment.note),
                    h("div", { style: Object.assign({}, S.row, { marginTop: "4px" }) },
                      h("button", {
                        style: Object.assign({}, S.button, { padding: "1px 6px", fontSize: "11px" }),
                        onClick: function () { scrollToQuote(bodyRef.current, comment.quote, comment.occurrence || 0); },
                      }, "定位"),
                      h("button", {
                        style: Object.assign({}, S.button, { padding: "1px 6px", fontSize: "11px" }),
                        onClick: function () { removeComment(comment.key); },
                      }, "删除")));
                }))
            : null,
          selectionBox),
        h("div", { style: S.section },
          h("div", { style: S.muted }, "整体意见（可留空）"),
          h("textarea", {
            style: S.textarea,
            value: snapshot.note,
            onChange: function (event) { setNote(event.target.value); },
          })),
        h("div", { style: Object.assign({}, S.section, { borderTop: BORDER }) },
          snapshot.error ? h("div", { style: Object.assign({}, S.error, { marginBottom: "6px" }) }, snapshot.error) : null,
          h("div", { style: S.row },
            isReview
              ? h("button", { style: buttonStyle(snapshot.busy, true), disabled: snapshot.busy, onClick: submitReview }, "提交批注")
              : h("button", { style: buttonStyle(snapshot.busy, true), disabled: snapshot.busy, onClick: submitBatch }, "提交作答"),
            isReview
              ? h("button", { style: buttonStyle(snapshot.busy), disabled: snapshot.busy, onClick: approveReview }, meta ? meta.approve : "通过")
              : null,
            h("button", { style: buttonStyle(snapshot.busy), disabled: snapshot.busy, onClick: dismiss }, "关闭")))
      );
    }

    // ------------------------------------------------------------------
    // Settings section
    // ------------------------------------------------------------------

    function SettingsSection() {
      var initial = loadSettings();
      var statePair = React.useState(initial);
      var current = statePair[0];
      var setCurrent = statePair[1];

      function change(changes) {
        var next = Object.assign({}, current, changes);
        setCurrent(next);
        saveSettings(next);
      }

      return h("div", { style: { padding: "8px 0", maxWidth: "640px" } },
        h("h3", { style: { margin: "0 0 6px", fontSize: "15px" } }, "交付批注"),
        h("p", { style: { color: MUTED, fontSize: "12.5px", lineHeight: "1.6", margin: "0 0 14px" } },
          "多题确认接管门槛与面板行为。改动在下一轮确认请求生效。"),
        h("label", { style: { display: "block", marginBottom: "14px" } },
          h("div", { style: { fontSize: "13px", marginBottom: "4px" } }, "接管门槛：一次提问至少几题时接管"),
          h("input", {
            type: "number",
            min: 2,
            max: 20,
            value: current.minQuestions,
            style: { width: "88px", padding: "4px 8px", border: BORDER, borderRadius: "6px", background: "transparent", color: "inherit", font: "inherit" },
            onChange: function (event) {
              var value = Number(event.target.value);
              if (!Number.isFinite(value)) return;
              change({ minQuestions: Math.max(2, Math.min(20, Math.round(value))) });
            },
          }),
          h("div", { style: Object.assign({}, S.muted, { marginTop: "4px" }) }, "默认 3（即超过 2 题时接管）。单题确认仍走原生卡片。")),
        h("label", { style: { display: "flex", alignItems: "center", gap: "8px", fontSize: "13px" } },
          h("input", {
            type: "checkbox",
            checked: current.autoOpen,
            onChange: function (event) { change({ autoOpen: event.target.checked }); },
          }),
          "评审请求到来时自动展开右侧面板"));
    }

    // ------------------------------------------------------------------
    // Crash guards: a throwing component must never blank the composer
    // ------------------------------------------------------------------

    function ReviewBarSafe(props) {
      var pending = props.matched || props.pendingInteraction;
      return h(Boundary, {
        fallback: h("div", { style: S.bar },
          h("span", { style: S.error }, "交付批注面板加载失败；"),
          h("button", {
            style: S.button,
            onClick: function () {
              try { if (pending && typeof pending.dismiss === "function") pending.dismiss(); } catch (error) { /* ignore */ }
            },
          }, "关闭本次评审")),
      }, h(ReviewBar, props));
    }

    function ReviewPaneSafe(props) {
      return h(Boundary, {
        fallback: h("div", { style: { padding: "16px", color: MUTED, fontSize: "13px" } },
          "交付批注面板渲染失败。可在对话区操作条上提交或关闭本次评审。"),
      }, h(ReviewPane, props));
    }

    function SettingsSectionSafe(props) {
      return h(Boundary, {
        fallback: h("div", { style: { padding: "16px", color: MUTED, fontSize: "13px" } },
          "交付批注设置渲染失败。请重新加载页面后再试。"),
      }, h(SettingsSection, props));
    }

    // ------------------------------------------------------------------
    // Plugin entry
    // ------------------------------------------------------------------

    var inject = ["slots", "sidebarRight", "sidebarRightTabs"];

    function apply(ctx) {
      ctx.effect(function () {
        return ctx.sidebarRightTabs.register({
          id: TAB_ID,
          kind: TAB_KIND,
          title: function () { return "交付批注"; },
        });
      }, "review-note: sidebar tab type");

      ctx.effect(function () {
        return ctx.slots.register({
          name: "sidebar.right.pane.tab",
          key: TAB_ID,
          inject: function () { return { ctx: ctx }; },
        }, ReviewPaneSafe);
      }, "review-note: sidebar pane body");

      ctx.slots.inject("settings.section", function () {
        return ctx.slots.register({
          name: "settings.section",
          id: TAB_ID,
          order: 26,
          label: function () { return "交付批注"; },
        }, SettingsSectionSafe);
      });

      ctx.slots.inject("conversation.composer", function () {
        return ctx.slots.register({
          name: "conversation.composer",
          priority: -1,
          select: function (owner) {
            var pending = owner && owner.pendingInteraction;
            if (!pending) return null;
            try {
              return modeOf(pending) === null ? null : pending;
            } catch (error) {
              return null;
            }
          },
          inject: function () { return { ctx: ctx }; },
        }, ReviewBarSafe);
      });
    }

    // `internal` exists so the unit tests can exercise the pure helpers without
    // a browser; the ModuleLoader only reads name / inject / apply.
    return {
      name: "dsh-review-note",
      inject: inject,
      apply: apply,
      internal: {
        markdownBlocks: markdownBlocks,
        inlineMarkdown: inlineMarkdown,
        fileAddressFor: fileAddressFor,
        baseNameOf: baseNameOf,
      },
    };
  },
});
