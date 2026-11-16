/* Conversation UI: samples, chat thread, clarification chips, live totals, PDF, approval. */
(function () {
  const $ = (id) => document.getElementById(id);

  const SAMPLES = {
    patient3: {
      label: "Sample: Patient 3 (military)",
      text: "Calculate a treatment estimate for a military serviceman (-30%).\nStage 1: pre-operative hygiene, use of a sterilisation pack, bone grafting in segment 1 at the price-list price of 630 EUR. Placement of four implants: sites 16, 15, 35 and 36. Sedation.\nStage 2: calculate placement of healing abutments with a 30% discount at sites 16, 15, 35 and 36. After that, also calculate – for the serviceman – gingival grafting around each implant. In stage 2, also add the cost of placing temporary crowns on the implants.",
      extraction: "data/extractions/patient3.json",
    },
  };

  const S = { prices: null, rules: null, extraction: null, answers: {}, plan: null, version: 0,
              versions: [], approved: false, pdfUrl: null, recording: false, recognizer: null, sampleKey: null, aiQuestions: [] };

  const money = (x) => x == null ? "" : x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " EUR";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  async function init() {
    [S.prices, S.rules] = await Promise.all([
      fetch("data/prices.json").then((r) => r.json()),
      fetch("data/rules.json").then((r) => r.json()),
    ]);
    document.querySelectorAll("[data-sample]").forEach((b) => b.addEventListener("click", () => loadSample(b.dataset.sample)));
    $("newPlan").addEventListener("click", reset);
    $("composer").addEventListener("submit", onSend);
    $("mic").addEventListener("click", toggleRecord);
    $("approve").addEventListener("click", approve);
    $("download").addEventListener("click", download);
    $("saveKey").addEventListener("click", saveKey);
    if (localStorage.getItem("dpa_key")) $("keyState").textContent = "Key saved in this browser";
  }

  function saveKey() {
    const key = $("apiKey").value.trim();
    if (!key) { $("keyState").textContent = "Paste a key first"; return; }
    localStorage.setItem("dpa_key", key);
    $("apiKey").value = "";
    $("keyState").textContent = "Key saved in this browser";
  }

  function say(html, cls = "bot") {
    const el = document.createElement("div");
    el.className = `msg ${cls}`;
    el.innerHTML = html;
    $("thread").appendChild(el);
    const t = $("thread"); t.scrollTop = t.scrollHeight;
    return el;
  }

  async function loadSample(key) {
    const s = SAMPLES[key];
    reset(true);
    document.querySelectorAll("[data-sample]").forEach((b) => b.classList.toggle("on", b.dataset.sample === key));
    say(esc(s.text).replace(/\n/g, "<br>"), "me");
    S.extraction = await fetch(s.extraction).then((r) => r.json());
    S.sampleKey = key;
    say("I have read the dictation. Building the plan…");
    generate(true);
  }

  function onSend(e) {
    e.preventDefault();
    const text = $("input").value.trim();
    if (!text) return;
    $("input").value = "";
    say(esc(text).replace(/\n/g, "<br>"), "me");
    if (!S.extraction) {
      if (!localStorage.getItem("dpa_key")) {
        say("To read a free-text dictation, paste your API key in the sidebar and save it. Or load one of the samples on the left.");
        return;
      }
      aiExtract(text);
      return;
    }
    say("Corrections by text need the AI step. For now, answer the questions in the thread.");
  }

  // Build the plan from current answers, update the thread, the totals and the PDF.
  function generate(initial) {
    S.version += 1;
    const plan = DentalEngine.build(S.extraction, S.prices, S.rules, S.answers);
    plan.pending_confirmation = plan.pending_confirmation.concat(S.aiQuestions);
    S.plan = plan;
    S.approved = false;

    const open = plan.questions.length;
    if (open) {
      if (initial) say(`I need <b>${open}</b> answer${open > 1 ? "s" : ""} before the PDF is final.`);
      plan.questions.forEach((q) => renderQuestion(q));
    } else {
      say(`The plan is complete. Total <b>${money(plan.totals.total_eur)}</b>${plan.discount ? ` after the ${plan.discount.percent}% discount` : ""}. The PDF is on the right; approve it when you are happy.`);
      renderSummary(plan);
    }

    renderPanel(plan);
    renderPDF(plan);
    S.versions.push({ v: S.version, status: plan.status, total: plan.totals.total_eur, approved: false });
    renderVersions();
  }

  function renderQuestion(q) {
    const chosen = S.answers[q.id];
    const opts = q.options.map((o) => {
      const sel = chosen === o.value ? " sel" : "";
      const price = o.price_eur != null ? `<span class="p">${money(o.price_eur)}</span>` : "";
      return `<button class="chip${sel}" data-q="${esc(q.id)}" data-v="${o.value}">${esc(o.label)} ${price}</button>`;
    }).join("");
    const el = say(`<div class="qtitle">${esc(q.text)}</div><div class="chips">${opts}</div>`);
    el.querySelectorAll("button.chip").forEach((b) => b.addEventListener("click", () => answer(q.id, Number(b.dataset.v), el)));
  }

  function answer(qid, value, bubble) {
    S.answers[qid] = value;
    bubble.querySelectorAll("button.chip").forEach((b) => {
      b.classList.toggle("sel", Number(b.dataset.v) === value);
      b.disabled = true;
    });
    const open = S.plan.questions.filter((q) => !(q.id in S.answers)).length;
    if (open === 0) {
      say("Thanks. Regenerating the plan…");
      generate(false);
    } else {
      say(`Noted. ${open} question${open > 1 ? "s" : ""} left.`);
    }
  }

  function renderSummary(plan) {
    const rows = plan.stages.map((st) => `
      <tr><th colspan="2">Stage ${st.number}</th></tr>
      ${st.lines.map((l) => `<tr><td>${esc(l.description)} × ${l.quantity}</td><td class="n">${money(l.subtotal_eur)}</td></tr>`).join("")}
      <tr><td><b>Stage ${st.number} total</b></td><td class="n"><b>${money(st.total_eur)}</b></td></tr>`).join("");
    say(`<table class="sum">${rows}</table>`);
  }

  function renderPanel(plan) {
    const open = plan.questions.length;
    $("total").textContent = money(plan.totals.total_eur);
    $("totalSub").textContent = open ? `Pending lines excluded. ${open} question${open > 1 ? "s" : ""} open.` : (plan.discount ? `After ${plan.discount.percent}% ${plan.discount.label.toLowerCase()}.` : "Final.");
    $("pill").textContent = open ? `${open} question${open > 1 ? "s" : ""} open` : "Ready for review";
    $("pill").className = "pill " + (open ? "open" : "ok");
    $("approve").disabled = open > 0;
    $("download").disabled = true;
  }

  function renderPDF(plan) {
    const doc = makePDF(plan, S.version);
    if (S.pdfUrl) URL.revokeObjectURL(S.pdfUrl);
    S.pdfUrl = URL.createObjectURL(doc.output("blob"));
    $("pdfBox").innerHTML = `<iframe src="${S.pdfUrl}" title="Treatment plan PDF"></iframe>`;
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

  function renderVersions() {
    $("versions").innerHTML = S.versions.map((v) =>
      `<li>v${v.v} · ${esc(v.status)} · ${money(v.total)}${v.approved ? " · <b>approved</b>" : ""}</li>`).reverse().join("")
      || `<li class="muted">None yet</li>`;
  }

  function approve() {
    if (!S.plan || S.plan.questions.length) return;
    S.approved = true;
    S.versions[S.versions.length - 1].approved = true;
    renderVersions();
    $("download").disabled = false;
    $("pill").textContent = "Approved";
    say(`Version ${S.version} approved. You can download the PDF.`);
  }

  function download() {
    const a = document.createElement("a");
    a.href = S.pdfUrl;
    a.download = `treatment-plan-${S.plan.patient_ref}-v${S.version}.pdf`;
    a.click();
  }

  function toggleRecord() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { alert("Speech recognition is not available in this browser. Use Chrome or Edge, or type the text."); return; }
    if (S.recording) {
      S.recognizer && S.recognizer.stop();
      S.recording = false;
      $("mic").classList.remove("on");
      $("mic").innerHTML = "&#9679; Record";
      return;
    }
    const rec = new SR();
    rec.lang = "en-US";
    rec.continuous = true;
    rec.interimResults = false;
    rec.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) $("input").value += (($("input").value ? " " : "") + e.results[i][0].transcript.trim());
      }
    };
    rec.onend = () => { if (S.recording) rec.start(); };
    rec.start();
    S.recognizer = rec; S.recording = true;
    $("mic").classList.add("on");
    $("mic").innerHTML = "&#9632; Stop";
  }

  function reset(keepThread) {
    S.extraction = null; S.plan = null; S.version = 0; S.answers = {}; S.versions = []; S.approved = false; S.sampleKey = null; S.aiQuestions = [];
    if (!keepThread) {
      $("thread").innerHTML = "";
      say("Load a sample dictation from the left, or type or dictate one below. I will build the plan and ask you about anything I cannot price with confidence.");
    }
    document.querySelectorAll("[data-sample]").forEach((b) => b.classList.remove("on"));
    $("total").textContent = "–";
    $("totalSub").textContent = "Totals update as you answer.";
    $("pill").textContent = "No plan"; $("pill").className = "pill";
    $("pdfBox").innerHTML = `<div class="pdf-empty">PDF preview appears here.</div>`;
    $("approve").disabled = true; $("download").disabled = true;
    renderVersions();
  }

  function systemPrompt() {
    const names = [...new Set(S.prices.map((r) => r.service))].join("\n");
    return `You turn a dentist's dictation into a dental treatment plan. Reply with JSON only, shaped as:
{"not_dental": false, "patient_ref": null, "rules_applied": [], "stages": [{"number": 1, "interval_after": null, "items": [{"id": "s1-1", "kind": "item", "text": "...", "quantity": 1, "dictated_price": null}, {"id": "s1-2", "kind": "sedation", "duration_h": null}]}], "questions": ["..."]}
Rules:
- kind "item" for a procedure. Use the closest service name from the price list below as text. Never invent prices. Set dictated_price only if the dentist states a price in EUR.
- kind "sedation" for sedation. Set duration_h to a number of hours if stated, otherwise null.
- rules_applied: include "military_30" only if the dentist says the patient is a military serviceman with a 30% discount.
- Put anything missing or ambiguous (patient name, implant brand, sedation duration, unclear procedure) into "questions", as short questions for the dentist.
- Set not_dental to true if the dictation is not about dental treatment.
- Give every item a unique id.

Price list service names:
${names}`;
  }

  async function aiExtract(text) {
    const key = localStorage.getItem("dpa_key");
    const model = $("model").value.trim() || "llama-3.3-70b-versatile";
    const busy = say("Reading the dictation…");
    try {
      const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify({ model, temperature: 0, response_format: { type: "json_object" },
          messages: [{ role: "system", content: systemPrompt() }, { role: "user", content: text }] }),
      });
      if (!res.ok) throw new Error(`API error ${res.status}`);
      const data = await res.json();
      const parsed = JSON.parse(data.choices[0].message.content);
      busy.remove();
      applyAI(parsed);
    } catch (err) {
      busy.innerHTML = `Could not read the dictation (${esc(err.message)}). Check the key and the model name, then try again.`;
    }
  }

  function applyAI(p) {
    if (p.not_dental || !Array.isArray(p.stages) || !p.stages.length) {
      say("This does not look like a dental treatment dictation, so I cannot build a plan from it.");
      return;
    }
    S.extraction = {
      patient_ref: p.patient_ref || "PATIENT",
      rules_applied: (p.rules_applied || []).filter((k) => S.rules.discounts[k]),
      stages: p.stages.map((st) => ({
        number: Number(st.number),
        interval_after: st.interval_after || null,
        items: (st.items || []).map((it, i) => {
          const id = it.id || `s${st.number}-${i + 1}`;
          if (it.kind === "sedation") return { id, kind: "sedation", duration_h: typeof it.duration_h === "number" ? it.duration_h : null };
          return { id, kind: "item", text: String(it.text || ""), quantity: Number(it.quantity) || 1,
                   dictated_price: typeof it.dictated_price === "number" ? it.dictated_price : null };
        }),
      })),
    };
    S.answers = {};
    for (const st of S.extraction.stages) for (const it of st.items) {
      if (it.kind === "sedation" && it.duration_h != null) S.answers[`${it.id}:duration`] = it.duration_h;
    }
    S.aiQuestions = (p.questions || []).map(String);
    if (S.aiQuestions.length) {
      say("<b>To confirm with the dentist:</b><ul>" + S.aiQuestions.map((q) => `<li>${esc(q)}</li>`).join("") + "</ul>");
    }
    say("I have read the dictation. Building the plan…");
    generate(true);
  }

  init();
})();