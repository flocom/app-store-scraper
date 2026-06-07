"use strict";

const $ = (sel) => document.querySelector(sel);
const tokenInput = $("#token");
const statusDot = $("#status-dot");

let catalogue = []; // [{name,title,description,schema}]
let current = null; // active method def
let lastResult = null;

// --- token persistence ------------------------------------------------------
tokenInput.value = localStorage.getItem("ass_token") || "";
tokenInput.addEventListener("input", () => {
  localStorage.setItem("ass_token", tokenInput.value.trim());
  ping();
});

function authHeaders(extra) {
  const h = Object.assign({ "Content-Type": "application/json" }, extra || {});
  const t = tokenInput.value.trim();
  if (t) h["Authorization"] = "Bearer " + t;
  return h;
}

// --- connection status ------------------------------------------------------
async function ping() {
  try {
    const r = await fetch("./api/methods", { headers: authHeaders() });
    statusDot.className = r.ok ? "dot ok" : "dot err";
    statusDot.title = r.ok ? "connected" : "auth failed (" + r.status + ")";
  } catch {
    statusDot.className = "dot err";
    statusDot.title = "unreachable";
  }
}

// --- bootstrap --------------------------------------------------------------
async function boot() {
  try {
    const r = await fetch("./api/methods", { headers: authHeaders() });
    if (!r.ok) {
      // Still try unauthenticated health to list method names.
      const h = await (await fetch("./healthz")).json();
      catalogue = (h.methods || []).map((n) => ({
        name: n,
        title: n,
        description: "Enter a token above to load this method.",
        schema: { properties: {}, required: [] },
      }));
    } else {
      catalogue = await r.json();
    }
  } catch (e) {
    catalogue = [];
  }
  renderTabs();
  if (catalogue.length) selectMethod(catalogue[0].name);
  ping();
}

function renderTabs() {
  const nav = $("#method-tabs");
  nav.innerHTML = "";
  for (const m of catalogue) {
    const b = document.createElement("button");
    b.textContent = m.title || m.name;
    b.dataset.name = m.name;
    b.addEventListener("click", () => selectMethod(m.name));
    nav.appendChild(b);
  }
}

function selectMethod(name) {
  current = catalogue.find((m) => m.name === name);
  if (!current) return;
  document
    .querySelectorAll("#method-tabs button")
    .forEach((b) => b.classList.toggle("active", b.dataset.name === name));
  $("#method-title").textContent = current.title || current.name;
  $("#method-desc").textContent = current.description || "";
  renderForm(current);
  $("#result").innerHTML = "";
  $("#result-meta").textContent = "";
}

// --- form generation from JSON schema --------------------------------------
function renderForm(m) {
  const form = $("#method-form");
  form.innerHTML = "";
  const props = (m.schema && m.schema.properties) || {};
  const required = (m.schema && m.schema.required) || [];
  for (const [key, spec] of Object.entries(props)) {
    form.appendChild(field(key, spec, required.includes(key)));
  }
}

function field(key, spec, isRequired) {
  const wrap = document.createElement("div");
  wrap.className = "field";

  const label = document.createElement("label");
  label.textContent = key;
  if (isRequired) {
    const r = document.createElement("span");
    r.className = "req";
    r.textContent = "*";
    label.appendChild(r);
  }
  wrap.appendChild(label);

  let input;
  const enumVals = spec.enum || (spec.anyOf && spec.anyOf.find((s) => s.enum)?.enum);
  const type = spec.type || (spec.anyOf && spec.anyOf.find((s) => s.type)?.type);

  if (enumVals) {
    input = document.createElement("select");
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = isRequired ? "— select —" : "(default)";
    input.appendChild(blank);
    for (const v of enumVals) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = v;
      input.appendChild(o);
    }
  } else if (type === "boolean") {
    input = document.createElement("input");
    input.type = "checkbox";
  } else {
    input = document.createElement("input");
    input.type = type === "number" || type === "integer" ? "number" : "text";
    input.placeholder = isRequired ? "required" : "optional";
  }
  input.dataset.key = key;
  input.dataset.jtype = type || "string";
  wrap.appendChild(input);

  if (spec.description) {
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = spec.description;
    wrap.appendChild(hint);
  }
  return wrap;
}

function collectArgs() {
  const args = {};
  for (const el of $("#method-form").querySelectorAll("[data-key]")) {
    const key = el.dataset.key;
    const jtype = el.dataset.jtype;
    if (el.type === "checkbox") {
      if (el.checked) args[key] = true;
      continue;
    }
    const v = el.value.trim();
    if (v === "") continue;
    if (jtype === "number" || jtype === "integer") args[key] = Number(v);
    else args[key] = v;
  }
  return args;
}

// --- run --------------------------------------------------------------------
$("#run-btn").addEventListener("click", run);

async function run() {
  if (!current) return;
  const btn = $("#run-btn");
  btn.disabled = true;
  btn.textContent = "Running…";
  $("#result").innerHTML = '<div class="spinner">⏳ Fetching…</div>';
  $("#result-meta").textContent = "";
  const t0 = performance.now();
  try {
    const r = await fetch("./api/" + current.name, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(collectArgs()),
    });
    const data = await r.json();
    const ms = Math.round(performance.now() - t0);
    if (!r.ok) {
      renderError(data, r.status);
      $("#result-meta").textContent = r.status + " · " + ms + "ms";
      return;
    }
    lastResult = data.result;
    render(data.result);
    const count = Array.isArray(data.result) ? data.result.length + " items · " : "";
    $("#result-meta").textContent = count + ms + "ms";
  } catch (e) {
    renderError({ error: String(e) }, 0);
  } finally {
    btn.disabled = false;
    btn.textContent = "Run ▶";
  }
}

function renderError(data, status) {
  const el = $("#result");
  el.innerHTML = "";
  const d = document.createElement("div");
  d.className = "error";
  d.textContent =
    (status ? "[" + status + "] " : "") +
    (data.error || "Request failed") +
    (data.issues ? "\n" + JSON.stringify(data.issues, null, 2) : "");
  d.style.whiteSpace = "pre-wrap";
  el.appendChild(d);
}

// --- result rendering -------------------------------------------------------
function render(result) {
  const el = $("#result");
  el.innerHTML = "";
  if ($("#raw-toggle").checked) return rawJson(el, result);

  if (Array.isArray(result) && result.length && looksLikeApp(result[0])) {
    return el.appendChild(appCards(result));
  }
  if (Array.isArray(result) && result.length && isReview(result[0])) {
    return el.appendChild(reviewList(result));
  }
  if (result && looksLikeApp(result)) {
    return el.appendChild(appCards([result]));
  }
  rawJson(el, result);
}

function rawJson(el, result) {
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(result, null, 2);
  el.appendChild(pre);
}

const looksLikeApp = (o) => o && typeof o === "object" && "title" in o && "icon" in o;
const isReview = (o) => o && typeof o === "object" && "score" in o && "text" in o && "userName" in o;

function appCards(apps) {
  const grid = document.createElement("div");
  grid.className = "cards";
  for (const a of apps) {
    const card = document.createElement("div");
    card.className = "card";
    const img = document.createElement("img");
    img.src = a.icon || "";
    img.alt = "";
    img.loading = "lazy";
    card.appendChild(img);
    const ct = document.createElement("div");
    ct.className = "ct";
    const link = document.createElement("a");
    link.href = a.url || "#";
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = a.title || "(untitled)";
    ct.appendChild(link);
    ct.appendChild(line("dev", a.developer || ""));
    const score = a.score != null ? "★ " + Number(a.score).toFixed(2) : "";
    const price = a.free ? "Free" : (a.price ?? "") + " " + (a.currency || "");
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML =
      (score ? score + " · " : "") +
      '<span class="price">' + esc(price) + "</span>" +
      (a.primaryGenre ? " · " + esc(a.primaryGenre) : "");
    ct.appendChild(meta);
    card.appendChild(ct);
    grid.appendChild(card);
  }
  return grid;
}

function reviewList(reviews) {
  const box = document.createElement("div");
  for (const rv of reviews) {
    const d = document.createElement("div");
    d.className = "review";
    const head = document.createElement("div");
    head.className = "rh";
    const title = document.createElement("span");
    title.className = "title";
    title.textContent = rv.title || "";
    const stars = document.createElement("span");
    stars.className = "stars";
    stars.textContent = "★".repeat(Math.round(rv.score || 0)) + "☆".repeat(5 - Math.round(rv.score || 0));
    head.appendChild(title);
    head.appendChild(stars);
    d.appendChild(head);
    d.appendChild(line("dev", (rv.userName || "") + (rv.version ? " · v" + rv.version : "")));
    const text = document.createElement("div");
    text.className = "text";
    text.textContent = rv.text || "";
    d.appendChild(text);
    box.appendChild(d);
  }
  return box;
}

function line(cls, text) {
  const d = document.createElement("div");
  d.className = cls;
  d.textContent = text;
  return d;
}
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// --- raw toggle + copy ------------------------------------------------------
$("#raw-toggle").addEventListener("change", () => {
  if (lastResult != null) render(lastResult);
});

$("#copy-btn").addEventListener("click", async () => {
  if (lastResult == null) return;
  await navigator.clipboard.writeText(JSON.stringify(lastResult, null, 2));
  const b = $("#copy-btn");
  b.textContent = "Copied!";
  setTimeout(() => (b.textContent = "Copy"), 1200);
});

boot();
