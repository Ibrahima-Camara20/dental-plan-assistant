/* Conversation UI: samples, chat thread, clarification chips, live totals, PDF, approval. */
(function () {
  const $ = (id) => document.getElementById(id);
  const WORKER_URL = "https://yellow-sky-f2a0.ibrahima-camara.workers.dev";
  const CONFIRM = "confirm"; // same value as DentalEngine.CONFIRM

  const SAMPLES = {
    patient3: {
      label: "Sample: Patient 3 (military)",
      text: "Calculate a treatment estimate for a military serviceman (-30%).\nStage 1: pre-operative hygiene, use of a sterilisation pack, bone grafting in segment 1 at the price-list price of 630 EUR. Placement of four implants: sites 16, 15, 35 and 36. Sedation.\nStage 2: calculate placement of healing abutments with a 30% discount at sites 16, 15, 35 and 36. After that, also calculate – for the serviceman – gingival grafting around each implant. In stage 2, also add the cost of placing temporary crowns on the implants.",
      extraction: "data/extractions/patient3.json",
    },
  };

  const S = { prices: null, rules: null, extraction: null, answers: {}, plan: null, version: 0,
              versions: [], approved: false, pdfUrl: null, recording: false, recognizer: null, sampleKey: null, aiQuestions: [],
              details: { clinic: "", doctor: "", patient: "", lang: "en" } };

  const money = (x) => x == null ? "" : x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " EUR";
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const parseVal = (raw) => (raw === CONFIRM ? raw : Number(raw));

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
    ["clinicName", "doctorName", "patientName", "lang"].forEach((id) => $(id).addEventListener("input", onDetails));
    S.details = currentDetails();
  }

  function currentDetails() {
    return {
      clinic: $("clinicName").value.trim(),
      doctor: $("doctorName").value.trim(),
      patient: $("patientName").value.trim(),
      lang: $("lang").value === "fr" ? "fr" : "en",
    };
  }

  // Changing the header or the language changes the PDF, so it must be approved again.
  function onDetails() {
    S.details = currentDetails();
    if (!S.plan) return;
    S.approved = false;
    if (S.versions.length) S.versions[S.versions.length - 1].approved = false;
    renderVersions();
    renderPanel(S.plan);
    renderPDF(S.plan);
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
    plan.pending_confirmation_fr = plan.pending_confirmation_fr.concat(S.aiQuestions);
    S.plan = plan;
    S.approved = false;

    const open = plan.questions.length;
    if (open) {
      if (initial) say(`I need <b>${open}</b> answer${open > 1 ? "s" : ""} before the PDF is final.`);
      plan.questions.forEach((q) => renderQuestion(q));
    } else {
      const note = plan.pending_lines
        ? `${plan.pending_lines} line${plan.pending_lines > 1 ? "s are" : " is"} marked to confirm with the dentist and stay out of the total.`
        : "The PDF is on the right; approve it when you are happy.";
      say(`The plan is complete. Total <b>${money(plan.totals.total_eur)}</b>${plan.discount ? ` after the ${plan.discount.percent}% discount` : ""}. ${note}`);
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
      return `<button class="chip${sel}" data-q="${esc(q.id)}" data-v="${esc(String(o.value))}">${esc(o.label)} ${price}</button>`;
    }).join("");
    const el = say(`<div class="qtitle">${esc(q.text)}</div><div class="chips">${opts}</div>`);
    el.querySelectorAll("button.chip").forEach((b) => b.addEventListener("click", () => answer(q.id, parseVal(b.dataset.v), el)));
  }

  function answer(qid, value, bubble) {
    S.answers[qid] = value;
    bubble.querySelectorAll("button.chip").forEach((b) => {
      b.classList.toggle("sel", parseVal(b.dataset.v) === value);
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
    const toConfirm = !open && plan.pending_lines > 0;
    const blocked = open > 0 || plan.pending_lines > 0;
    $("total").textContent = money(plan.totals.total_eur);
    $("totalSub").textContent = open
      ? `Pending lines excluded. ${open} question${open > 1 ? "s" : ""} open.`
      : toConfirm
        ? `${plan.pending_lines} line${plan.pending_lines > 1 ? "s" : ""} waiting for the dentist, excluded from the total.`
        : (plan.discount ? `After ${plan.discount.percent}% ${plan.discount.label.toLowerCase()}.` : "Final.");
    $("pill").textContent = open
      ? `${open} question${open > 1 ? "s" : ""} open`
      : toConfirm ? "To confirm" : (S.approved ? "Approved" : "Ready for review");
    $("pill").className = "pill " + (blocked ? "open" : "ok");
    $("approve").disabled = blocked || S.approved;
    $("download").disabled = !S.approved;
  }

  function renderPDF(plan) {
    const doc = makePDF(plan, S.version, S.details);
    if (S.pdfUrl) URL.revokeObjectURL(S.pdfUrl);
    S.pdfUrl = URL.createObjectURL(doc.output("blob"));
    $("pdfBox").innerHTML = `<iframe src="${S.pdfUrl}" title="Treatment plan PDF"></iframe>`;
  }

  const LABELS = {
    en: {
      title: "Dental treatment plan", patient: "Patient", dentist: "Dentist", version: "Version",
      final: "Final", draft: (n) => `Draft · ${n} question${n > 1 ? "s" : ""} open`,
      toConfirm: "Draft · to confirm with dentist",
      stage: "Stage", stageTotal: (n) => `Stage ${n} total`,
      treatment: "Treatment", qty: "Qty", unit: "Unit price", amount: "Amount",
      discount: "Discount", subtotal: "Subtotal", total: "Total",
      excludes: "Excludes pending lines until confirmed.", allPriced: "All lines priced.",
      pending: "(pending)", toBeConfirmed: "To be confirmed",
      footer: "Estimate · subject to dentist confirmation", page: (i, n) => `Page ${i} of ${n}`,
      locale: "en-GB", numLocale: "en-US",
    },
    fr: {
      title: "Plan de traitement dentaire", patient: "Patient", dentist: "Dentiste", version: "Version",
      final: "Final", draft: (n) => `Brouillon · ${n} question${n > 1 ? "s" : ""} en attente`,
      toConfirm: "Brouillon · à confirmer avec le dentiste",
      stage: "Étape", stageTotal: (n) => `Total étape ${n}`,
      treatment: "Acte", qty: "Qté", unit: "Prix unitaire", amount: "Montant",
      discount: "Remise", subtotal: "Sous-total", total: "Total",
      excludes: "Hors lignes en attente jusqu'à confirmation.", allPriced: "Toutes les lignes sont chiffrées.",
      pending: "(en attente)", toBeConfirmed: "À confirmer",
      footer: "Estimation · sous réserve de confirmation par le dentiste", page: (i, n) => `Page ${i} sur ${n}`,
      locale: "fr-FR", numLocale: "fr-FR",
    },
  };

  function makePDF(plan, version, details = {}) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ unit: "mm", format: "a4" });
    const lang = details.lang === "fr" ? "fr" : "en";
    const T = LABELS[lang];
    const L = 16, R = 194;
    const INK = [22, 32, 40], MUTED = [110, 120, 128], TEAL = [11, 110, 96];
    const TEAL_BG = [228, 242, 238], LINE = [218, 223, 228];
    const AMBER = [154, 90, 10], AMBER_BG = [253, 243, 224];
    const BOTTOM = 270;
    const open = plan.questions.length;
    const toConfirm = !open && plan.pending_lines > 0;
    const patient = details.patient || plan.patient_ref;
    const today = new Date().toLocaleDateString(T.locale);
    const money2 = (v) => v == null ? ""
      : v.toLocaleString(T.numLocale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/[  ]/g, " ") + " EUR";
    const discountLabel = plan.discount ? (lang === "fr" ? plan.discount.label_fr : plan.discount.label) : "";
    let y = 0;

    const text = (s, x, yy, o) => doc.text(s, x, yy, o || {});
    const setInk = () => doc.setTextColor(...INK);
    const newPage = () => { doc.addPage(); y = 20; };
    const need = (h) => { if (y + h > BOTTOM) newPage(); };

    // Header band (first page only)
    doc.setFillColor(...TEAL); doc.rect(0, 0, 210, 28, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFont("helvetica", "bold"); doc.setFontSize(16);
    text(T.title, L, 12);
    if (details.clinic) { doc.setFontSize(11); text(details.clinic, R, 12, { align: "right" }); }
    const meta = [`${T.patient}: ${patient}`];
    if (details.doctor) meta.push(`${T.dentist}: ${details.doctor}`);
    meta.push(`${T.version} ${version}`, today);
    doc.setFont("helvetica", "normal"); doc.setFontSize(9);
    text(meta.join("   ·   "), L, 22);

    // Status pill
    y = 40;
    const label = open ? T.draft(open) : toConfirm ? T.toConfirm : T.final;
    const warn = open || toConfirm;
    doc.setFont("helvetica", "bold"); doc.setFontSize(9);
    const pillW = doc.getTextWidth(label) + 8;
    doc.setFillColor(...(warn ? AMBER_BG : TEAL_BG));
    doc.roundedRect(L, y - 4.5, pillW, 6.5, 2, 2, "F");
    doc.setTextColor(...(warn ? AMBER : TEAL));
    text(label, L + 4, y);
    y += 10;

    for (const st of plan.stages) {
      need(30);
      // Stage bar
      doc.setFillColor(...TEAL_BG); doc.rect(L, y - 5.5, R - L, 8, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(10.5); setInk();
      text(`${T.stage} ${st.number}`, L + 3, y);
      text(money2(st.total_eur), R - 3, y, { align: "right" });
      y += 7;

      // Column headers
      doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...MUTED);
      text(T.treatment, L + 3, y);
      text(T.qty, 126, y, { align: "right" });
      text(T.unit, 158, y, { align: "right" });
      text(T.amount, R - 3, y, { align: "right" });
      y += 2;
      doc.setDrawColor(...LINE); doc.line(L, y, R, y);
      y += 4.5;

      // Lines
      doc.setFontSize(9.5);
      for (const l of st.lines) {
        const pending = l.status === "pending";
        const desc = doc.splitTextToSize(l.description + (pending ? " " + T.pending : ""), 102);
        const rowH = Math.max(6, desc.length * 4.6 + 1.6);
        need(rowH);
        doc.setFont("helvetica", "normal");
        doc.setTextColor(...(pending ? AMBER : INK));
        text(desc, L + 3, y);
        setInk();
        if (l.quantity != null) text(String(l.quantity), 126, y, { align: "right" });
        if (l.unit_price_eur != null) text(money2(l.unit_price_eur), 158, y, { align: "right" });
        if (l.subtotal_eur != null) text(money2(l.subtotal_eur), R - 3, y, { align: "right" });
        doc.setDrawColor(...LINE); doc.line(L, y + 1.8, R, y + 1.8);
        y += rowH;
      }

      // Stage discount and total
      need(14);
      y += 1;
      doc.setFontSize(9.5);
      if (st.discount_eur > 0) {
        setInk(); doc.setFont("helvetica", "normal");
        text(discountLabel || T.discount, L + 3, y);
        text(`-${money2(st.discount_eur)}`, R - 3, y, { align: "right" });
        y += 5;
      }
      setInk(); doc.setFont("helvetica", "bold");
      text(T.stageTotal(st.number), L + 3, y);
      text(money2(st.total_eur), R - 3, y, { align: "right" });
      y += 11;
    }

    // Summary box
    need(46);
    const boxX = 96, boxW = R - boxX;
    const boxTop = y;
    let sy = y + 8;
    const sumRow = (lbl, val, bold) => {
      doc.setFont("helvetica", bold ? "bold" : "normal");
      doc.setFontSize(bold ? 12 : 9.5); setInk();
      text(lbl, boxX + 4, sy);
      text(val, R - 4, sy, { align: "right" });
      sy += bold ? 5 : 6;
    };
    sumRow(T.subtotal, money2(plan.totals.subtotal_eur), false);
    if (plan.discount) sumRow(`${discountLabel} (-${plan.discount.percent}%)`, `-${money2(plan.totals.discount_eur)}`, false);
    sy += 1; doc.setDrawColor(...LINE); doc.line(boxX + 4, sy, R - 4, sy);
    sy += 6;
    sumRow(T.total, money2(plan.totals.total_eur), true);
    doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...MUTED);
    text(warn ? T.excludes : T.allPriced, boxX + 4, sy + 1);
    sy += 3;
    doc.setDrawColor(...LINE); doc.roundedRect(boxX, boxTop, boxW, sy + 4 - boxTop, 2, 2, "S");
    y = sy + 12;

    // To be confirmed
    const confirmList = lang === "fr" ? plan.pending_confirmation_fr : plan.pending_confirmation;
    if (confirmList.length) {
      const items = confirmList.map((p) => doc.splitTextToSize("• " + p, R - L - 10));
      const h = 12 + items.reduce((a, it) => a + it.length * 4.6 + 1.5, 0);
      need(h);
      doc.setFillColor(...AMBER_BG); doc.roundedRect(L, y, R - L, h, 2, 2, "F");
      doc.setFont("helvetica", "bold"); doc.setFontSize(10); doc.setTextColor(...AMBER);
      text(T.toBeConfirmed, L + 4, y + 6);
      let iy = y + 12;
      doc.setFont("helvetica", "normal"); doc.setFontSize(9.5); setInk();
      for (const it of items) { text(it, L + 4, iy); iy += it.length * 4.6 + 1.5; }
      y += h + 6;
    }

    // Footer on every page
    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++) {
      doc.setPage(i);
      doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...MUTED);
      doc.setDrawColor(...LINE); doc.line(L, 282, R, 282);
      text(T.footer, L, 287);
      text(T.page(i, pages), R, 287, { align: "right" });
    }
    return doc;
  }

  function renderVersions() {
    $("versions").innerHTML = S.versions.map((v) =>
      `<li>v${v.v} · ${esc(v.status)} · ${money(v.total)}${v.approved ? " · <b>approved</b>" : ""}</li>`).reverse().join("")
      || `<li class="muted">None yet</li>`;
  }

  function approve() {
    if (!S.plan || S.plan.status !== "final") return;
    S.approved = true;
    S.versions[S.versions.length - 1].approved = true;
    renderVersions();
    renderPanel(S.plan);
    say(`Version ${S.version} approved. You can download the PDF.`);
  }

  function download() {
    const a = document.createElement("a");
    a.href = S.pdfUrl;
    const who = (S.details.patient || S.plan.patient_ref).replace(/[^\w-]+/g, "_");
    a.download = `treatment-plan-${who}-v${S.version}-${S.details.lang}.pdf`;
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

  // Plan details (clinic, dentist, patient, language) are kept when a new plan starts.
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

  async function aiExtract(text) {
    const busy = say("Reading the dictation…");
    try {
      const res = await fetch(WORKER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `status ${res.status}`);
      const parsed = JSON.parse(data.choices[0].message.content);
      busy.remove();
      applyAI(parsed);
    } catch (err) {
      busy.innerHTML = `Could not read the dictation (${esc(err.message)}). Please try again in a moment.`;
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