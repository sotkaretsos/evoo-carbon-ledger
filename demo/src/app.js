// User interface of the live demo (docs/index.html).
import { CaseStudyDemo, ACTOR_LABELS } from "./scenario.js";
import reference from "../../reports/case-study-replay.json";

const $ = (sel) => document.querySelector(sel);
const fmt = (n) => Number(n).toLocaleString("en-US");
const chainDate = (t) => new Date(Number(t) * 1000).toISOString().slice(0, 16).replace("T", " ");
const el = (tag, attrs = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c !== undefined && c !== null) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
};

const STEPS = [
  {
    key: "setup",
    title: "Consortium set-up",
    period: "January 2024",
    lede: "Deploy five contracts and the validation library; register 11 actors, 16 governed variables, two functional units and four calibrated devices.",
    run: (d) => d.setup(),
  },
  {
    key: "act1",
    title: "Act 1 · The 2024 season",
    period: "Jan 2024 – Feb 2025",
    lede: "25 farm events, ten harvest lots with dual-signature custody and transport fuel, one mill batch with signed meter readings; the farm records are closed and verified.",
    run: (d) => d.act1(),
  },
  {
    key: "act2",
    title: "Act 2 · Conference-version result",
    period: "March 2025",
    lede: "Factor set FS-2025-CONF is approved. A result package per liter of oil is rejected; the package per kilogram is certified.",
    run: (d) => d.act2(),
  },
  {
    key: "act3",
    title: "Act 3 · Journal-version corrections",
    period: "June – July 2026",
    lede: "Two audited corrections reclassify the chainsaw and olive-beater fuel as petrol, FS-2026-01 replaces FS-2025-CONF, and the recalculated result is certified.",
    run: (d) => d.act3(),
  },
];

const RULES = {
  outsider: "Every write is checked against the consortium registry: the sender must be an active member with the grower role and belong to the orchard's organization.",
  forged: "Sensor and meter readings must carry an EIP-191 signature of the registered device, valid at the observation time and bound to this chain, contract and record.",
  duplicate: "The contract keeps the hash of every recorded envelope, so a re-sent copy is rejected and buffered resubmissions cannot double-count.",
  range: "Each governed variable has a fixed unit, life-cycle phase and admissible range.",
  mass: "Custody changes only when the sender's declaration and the mill's signed weighbridge reading agree within 1%.",
  selfApproval: "An emission-factor set becomes usable only after approval by a second methodological authority.",
  retired: "Only approved factor sets within their validity window are usable; FS-2025-CONF was retired in Act 3.",
  perLiter: "The functional unit must be expressed in the unit in which the batch output was measured.",
  closed: "Closed and verified records change only through an audited correction that keeps the original visible.",
  tampered: "The ledger keeps the document hash; any edit to the archived document changes the hash.",
  evidence: "The evidence manifest must be registered for at least five years in at least two replicas, with no failed retrieval check.",
};

const STATUS_TEXT = {
  None: ["none", "No certificate yet"],
  Valid: ["valid", "Valid"],
  Outdated: ["warn", "Outdated"],
  FactorSetRetired: ["warn", "Factor set retired"],
};
const STATUS_NOTE = {
  None: "A certificate appears once a result package is approved.",
  Valid: "The approved result matches the current event chain and factor set.",
  Outdated: "An audited correction changed the event chain after approval; a recalculated result is needed.",
  FactorSetRetired: "The factor set behind the approved result has been retired.",
};

let demo;
let next = 0;
let running = false;
let feedCount = 0;
const stepTotals = {};

function setStatus(text, kind = "") {
  const s = $("#status");
  s.textContent = text;
  s.className = "status " + kind;
}

function updateButtons() {
  const done = next >= STEPS.length;
  $("#run-next").disabled = running || done || !demo;
  $("#run-all").disabled = running || done || !demo;
  $("#restart").disabled = running || !demo || next === 0;
  $("#run-next").textContent = done ? "Replay complete" : `Run: ${STEPS[next].title}`;
  for (const btn of document.querySelectorAll(".attack button")) {
    const needs = Number(btn.dataset.needs);
    const ready = demo && demo.state.act >= needs && next >= Math.min(needs + 1, STEPS.length);
    btn.disabled = running || !ready;
    btn.title = ready ? "" : `Available after ${needs === 0 ? "the set-up" : STEPS[needs].title.split(" · ")[0]}`;
    btn.closest(".attack").classList.toggle("locked", !ready);
  }
}

function renderSteps() {
  const list = $("#steps");
  list.replaceChildren(
    ...STEPS.map((s, i) =>
      el(
        "li",
        { class: "step", id: `step-${s.key}`, "data-state": i < next ? "done" : "pending" },
        el("div", { class: "step-head" }, el("span", { class: "step-dot", "aria-hidden": "true" }), el("h3", { text: s.title }), el("span", { class: "step-period", text: s.period })),
        el("p", { class: "step-lede", text: s.lede }),
        el("p", { class: "step-meta", id: `meta-${s.key}` })
      )
    )
  );
}

function addFeedRow(entry) {
  feedCount += 1;
  const [contract, fn] = entry.label.includes(".") ? entry.label.split(".") : ["", entry.label];
  const rejected = entry.accepted === false;
  const note = entry.kind === "note";
  const tr = el(
    "tr",
    { class: rejected ? "rejected" : note ? "note" : "" },
    el("td", { class: "num", text: String(feedCount) }),
    el("td", { class: "mono date", text: chainDate(entry.timestamp) }),
    el("td", {}, el("span", { class: `tag ${entry.act}`, text: entry.act === "deploy" ? "deploy" : entry.act === "setup" ? "set-up" : entry.act.replace("act", "Act ") })),
    el("td", { text: ACTOR_LABELS[entry.actor] ?? entry.actor ?? "" }),
    el("td", {}, el("span", { class: note || entry.act === "try" ? "fn plain" : "fn", text: note ? "Off-chain LCA service" : fn }), contract ? el("span", { class: "contract", text: contract }) : null),
    el("td", { class: "detail", text: note ? entry.text : entry.detail ?? "" }),
    el("td", { class: "num mono" }, rejected ? el("span", { class: "err", text: `✗ ${entry.name}` }) : note ? "–" : fmt(entry.gasUsed))
  );
  $("#feed tbody").prepend(tr);
  $("#feed-count").textContent = `${feedCount} entries`;
}

function renderCertificate(c) {
  const [cls, label] = STATUS_TEXT[c.status] ?? ["none", c.status];
  $("#cert-status").className = `pill ${cls}`;
  $("#cert-status").textContent = label;
  $("#cert-note").textContent = STATUS_NOTE[c.status] ?? "";
  $("#cert-version").textContent = c.version ? `v${c.version}` : "–";
  $("#cert-value").textContent = c.version ? c.kgCO2eqPerFU.toFixed(3) : "–";
  $("#cert-fs").textContent = c.factorSet ?? "–";
  $("#cert-fu").textContent = c.functionalUnit ?? "–";
  $("#cert-approved").textContent = c.approvedAt ? chainDate(c.approvedAt).slice(0, 10) : "–";
  $("#cert-evidence").textContent = c.version ? (c.evidenceCheckFailed ? "failed retrieval check" : "retained, no failed check") : "–";
  const bars = $("#cert-bars");
  if (c.version) {
    const names = ["Cultivation and harvesting", "Transport", "Mill processing"];
    bars.replaceChildren(
      ...c.phaseSharePermille.map((p, i) =>
        el("div", { class: `bar b${i}`, style: `--w:${p / 10}%`, title: `${names[i]}: ${(p / 10).toFixed(1)}%` }, el("span", { class: "bar-label", text: `${names[i]} ${(p / 10).toFixed(1)}%` }))
      )
    );
  }
  const li = el("li", {}, el("span", { class: `pill small ${cls}`, text: label }), el("span", { class: "tl-text", text: `${chainDate(c.timestamp).slice(0, 10)} · ${c.label}` }));
  $("#cert-timeline").append(li);
}

function renderResults() {
  const r = demo.results;
  const rows = [];
  const phases = (x) => ["cultivation", "transport", "mill"].map((p) => x.report.phases[p].perKgOil.toFixed(4));
  if (r.v1) {
    rows.push(["v1 (per liter)", "FS-2025-CONF", "1 L EVOO", r.v1Litre.report.total.perKgOil.toFixed(3), "–", "–", "–", "Rejected", "bad", r.literRejection.name]);
    rows.push(["v1", "FS-2025-CONF", "1 kg EVOO", r.v1.report.total.perKgOil.toFixed(3), ...phases(r.v1), "Certified (Act 2)", "ok"]);
  }
  if (r.v2) {
    rows.push(["v2", "FS-2026-01", "1 kg EVOO", r.v2.report.total.perKgOil.toFixed(3), ...phases(r.v2), "Certified (Act 3)", "ok"]);
    rows.push(["Economic allocation", "FS-2026-01", "1 kg EVOO", r.economic.report.total.perKgOil.toFixed(2), "", "", "", "Off-chain variant", "muted"]);
    rows.push(["Wet-mass allocation", "FS-2026-01", "1 kg EVOO", r.wetMass.report.total.perKgOil.toFixed(2), "", "", "", "Off-chain variant", "muted"]);
  }
  $("#results tbody").replaceChildren(
    ...rows.map((row) =>
      el(
        "tr",
        {},
        ...row.slice(0, 7).map((v, i) => el("td", { class: i >= 3 ? "num mono" : "", text: v })),
        el(
          "td",
          {},
          el("span", { class: `pill small ${row[8] === "ok" ? "valid" : row[8] === "bad" ? "bad" : "none"}`, text: row[7] }),
          row[9] ? el("span", { class: "err-name", text: row[9] }) : null
        )
      )
    )
  );
  $("#results-wrap").hidden = rows.length === 0;
  if (r.v2) {
    $("#results-note").textContent = `Result v2 corresponds to ${r.v2.report.total.perHa.toFixed(1)} kg CO2eq per hectare, the baseline of the article. ${r.eventCount} events are on the ledger, two of them superseded by audited corrections.`;
  }
}

function renderTotals() {
  const t = demo.totals();
  const ref = reference.operationalTotals;
  const parts = [];
  if (t.operational.transactions) parts.push(`${fmt(t.operational.transactions)} transactions in Acts 1–3, ${fmt(t.operational.gasUsed)} gas`);
  if (t.setup.transactions) parts.push(`set-up ${fmt(t.setup.transactions + demo.rec.deployments.length)} transactions including deployment`);
  $("#totals").textContent = parts.join(" · ");
  if (next >= STEPS.length) {
    const same = t.operational.transactions === ref.transactions && t.operational.gasUsed === ref.gasUsed && t.deploymentGas === reference.deploymentTotalGas;
    const box = $("#check");
    box.hidden = false;
    box.className = `check ${same ? "ok" : "warn"}`;
    box.replaceChildren(
      el("strong", { text: same ? "Same numbers as the article. " : "Different from the article. " }),
      `Your browser executed ${fmt(t.operational.transactions)} transactions with ${fmt(t.operational.gasUsed)} gas and deployed the contracts with ${fmt(t.deploymentGas)} gas; the Hardhat replay reported in the article used ${fmt(ref.transactions)} transactions, ${fmt(ref.gasUsed)} gas and ${fmt(reference.deploymentTotalGas)} gas, respectively.`
    );
  }
}

async function runStep() {
  const step = STEPS[next];
  running = true;
  updateButtons();
  const li = $(`#step-${step.key}`);
  li.dataset.state = "running";
  setStatus(`Running ${step.title}…`, "busy");
  const before = demo.rec.entries.length;
  const t0 = performance.now();
  try {
    await step.run(demo);
    const entries = demo.rec.entries.slice(before);
    const gas = entries.reduce((s, e) => s + e.gasUsed, 0) + (step.key === "setup" ? demo.totals().deploymentGas : 0);
    const n = entries.length + (step.key === "setup" ? demo.rec.deployments.length : 0);
    stepTotals[step.key] = { n, gas };
    $(`#meta-${step.key}`).textContent = `${n} transactions · ${fmt(gas)} gas · ${((performance.now() - t0) / 1000).toFixed(1)} s in your browser`;
    li.dataset.state = "done";
    next += 1;
    renderResults();
    renderTotals();
    setStatus(next >= STEPS.length ? "Replay complete. Try to break the rules below." : `Done. Next: ${STEPS[next].title}.`, "ok");
  } catch (err) {
    li.dataset.state = "error";
    setStatus(`Error: ${err.shortMessage ?? err.message}`, "bad");
    console.error(err);
  } finally {
    running = false;
    updateButtons();
  }
}

async function runAll() {
  while (next < STEPS.length && !running) {
    await runStep();
    if ($(`#step-${STEPS[next - 1].key}`).dataset.state === "error") break;
  }
}

function renderAttacks() {
  const grid = $("#attacks");
  grid.replaceChildren(
    ...demo.attacks().map((a) =>
      el(
        "article",
        { class: "attack locked", id: `attack-${a.key}` },
        el("div", { class: "attack-head" }, el("span", { class: "req", text: a.requirement }), el("h3", { text: a.title })),
        el("p", { class: "story", text: a.story }),
        el("button", { type: "button", class: "btn small", "data-key": a.key, "data-needs": String(a.needs), text: "Try it" }),
        el("div", { class: "outcome", "aria-live": "polite" })
      )
    )
  );
}

function onAttackClick() {
  $("#attacks").addEventListener("click", async (ev) => {
    const btn = ev.target.closest("button[data-key]");
    if (!btn || btn.disabled) return;
    const attack = demo.attacks().find((a) => a.key === btn.dataset.key);
    const out = btn.parentElement.querySelector(".outcome");
    running = true;
    updateButtons();
    out.replaceChildren(el("p", { class: "muted", text: "Sending to the contracts…" }));
    try {
      const res = await attack.run();
      const details = demo.describeArgs(res.name, res.args ?? []);
      if (res.accepted) {
        out.replaceChildren(el("p", { class: "verdict warn", text: "Accepted (unexpected)" }));
      } else if (res.view) {
        out.replaceChildren(
          el("p", { class: "verdict ok", text: "Detected: hash mismatch" }),
          el("ul", { class: "args" }, ...details.map((d) => el("li", { text: d }))),
          el("p", { class: "rule", text: RULES[attack.key] })
        );
      } else {
        out.replaceChildren(
          ...[
            el("p", { class: "verdict ok" }, "Rejected: ", el("code", { text: res.name })),
            details.length ? el("ul", { class: "args" }, ...details.map((d) => el("li", { text: d }))) : null,
            el("p", { class: "rule", text: RULES[attack.key] }),
          ].filter(Boolean)
        );
      }
      addFeedRow({ label: attack.title, act: "try", actor: "", timestamp: demo.latest(), kind: "", accepted: false, name: res.name, detail: "tried on a snapshot and rolled back" });
    } catch (err) {
      out.replaceChildren(el("p", { class: "verdict bad", text: `Error: ${err.shortMessage ?? err.message}` }));
      console.error(err);
    } finally {
      running = false;
      updateButtons();
    }
  });
}

async function start() {
  demo = null;
  updateButtons();
  feedCount = 0;
  $("#feed tbody").replaceChildren();
  $("#feed-count").textContent = "0 entries";
  $("#cert-timeline").replaceChildren();
  $("#cert-bars").replaceChildren();
  $("#results-wrap").hidden = true;
  $("#check").hidden = true;
  $("#totals").textContent = "";
  next = 0;
  renderSteps();
  renderCertificate({ status: "None", version: 0, timestamp: Date.parse("2024-01-01T00:00:00Z") / 1000, label: "start" });
  $("#cert-timeline").replaceChildren();
  setStatus("Preparing the in-browser chain…", "busy");
  demo = await new CaseStudyDemo({
    onTx: (e) => {
      addFeedRow(e);
      if (window.__pace) return new Promise((r) => setTimeout(r, window.__pace));
    },
    onReject: (e) => addFeedRow(e),
    onNote: (e) => addFeedRow({ ...e, kind: "note", label: "", actor: "lcaService" }),
    onCertificate: (c) => renderCertificate(c),
  }).init();
  renderAttacks();
  setStatus("Ready. Run the set-up and the three acts one by one, or all at once.", "ok");
  updateButtons();
}

window.addEventListener("DOMContentLoaded", () => {
  $("#run-next").addEventListener("click", () => runStep());
  $("#run-all").addEventListener("click", () => runAll());
  $("#restart").addEventListener("click", () => start().catch((e) => setStatus(`Error: ${e.message}`, "bad")));
  onAttackClick();
  const pace = $("#pace");
  const applyPace = () => (window.__pace = pace.checked ? 140 : 0);
  pace.addEventListener("change", applyPace);
  applyPace();
  start().catch((e) => {
    setStatus(`This browser could not start the demo: ${e.message}`, "bad");
    console.error(e);
  });
});
