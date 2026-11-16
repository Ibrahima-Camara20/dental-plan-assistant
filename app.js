/* UI controller: dictation, questions, PDF, approval. Depends on engine.js and jsPDF. */
(function () {
  const $ = (id) => document.getElementById(id);

  const SAMPLES = {
    patient3: { text: null, file: "data/samples/patient3.txt", extraction: "data/extractions/patient3.json" },
  };

  const S = { prices: null, rules: null, extraction: null, answers: {}, plan: null, version: 0,
              history: [], approved: false, pdfBlob: null, pdfUrl: null, recognizer: null, recording: false };

  const money = (x) => x == null ? "" : x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " EUR";

  async function init() {
    const [p, r] = await Promise.all([
      fetch("data/prices.json").then((x) => x.json()),
      fetch("data/rules.json").then((x) => x.json()),
    ]);
    S.prices = p; S.rules = r;
    $("sample").addEventListener("change", loadSample);
    $("build").addEventListener("click", buildPlan);
    $("applyAnswers").addEventListener("click", applyAnswers);
    $("new").addEventListener("click", resetAll);
    $("record").addEventListener("click", () => toggleRecord($("record"), $("transcript"), $("recordHint")));
    $("speakCorr").addEventListener("click", () => toggleRecord($("speakCorr"), $("correction"), null));
    $("correction").addEventListener("input", () => { $("applyCorr").disabled = !$("correction").value.trim(); });
    $("applyCorr").addEventListener("click", () => {
      $("corrNote").textContent = "Free-text corrections need the AI step. For now, answer the questions above.";
      $("corrNote").className = "warn";
    });
    $("approve").addEventListener("click", approve);
    $("download").addEventListener("click", download);
  }

  async function loadSample() {
    const key = $("sample").value;
    if (!key) return;
    const s = SAMPLES[key];
    $("transcript").value = await fetch(s.file).then((x) => x.text());
    S.extraction = await fetch(s.extraction).then((x) => x.json());
    S.sampleKey = key;
  }

  function buildPlan() {
    if (!S.extraction) {
      alert("Load a sample dictation first. Free-text dictation needs the AI extraction step, which is not included in this demo.");
      return;
    }
    S.answers = {};
    S.version = 0;
    S.history = [];
    S.approved = false;
    generate();
  }

  function applyAnswers() {
    const q = S.plan.questions;
    const answers = { ...S.answers };
    for (const question of q) {
      const chosen = document.querySelector(`input[name="${CSS.escape(question.id)}"]:checked`);
      if (!chosen) return;
      answers[question.id] = Number(chosen.value);
    }
    S.answers = answers;
    generate();
  }

  // Build the plan from the current answers, render it, and produce the PDF.
  function generate() {
    S.version += 1;
    const plan = DentalEngine.build(S.extraction, S.prices, S.rules, S.answers);
    if (S.extraction.patient_ref && $("patient").value.trim()) plan.patient_ref = $("patient").value.trim();
    S.plan = plan;
    S.approved = false;
    renderSummary(plan);
    renderQuestions(plan);
    renderPDF(plan);
    renderHistory(plan);
    setButtons(plan);
  }

  function renderSummary(plan) {
    const rows = plan.stages.map((st) => {
      const body = st.lines.map((l) => `
        <tr class="${l.status === "pending" ? "pend" : ""}">
          <td>${escapeHtml(l.description)}${l.status === "pending" ? " <i>(pending)</i>" : ""}</td>
          <td class="num">${l.quantity ?? ""}</td>
          <td class="num">${money(l.unit_price_eur)}</td>
          <td class="num">${money(l.subtotal_eur)}</td></tr>`).join("");
      return `<h4 class="sub" style="margin:12px 0 6px">Stage ${st.number}</h4>
        <table class="tbl"><tr><th>Procedure</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Subtotal</th></tr>${body}</table>
        <p class="muted">Stage total ${money(st.total_eur)} (after ${plan.discount ? plan.discount.percent + "%" : "no"} discount)</p>`;
    }).join("");
    $("planSummary").innerHTML = rows + `<p><b>Total ${money(plan.totals.total_eur)}</b>${plan.questions.length ? " <span class=\"warn\">(pending lines excluded)</span>" : ""}</p>`;
  }

  function renderQuestions(plan) {
    const box = $("questions");
    if (!plan.questions.length) {
      box.innerHTML = `<p class="muted">No open questions. The plan is complete.</p>`;
      $("applyAnswers").disabled = true;
      return;
    }
    box.innerHTML = `<h3 class="sub">Questions for the dentist</h3>` + plan.questions.map((q) => `
      <div class="q"><p><b>${escapeHtml(q.text)}</b></p>
        ${q.options.map((o, i) => `
          <label class="opt"><input type="radio" name="${escapeHtml(q.id)}" value="${o.value}" ${i === 0 ? "" : ""}>
            <span>${escapeHtml(o.label)}${o.price_eur != null ? ` <span class="price">&middot; ${money(o.price_eur)}</span>` : ""}${o.note ? ` <span class="price">&middot; ${escapeHtml(o.note)}</span>` : ""}</span>
          </label>`).join("")}
      </div>`).join("");
    box.querySelectorAll("input[type=radio]").forEach((r) => r.addEventListener("change", () => {
      const allChosen = S.plan.questions.every((q) => document.querySelector(`input[name="${CSS.escape(q.id)}"]:checked`));
      $("applyAnswers").disabled = !allChosen;
    }));
    $("applyAnswers").disabled = true;
  }

  function renderPDF(plan) {
    const doc = makePDF(plan, S.version);
    S.pdfBlob = doc.output("blob");
    if (S.pdfUrl) URL.revokeObjectURL(S.pdfUrl);
    S.pdfUrl = URL.createObjectURL(S.pdfBlob);
    $("pdfBox").innerHTML = `<iframe id="pdfFrame" src="${S.pdfUrl}" title="Treatment plan PDF"></iframe>`;
  }

  function makePDF(plan, version) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const L = 18, R = 192;
    let y = 18;
    const need = (h) => { if (y + h > 280) { doc.addPage(); y = 18; } };

    doc.setFont("helvetica", "bold"); doc.setFontSize(15);
    doc.text(`Treatment plan – ${plan.patient_ref} – version ${version}`, L, y); y += 7;
    doc.setFont("helvetica", "normal"); doc.setFontSize(10);
    doc.text(`Status: ${plan.status}`, L, y); y += 8;

    for (const st of plan.stages) {
      need(16);
      doc.setFont("helvetica", "bold"); doc.setFontSize(11);
      doc.text(`Stage ${st.number}`, L, y); y += 6;
      doc.setFont("helvetica", "normal"); doc.setFontSize(9.5);
      for (const l of st.lines) {
        const desc = doc.splitTextToSize(l.description + (l.status === "pending" ? " (pending)" : ""), 110);
        need(desc.length * 4.5 + 1);
        doc.text(desc, L, y);
        if (l.quantity != null) doc.text(String(l.quantity), 139, y, { align: "right" });
        if (l.unit_price_eur != null) doc.text(money(l.unit_price_eur), 167, y, { align: "right" });
        if (l.subtotal_eur != null) doc.text(money(l.subtotal_eur), R, y, { align: "right" });
        y += desc.length * 4.5;
      }
      need(12);
      y += 2; doc.setFont("helvetica", "italic");
      doc.text(`Stage subtotal ${money(st.subtotal_eur)}; discount ${money(st.discount_eur)}; stage total ${money(st.total_eur)}`, L, y);
      doc.setFont("helvetica", "normal"); y += 9;
    }

    need(30);
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.text("Total", L, y); y += 6;
    doc.setFont("helvetica", "normal"); doc.setFontSize(10);
    doc.text(`Subtotal ${money(plan.totals.subtotal_eur)}`, L, y); y += 5;
    if (plan.discount) { doc.text(`${plan.discount.label}: -${plan.discount.percent}% (-${money(plan.totals.discount_eur)})`, L, y); y += 5; }
    doc.setFont("helvetica", "bold");
    doc.text(`Total ${money(plan.totals.total_eur)}${plan.questions.length ? " (pending lines excluded)" : ""}`, L, y); y += 8;

    if (plan.pending_confirmation.length) {
      need(20);
      doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.text("To be confirmed", L, y); y += 6;
      doc.setFont("helvetica", "normal"); doc.setFontSize(10);
      for (const p of plan.pending_confirmation) { doc.text("• " + p, L, y); y += 5; }
    }
    return doc;
  }

  function renderHistory(plan) {
    S.history.push({ v: S.version, status: plan.status, total: plan.totals.total_eur, approved: false });
    $("history").innerHTML = S.history.map((h) =>
      `<li>v${h.v} &middot; ${escapeHtml(h.status)} &middot; ${money(h.total)}${h.approved ? " &middot; <b>approved</b>" : ""}</li>`).reverse().join("");
  }

  function setButtons(plan) {
    const complete = plan.questions.length === 0;
    $("approve").disabled = !complete;
    $("download").disabled = true;
    $("send").disabled = true;
    $("badge").textContent = complete ? "Ready for review" : "Draft";
  }

  function approve() {
    S.approved = true;
    S.history[S.history.length - 1].approved = true;
    $("history").innerHTML = S.history.map((h) =>
      `<li>v${h.v} &middot; ${escapeHtml(h.status)} &middot; ${money(h.total)}${h.approved ? " &middot; <b>approved</b>" : ""}</li>`).reverse().join("");
    $("download").disabled = false;
    $("badge").textContent = "Approved";
  }

  function download() {
    const a = document.createElement("a");
    a.href = S.pdfUrl;
    a.download = `treatment-plan-${S.plan.patient_ref}-v${S.version}.pdf`;
    a.click();
  }

  function toggleRecord(btn, target, hint) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      alert("Speech recognition is not available in this browser. Use Chrome or Edge, or type the text.");
      return;
    }
    if (S.recording) {
      S.recognizer && S.recognizer.stop();
      S.recording = false;
      btn.classList.remove("on");
      btn.innerHTML = btn.id === "record" ? "&#9679; Record" : "&#9679; Speak";
      return;
    }
    const rec = new SR();
    rec.lang = $("lang").value;
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) target.value += (target.value ? " " : "") + e.results[i][0].transcript.trim();
      }
      target.dispatchEvent(new Event("input"));
    };
    rec.onend = () => { if (S.recording) rec.start(); };
    rec.start();
    S.recognizer = rec; S.recording = true;
    btn.classList.add("on");
    btn.innerHTML = "&#9632; Stop";
    if (hint) hint.textContent = "Listening… click Stop when you are done.";
  }

  function resetAll() {
    S.extraction = null; S.plan = null; S.version = 0; S.history = []; S.answers = {}; S.approved = false;
    $("transcript").value = ""; $("sample").value = ""; $("patient").value = "";
    $("planSummary").innerHTML = `<p class="muted">No plan yet. Dictate or load a sample, then build.</p>`;
    $("questions").innerHTML = ""; $("applyAnswers").disabled = true;
    $("pdfBox").innerHTML = `<div class="pdfEmpty">The PDF preview appears here.</div>`;
    $("history").innerHTML = `<li class="muted">No versions yet.</li>`;
    $("approve").disabled = true; $("download").disabled = true; $("send").disabled = true;
    $("badge").textContent = "Draft";
  }

  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  init();
})();
