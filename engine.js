/* Treatment-plan engine: prices, rules, clarification questions, totals.
   Plain JavaScript, no dependencies. Same logic as the Python prototype. */
(function (global) {
  const EXACT = 0.95;

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

  function byRow(rows, n) {
    const r = rows.find((x) => x.row === n);
    if (!r) throw new Error("no price row " + n);
    return r;
  }

  const r2 = (x) => Math.round(x * 100) / 100;

  function option(row, note = "") {
    return { value: row.row, label: `${row.service} (${row.section})`, price_eur: row.price_eur, note };
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
    const qid = `${item.id}:match`;
    const qty = item.quantity ?? 1;
    const dictated = item.dictated_price ?? null;

    if (qid in answers) {
      lines.push(line(item, byRow(prices, answers[qid]), qty, "resolved by dentist"));
      return;
    }

    const cands = search(item.text, prices, 4);
    const exact = cands.filter((c) => c.score >= EXACT).map((c) => c.row);
    const exactPrices = new Set(exact.map((r) => r.price_eur));

    if (exact.length && exactPrices.size === 1 && (dictated === null || exactPrices.has(dictated))) {
      lines.push(line(item, exact[0], qty, "price list"));
      return;
    }

    const options = cands.map((c) => option(c.row));
    if (dictated !== null) {
      for (const r of prices) {
        if (r.price_eur === dictated && !options.some((o) => o.value === r.row)) {
          options.push(option(r, `matches dictated price ${dictated.toFixed(2)} EUR`));
        }
      }
    }
    let reason = "no exact match in the price list";
    if (exactPrices.size > 1) reason = "same procedure appears with different prices in the price list";
    else if (dictated !== null && exact.length) reason = `dictated price ${dictated.toFixed(2)} EUR differs from the price list`;

    questions.push({ id: qid, text: `Which price list entry applies to "${item.text}"? Reason: ${reason}.`, options });
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
    return {
      patient_ref: extraction.patient_ref,
      status: questions.length ? "draft – open questions" : "final",
      discount: discount ? { label: discount.label, percent: discount.percent } : null,
      stages,
      totals: { subtotal_eur: gs, discount_eur: gd, total_eur: r2(gs - gd) },
      questions,
      pending_confirmation: rules.pending_confirmation || [],
    };
  }

  const api = { build, search, similarity };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  global.DentalEngine = api;
})(typeof window !== "undefined" ? window : globalThis);
