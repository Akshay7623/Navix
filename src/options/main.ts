import type { PermissionStore, ProviderId, Settings } from "../shared/types";
import { PROVIDERS, PROVIDER_LIST } from "../shared/providers";
import { sendRequest } from "../shared/messaging";
import { icon, mountIcons } from "../shared/icons";

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

mountIcons();

const providerSel = $<HTMLSelectElement>("provider");
const baseUrlInput = $<HTMLInputElement>("baseUrl");
const apiKeyInput = $<HTMLInputElement>("apiKey");
const modelInput = $<HTMLInputElement>("model");
const modelList = $<HTMLDataListElement>("modelList");
const providerNotes = $<HTMLParagraphElement>("providerNotes");
const endpointPreview = $<HTMLElement>("endpointPreview");
const temperatureInput = $<HTMLInputElement>("temperature");
const maxTokensInput = $<HTMLInputElement>("maxTokens");
const maxStepsInput = $<HTMLInputElement>("maxSteps");
const reasoningEffortSel = $<HTMLSelectElement>("reasoningEffort");
const systemPromptExtra = $<HTMLTextAreaElement>("systemPromptExtra");
const visionEnabledInput = $<HTMLInputElement>("visionEnabled");
const approvalModeSel = $<HTMLSelectElement>("approvalMode");
const safetyModeSel = $<HTMLSelectElement>("safetyMode");
const dialogPolicySel = $<HTMLSelectElement>("dialogPolicy");
const visualFeedbackInput = $<HTMLInputElement>("visualFeedback");
const permList = $<HTMLUListElement>("permList");
const clearPermsBtn = $<HTMLButtonElement>("clearPerms");
const saveBtn = $<HTMLButtonElement>("save");
const statusEl = $<HTMLElement>("status");
const dirtyEl = $<HTMLElement>("dirty");
const providerCards = $<HTMLElement>("providerCards");
const toggleKeyBtn = $<HTMLButtonElement>("toggleKey");
const form = $<HTMLElement>("form");

let current: Settings | null = null;

/* ---------- segmented controls ---------- */

/** Redraws every custom control from its <select>; called after values are set in code. */
const syncers: Array<() => void> = [];

/**
 * Draw a <select data-segmented> as a row of buttons. The select stays the
 * source of truth (save() reads it), so the buttons only set its value.
 */
function segmented(select: HTMLSelectElement): void {
  const group = document.createElement("div");
  group.className = "segmented";
  group.setAttribute("role", "radiogroup");
  const labelledBy = select.getAttribute("aria-labelledby");
  if (labelledBy) group.setAttribute("aria-labelledby", labelledBy);

  const desc = document.createElement("small");
  desc.className = "seg-desc";

  const options = Array.from(select.options);
  const buttons = options.map((opt) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "seg";
    btn.setAttribute("role", "radio");
    btn.textContent = opt.dataset.short ?? opt.textContent ?? opt.value;
    btn.title = opt.textContent ?? "";
    btn.addEventListener("click", () => {
      if (select.value === opt.value) return;
      select.value = opt.value;
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return btn;
  });

  const sync = () => {
    options.forEach((opt, i) => {
      const on = opt.value === select.value;
      buttons[i].classList.toggle("on", on);
      buttons[i].setAttribute("aria-checked", String(on));
      buttons[i].tabIndex = on ? 0 : -1;
    });
    desc.textContent = select.selectedOptions[0]?.dataset.desc ?? "";
  };

  // Arrow keys move between segments, like a native radio group.
  group.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const i = options.findIndex((o) => o.value === select.value);
    const next = (i + (e.key === "ArrowRight" ? 1 : -1) + options.length) % options.length;
    buttons[next].click();
    buttons[next].focus();
  });

  group.append(...buttons);
  select.after(group, desc);
  select.addEventListener("change", sync);
  syncers.push(sync);
  sync();
}

for (const select of Array.from(document.querySelectorAll<HTMLSelectElement>("select[data-segmented]"))) {
  segmented(select);
}

/** Provider presets as cards; the hidden #provider select keeps the value. */
function renderProviderCards(): void {
  const cards = PROVIDER_LIST.map((preset) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "preset";
    card.setAttribute("role", "radio");
    card.dataset.value = preset.id;

    const name = document.createElement("span");
    name.className = "preset-name";
    name.textContent = preset.id === "custom" ? "Custom endpoint" : preset.id === "qwen" ? "Qwen (DashScope)" : preset.label;

    const host = document.createElement("span");
    host.className = "preset-host";
    try {
      host.textContent = preset.id === "custom" ? "vLLM, SGLang, Modal, Ollama…" : new URL(preset.baseUrl).host;
    } catch {
      host.textContent = preset.baseUrl;
    }

    const check = document.createElement("span");
    check.className = "preset-check";
    check.append(icon("check", 11));

    card.append(name, host, check);
    card.addEventListener("click", () => {
      if (providerSel.value === preset.id) return;
      providerSel.value = preset.id;
      providerSel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    return card;
  });
  providerCards.replaceChildren(...cards);

  const sync = () => {
    for (const card of cards) {
      const on = card.dataset.value === providerSel.value;
      card.classList.toggle("on", on);
      card.setAttribute("aria-checked", String(on));
    }
  };
  providerSel.addEventListener("change", sync);
  syncers.push(sync);
  sync();
}

/* ---------- API key visibility ---------- */

function renderKeyToggle(): void {
  const shown = apiKeyInput.type === "text";
  toggleKeyBtn.replaceChildren(icon(shown ? "hide" : "eye", 16));
  toggleKeyBtn.title = shown ? "Hide key" : "Show key";
  toggleKeyBtn.setAttribute("aria-label", toggleKeyBtn.title);
  toggleKeyBtn.setAttribute("aria-pressed", String(shown));
}

toggleKeyBtn.addEventListener("click", () => {
  apiKeyInput.type = apiKeyInput.type === "password" ? "text" : "password";
  renderKeyToggle();
});
renderKeyToggle();

/* ---------- unsaved changes ---------- */

let dirty = false;

function setDirty(next: boolean): void {
  dirty = next;
  dirtyEl.classList.toggle("hidden", !next);
  if (next) statusEl.textContent = "";
}

form.addEventListener("input", () => setDirty(true));
form.addEventListener("change", (e) => {
  // Clearing remembered sites saves at once; it is not an unsaved change.
  if ((e.target as HTMLElement).closest("#permList")) return;
  setDirty(true);
});

window.addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault();
});

/* ---------- section nav ---------- */

function watchSections(): void {
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>(".nav-link"));
  const byId = new Map(links.map((a) => [a.getAttribute("href")?.slice(1) ?? "", a]));
  const visible = new Set<string>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) visible.add(entry.target.id);
        else visible.delete(entry.target.id);
      }
      // Highlight the first section on screen, in page order.
      const first = Array.from(byId.keys()).find((id) => visible.has(id));
      for (const [id, link] of byId) link.classList.toggle("active", id === first);
    },
    { rootMargin: "-10% 0px -55% 0px" },
  );
  for (const id of byId.keys()) {
    const el = document.getElementById(id);
    if (el) observer.observe(el);
  }
}

function renderEndpoint(): void {
  endpointPreview.textContent = baseUrlInput.value.trim() || "—";
}

function renderModels(provider: ProviderId): void {
  const preset = PROVIDERS[provider];
  modelList.replaceChildren(
    ...preset.models.map((m) => {
      const opt = document.createElement("option");
      opt.value = m;
      return opt;
    }),
  );
  providerNotes.textContent = preset.notes;
}

function applyProvider(provider: ProviderId, keepModel: boolean): void {
  const preset = PROVIDERS[provider];
  baseUrlInput.value = preset.baseUrl;
  if (!keepModel) modelInput.value = preset.defaultModel;
  renderModels(provider);
  renderEndpoint();
}

async function loadPermissions(): Promise<void> {
  const store = await sendRequest<PermissionStore>({ type: "permissions/list" });
  const entries = Object.values(store.domains).sort((a, b) => b.updatedAt - a.updatedAt);

  if (!entries.length) {
    const li = document.createElement("li");
    li.className = "perm-empty";
    li.textContent = "No remembered domains yet.";
    permList.replaceChildren(li);
    return;
  }

  permList.replaceChildren(
    ...entries.map((entry) => {
      const li = document.createElement("li");

      const origin = document.createElement("span");
      origin.className = "perm-origin";
      origin.textContent = entry.origin;

      const state = document.createElement("span");
      state.className = `perm-state ${entry.state}`;
      state.textContent = entry.state;

      const remove = document.createElement("button");
      remove.className = "btn ghost small";
      remove.textContent = "Remove";
      remove.addEventListener("click", async () => {
        await sendRequest({ type: "permissions/clear", origin: entry.origin });
        await loadPermissions();
      });

      li.append(origin, state, remove);
      return li;
    }),
  );
}

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle("err", isError);
  if (text) {
    setTimeout(() => {
      statusEl.textContent = "";
      statusEl.classList.remove("err");
    }, 2600);
  }
}

async function save(): Promise<void> {
  if (!current) return;

  const patch: Partial<Settings> = {
    provider: providerSel.value as ProviderId,
    baseUrl: baseUrlInput.value.trim(),
    apiKey: apiKeyInput.value.trim(),
    model: modelInput.value.trim(),
    temperature: Number(temperatureInput.value),
    maxTokens: Number(maxTokensInput.value),
    maxSteps: Number(maxStepsInput.value),
    reasoningEffort: reasoningEffortSel.value as Settings["reasoningEffort"],
    approvalMode: approvalModeSel.value as Settings["approvalMode"],
    safetyMode: safetyModeSel.value as Settings["safetyMode"],
    dialogPolicy: dialogPolicySel.value as Settings["dialogPolicy"],
    visualFeedback: visualFeedbackInput.checked,
    systemPromptExtra: systemPromptExtra.value,
    visionEnabled: visionEnabledInput.checked,
  };

  if (!patch.baseUrl) {
    setStatus("API URL is required.", true);
    return;
  }
  if (!patch.model) {
    setStatus("Model is required.", true);
    return;
  }

  try {
    current = await sendRequest<Settings>({ type: "settings/set", settings: patch });
    setDirty(false);
    setStatus("Saved");
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err), true);
  }
}

async function boot(): Promise<void> {
  providerSel.replaceChildren(
    ...PROVIDER_LIST.map((p) => {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = p.label;
      return opt;
    }),
  );

  current = await sendRequest<Settings>({ type: "settings/get" });

  providerSel.value = current.provider;
  baseUrlInput.value = current.baseUrl;
  apiKeyInput.value = current.apiKey;
  modelInput.value = current.model;
  temperatureInput.value = String(current.temperature);
  maxTokensInput.value = String(current.maxTokens);
  maxStepsInput.value = String(current.maxSteps);
  reasoningEffortSel.value = current.reasoningEffort;
  systemPromptExtra.value = current.systemPromptExtra;
  visionEnabledInput.checked = current.visionEnabled;
  approvalModeSel.value = current.approvalMode;
  safetyModeSel.value = current.safetyMode;
  dialogPolicySel.value = current.dialogPolicy;
  visualFeedbackInput.checked = current.visualFeedback;

  renderModels(current.provider);
  renderEndpoint();
  renderProviderCards();
  for (const sync of syncers) sync();
  setDirty(false);
  watchSections();
  await loadPermissions();
}

providerSel.addEventListener("change", () => {
  applyProvider(providerSel.value as ProviderId, false);
});

baseUrlInput.addEventListener("input", renderEndpoint);

saveBtn.addEventListener("click", () => void save());

clearPermsBtn.addEventListener("click", async () => {
  await sendRequest({ type: "permissions/clear" });
  await loadPermissions();
  setStatus("Cleared");
});

document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    void save();
  }
});

void boot();
