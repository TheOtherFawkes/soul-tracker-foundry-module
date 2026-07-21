const MODULE_ID = "soul-tracker";
let socket;

/* ---------- Default alert presets (edit freely) ---------- */
const DEFAULT_COMMANDS = {
  immediate: [
    "You feel a cold pressure behind your eyes. Something is inside you now. For the next scene, you no longer control your character — describe only what your body does at the GM's direction.",
    "Your limbs move without your consent. You are a passenger in your own flesh. Do not act on your own initiative until told the presence has left.",
    "A voice that is not yours fills your skull. You will obey it. Await private instructions from the GM before taking any action."
  ],
  silent: [
    "(silent) Host acquired — no player notice sent.",
    "(silent) Parasite dormant; player unaware."
  ]
};

/* ---------- State helpers ---------- */
function blankState() {
  return { passengers: {}, ledger: [], currentHostId: null };
}
function getState() {
  return foundry.utils.deepClone(game.settings.get(MODULE_ID, "state"));
}
async function setState(state) {
  await game.settings.set(MODULE_ID, "state", state);
  for (const app of Object.values(ui.windows)) {
    if (app instanceof SoulTrackerApp) app.render(false);
  }
}
function stamp() {
  const d = new Date();
  return { iso: d.toISOString(), display: d.toLocaleString() };
}
function ensurePassenger(state, actor) {
  if (!state.passengers[actor.id]) {
    state.passengers[actor.id] = {
      actorId: actor.id,
      name: actor.name,
      infestedNow: false,
      everInfested: false,
      hostedAlive: false,
      dead: false,
      killedBy: null
    };
  } else {
    state.passengers[actor.id].name = actor.name; // keep name synced
  }
  return state.passengers[actor.id];
}

/* ---------- Core actions ---------- */
async function infest(actorId, { mode, message }) {
  const state = getState();
  const actor = game.actors.get(actorId);
  if (!actor) return ui.notifications.error("Actor not found.");
  const p = ensurePassenger(state, actor);

  const prevId = state.currentHostId;
  if (prevId && state.passengers[prevId]) state.passengers[prevId].infestedNow = false;

  p.infestedNow = true;
  p.everInfested = true;
  if (!p.dead) p.hostedAlive = true;
  state.currentHostId = actorId;

  const intoCorpse = p.dead;
  const firstHost = !prevId;
  state.ledger.push({
    type: "jump",
    time: stamp(),
    victimId: actorId,
    victimName: p.name,
    sourceId: prevId,
    sourceName: prevId ? state.passengers[prevId]?.name : null,
    intoCorpse,
    firstHost,
    mode,
    message: message ?? null
  });

  await setState(state);

  // Player alert
  if (mode === "immediate" && message) {
    const users = game.users.filter(u => u.active && !u.isGM && u.character?.id === actorId);
    for (const u of users) {
      socket.executeAsUser("showAlert", u.id, { actorName: p.name, message });
    }
    if (!users.length) {
      ui.notifications.warn(`No active player owns ${p.name}; alert not delivered.`);
    }
  }
  // silent = nothing sent
}

async function toggleDeath(actorId) {
  const state = getState();
  const p = state.passengers[actorId];
  if (!p) return;
  p.dead = !p.dead;
  if (p.dead) {
    let status = "clean";
    if (p.infestedNow) status = "host";
    else if (p.hostedAlive) status = "scarred";
    else if (p.everInfested) status = "tainted";
    state.ledger.push({ type: "death", time: stamp(), victimId: actorId, victimName: p.name, status, pending: true });
  } else {
    p.killedBy = null;
    // remove trailing pending death + finalized death for this victim's last kill
    for (let i = state.ledger.length - 1; i >= 0; i--) {
      if (state.ledger[i].type === "death" && state.ledger[i].victimId === actorId) {
        state.ledger.push({ type: "revival", time: stamp(), victimId: actorId, victimName: p.name });
        break;
      }
    }
  }
  await setState(state);
}

async function attributeKiller(victimId, killerId) {
  const state = getState();
  const victim = state.passengers[victimId];
  const killer = state.passengers[killerId];
  if (!victim || !killer) return;
  victim.killedBy = killerId;
  const pending = [...state.ledger].reverse().find(e => e.type === "death" && e.victimId === victimId && e.pending);
  if (pending) {
    pending.pending = false;
    pending.killerId = killerId;
    pending.killerName = killer.name;
    pending.killerHost = killer.infestedNow;
    pending.suicide = victimId === killerId;
  }
  await setState(state);
}

/* ---------- Alert shown on player client ---------- */
function showAlert({ actorName, message }) {
  new foundry.applications.api.DialogV2({
    window: { title: `⚠ ${actorName} — Control Lost`, modal: true },
    content: `<div class="soul-alert"><p>${foundry.utils.escapeHTML(message)}</p></div>`,
    buttons: [{ action: "ok", label: "I understand", default: true }]
  }).render(true);
}

/* ---------- Export matching the standalone HTML schema ---------- */
function exportJSON() {
  const state = getState();
  const passengers = Object.values(state.passengers).map(p => ({
    name: p.name,
    infestedNow: p.infestedNow,
    everInfested: p.everInfested,
    hostedAlive: p.hostedAlive,
    dead: p.dead,
    killedBy: p.killedBy ? state.passengers[p.killedBy]?.name : null
  }));
  const ledger = state.ledger.map(e => ({ ...e, time: e.time?.display ?? e.time }));
  const data = { passengers, ledger, currentHost: state.currentHostId ? state.passengers[state.currentHostId]?.name : null };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `soul-tracker-${Date.now()}.json`;
  a.click();
}

/* ---------- The GM panel (ApplicationV2) ---------- */
const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class SoulTrackerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "soul-tracker-app",
    tag: "div",
    window: { title: "Soul Tracker", icon: "fas fa-ghost", resizable: true },
    position: { width: 820, height: 640 },
    actions: {
      infestSelected: SoulTrackerApp._onInfestSelected,
      killToggle: SoulTrackerApp._onKillToggle,
      pickKiller: SoulTrackerApp._onPickKiller,
      addNote: SoulTrackerApp._onAddNote,
      exportJson: () => exportJSON(),
      clearLog: SoulTrackerApp._onClearLog,
      resetAll: SoulTrackerApp._onResetAll
    }
  };
  static PARTS = { body: { template: `modules/${MODULE_ID}/templates/tracker.hbs` } };

  async _prepareContext() {
    const state = getState();
    const passengers = Object.values(state.passengers);
    const pendingDeath = [...state.ledger].reverse().find(e => e.type === "death" && e.pending);
    return {
      passengers,
      ledger: [...state.ledger].reverse(),
      pendingVictimId: pendingDeath?.victimId ?? null,
      souls: passengers.filter(p => !p.dead).length,
      touched: passengers.filter(p => p.everInfested).length,
      dead: passengers.filter(p => p.dead).length,
      commands: DEFAULT_COMMANDS
    };
  }

  static async _onInfestSelected(event, target) {
    const actor = _selectedActor();
    if (!actor) return ui.notifications.warn("Select a token or open an actor sheet first.");
    const mode = target.dataset.mode; // "silent" | "immediate"
    let message = null;
    if (mode === "immediate") {
      message = await _promptMessage("immediate");
      if (message === null) return;
    } else {
      message = await _promptMessage("silent", true); // optional log note
    }
    await infest(actor.id, { mode, message });
  }
  static async _onKillToggle(event, target) { await toggleDeath(target.dataset.actorId); }
  static async _onPickKiller(event, target) { await attributeKiller(target.dataset.victimId, target.dataset.killerId); }
  static async _onAddNote(event, target) {
    const input = target.closest(".ledger-controls").querySelector("input");
    if (!input?.value.trim()) return;
    const state = getState();
    state.ledger.push({ type: "note", time: stamp(), text: input.value.trim() });
    await setState(state);
  }
  static async _onClearLog() {
    const state = getState(); state.ledger = []; await setState(state);
  }
  static async _onResetAll() {
    const ok = await foundry.applications.api.DialogV2.confirm({ content: "Reset all infestation/death data? Names (actor links) are kept." });
    if (!ok) return;
    const state = getState();
    for (const p of Object.values(state.passengers)) {
      Object.assign(p, { infestedNow:false, everInfested:false, hostedAlive:false, dead:false, killedBy:null });
    }
    state.ledger = []; state.currentHostId = null;
    await setState(state);
  }
}

/* ---------- Small utilities ---------- */
function _selectedActor() {
  if (canvas.tokens?.controlled?.length) return canvas.tokens.controlled[0].actor;
  const sheet = Object.values(ui.windows).find(w => w.actor && w.rendered && w.constructor.name.includes("ActorSheet"));
  return sheet?.actor ?? null;
}

async function _promptMessage(mode, optional = false) {
  const presets = DEFAULT_COMMANDS[mode] ?? [];
  const opts = presets.map((c, i) => `<option value="${i}">${foundry.utils.escapeHTML(c.slice(0, 60))}…</option>`).join("");
  const content = `
    <div class="soul-prompt">
      <label>Preset:</label>
      <select name="preset"><option value="">— custom —</option>${opts}</select>
      <label>Message ${optional ? "(optional log note)" : "to player"}:</label>
      <textarea name="msg" rows="4"></textarea>
    </div>`;
  return foundry.applications.api.DialogV2.prompt({
    window: { title: mode === "immediate" ? "Immediate Control Alert" : "Silent Infestation" },
    content,
    ok: {
      label: "Confirm",
      callback: (event, button) => {
        const form = button.form;
        const preset = form.preset.value;
        const typed = form.msg.value.trim();
        if (typed) return typed;
        if (preset !== "") return presets[Number(preset)];
        return optional ? "" : null;
      }
    },
    rejectClose: false
  });
}

/* ---------- Hooks ---------- */
Hooks.once("socketlib.ready", () => {
  socket = socketlib.registerModule(MODULE_ID);
  socket.register("showAlert", showAlert);
});

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "state", {
    scope: "world", config: false, type: Object, default: blankState()
  });
});

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user.isGM) return;
  const tokenControl = controls.tokens ?? controls.find?.(c => c.name === "token");
  const tool = {
    name: "soul-tracker", title: "Soul Tracker", icon: "fas fa-ghost", button: true,
    onClick: () => new SoulTrackerApp().render(true), onChange: () => new SoulTrackerApp().render(true)
  };
  if (tokenControl?.tools) {
    Array.isArray(tokenControl.tools) ? tokenControl.tools.push(tool) : (tokenControl.tools[tool.name] = tool);
  }
});
