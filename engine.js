/* Treatment-plan engine: prices, rules, clarification questions, totals.
   Plain JavaScript, no dependencies. Same logic as the Python prototype. */
(function (global) {
  const EXACT = 0.95;
  const CONFIRM = "confirm"; // answer meaning "keep the line pending, the dentist will confirm"

  function norm(s) {
    return String(s).toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
  }

  function bigrams(s) {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const k = s.slice(i, i + 2);
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }

  // Dice coefficient on character bigrams, in [0, 1].
  function similarity(a, b) {
    a = norm(a); b = norm(b);
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const A = bigrams(a), B = bigrams(b);
    let inter = 0;
    for (const [k, v] of A) if (B.has(k)) inter += Math.min(v, B.get(k));
    return (2 * inter) / ((a.length - 1) + (b.length - 1));
  }

  function search(query, rows, limit = 4) {
    return rows
      .map((r) => ({ score: similarity(query, r.service), row: r }))
      .sort((x, y) => y.score - x.score)
      .slice(0, limit);
  }

  // A generic implant placement ("Implant placement (brand unspecified)") can only be
  // one of the real implant placements: never a mini-implant, a sinus lift or a graft.
  function isGenericImplantPlacement(text) {
    return /implant placement/i.test(text) && !/mini|sinus|graft|lamina|socket|removal|guide/i.test(text);
  }

  function implantPlacementCandidates(prices, text) {
    return prices
      .filter((r) => /implant placement( \(.*\))?$/i.test(r.service) && !/mini|socket|sinus|graft|lamina|removal/i.test(r.service))
      .map((r) => ({ score: similarity(text, r.service), row: r }))
      .sort((x, y) => x.row.price_eur - y.row.price_eur);
  }

  function byRow(rows, n) {
    const r = rows.find((x) => x.row === n);
    if (!r) throw new Error("no price row " + n);
    return r;
  }

  const r2 = (x) => Math.round(x * 100) / 100;

  function option(row, note = "") {
    return { value: row.row, label: `${row.service} (${row.section})`, price_eur: row.price_eur, note };
  }

  function confirmOption() {
    return { value: CONFIRM, label: "Confirm with the dentist (keep pending)", price_eur: null, note: "" };
  }

  function line(item, row, qty, source) {
    return {
      item_id: item.id, stage: item._stage, description: row.service, section: row.section,
      quantity: qty, unit_price_eur: row.price_eur, subtotal_eur: r2(row.price_eur * qty),
      status: "resolved", source, row: row.row,
    };
  }

  function pending(item, qty = null) {
    return {
      item_id: item.id, stage: item._stage, description: item.text || "Sedation",
      quantity: qty, unit_price_eur: null, subtotal_eur: null, status: "pending", source: null, row: null,
    };
  }

  function resolveItem(item, prices, answers, lines, questions) {
    const qid = `${item._group}:match`;
    const qty = item.quantity ?? 1;
    const dictated = item.dictated_price ?? null;

    if (qid in answers) {
      if (answers[qid] === CONFIRM) lines.push(pending(item, qty));
      else lines.push(line(item, byRow(prices, answers[qid]), qty, "resolved by dentist"));
      return;
    }

    const generic = isGenericImplantPlacement(item.text);
    const cands = generic
      ? implantPlacementCandidates(prices, item.text)
      : search(item.text, prices, 4);
    const exact = cands.filter((c) => c.score >= EXACT).map((c) => c.row);
    const exactPrices = new Set(exact.map((r) => r.price_eur));

    if (exact.length && exactPrices.size === 1 && (dictated === null || exactPrices.has(dictated))) {
      lines.push(line(item, exact[0], qty, "price list"));
      return;
    }

    const options = cands.map((c) => option(c.row));
    if (dictated !== null && !generic) {
      for (const r of prices) {
        if (r.price_eur === dictated && !/mini/i.test(r.service) && !options.some((o) => o.value === r.row)) {
          options.push(option(r, `matches dictated price ${dictated.toFixed(2)} EUR`));
        }
      }
    }
    options.push(confirmOption());

    let reason = "no exact match in the price list";
    if (exactPrices.size > 1) reason = "same procedure appears with different prices in the price list";
    else if (dictated !== null && exact.length) reason = `dictated price ${dictated.toFixed(2)} EUR differs from the price list`;

    if (!questions.some((q) => q.id === qid)) {
      questions.push({ id: qid, text: `Which price list entry applies to "${item.text}"? Reason: ${reason}.`, options });
    }
    lines.push(pending(item, qty));
  }

  function resolveSedation(item, prices, answers, lines, questions) {
    const qid = `${item.id}:duration`;
    if (!(qid in answers)) {
      questions.push({
        id: qid, text: "How long is the sedation? (sedation is billed per hour)",
        options: [
          { value: 1, label: "1 hour", price_eur: null, note: "" },
          { value: 4, label: "4 hours", price_eur: null, note: "" },
          { value: 0, label: "No sedation", price_eur: null, note: "" },
        ],
      });
      lines.push(pending(item));
      return;
    }
    const hours = answers[qid];
    if (hours === 0) return;
    const first = prices.find((r) => r.service === "Sedation – first hour");
    const extra = prices.find((r) => r.service === "Sedation – each additional hour");
    lines.push(line(item, first, 1, `${hours} h sedation, first hour`));
    if (hours > 1) lines.push(line(item, extra, hours - 1, `${hours} h sedation, additional hours`));
  }

  function build(extraction, prices, rules, answers = {}) {
    const lines = [], questions = [];
    const key = (extraction.rules_applied || [])[0];
    const discount = key ? rules.discounts[key] : null;

    // Items with the same wording share one question, so the dentist answers it once.
    const groups = {};
    for (const st of extraction.stages) for (const it of st.items) {
      if (it.kind === "sedation") continue;
      const k = norm(it.text || "");
      if (!(k in groups)) groups[k] = it.id;
      it._group = groups[k];
    }

    for (const st of extraction.stages) {
      for (const it of st.items) {
        const item = { ...it, _stage: st.number };
        if (item.kind === "sedation") resolveSedation(item, prices, answers, lines, questions);
        else resolveItem(item, prices, answers, lines, questions);
      }
    }

    const stages = extraction.stages.map((st) => {
      const sl = lines.filter((l) => l.stage === st.number);
      const sub = r2(sl.filter((l) => l.status === "resolved").reduce((a, l) => a + l.subtotal_eur, 0));
      const pct = discount ? discount.percent : 0;
      const disc = r2((sub * pct) / 100);
      return { number: st.number, interval_after: st.interval_after ?? null, lines: sl,
               subtotal_eur: sub, discount_eur: disc, total_eur: r2(sub - disc) };
    });

    const gs = r2(stages.reduce((a, s) => a + s.subtotal_eur, 0));
    const gd = r2(stages.reduce((a, s) => a + s.discount_eur, 0));
    const pendingLines = lines.filter((l) => l.status === "pending").length;

    let status = "final";
    if (questions.length) status = "draft – open questions";
    else if (pendingLines) status = "draft – to confirm with dentist";

    return {
      patient_ref: extraction.patient_ref,
      status,
      discount: discount ? { label: discount.label, label_fr: discount.label_fr || discount.label, percent: discount.percent } : null,
      stages,
      totals: { subtotal_eur: gs, discount_eur: gd, total_eur: r2(gs - gd) },
      questions,
      pending_lines: pendingLines,
      pending_confirmation: rules.pending_confirmation || [],
      pending_confirmation_fr: rules.pending_confirmation_fr || rules.pending_confirmation || [],
    };
  }

  const api = { build, search, similarity, isGenericImplantPlacement, CONFIRM };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.DentalEngine = api;
})(typeof window !== "undefined" ? window : globalThis);