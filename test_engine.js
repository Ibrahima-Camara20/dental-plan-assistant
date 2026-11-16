const fs = require("fs");
const E = require("./engine.js");
const prices = JSON.parse(fs.readFileSync("data/prices.json", "utf8"));
const rules = JSON.parse(fs.readFileSync("data/rules.json", "utf8"));
const ex = JSON.parse(fs.readFileSync("data/extractions/patient3.json", "utf8"));
const answers = { "s1-graft:match": 144, "s1-impl:match": 174, "s1-sed:duration": 4, "s2-temp:match": 148 };

const v1 = E.build(ex, prices, rules, {});
console.log("v1 questions:", v1.questions.length, "total:", v1.totals.total_eur);
v1.questions.forEach((q) => console.log(" -", q.id, q.options.map((o) => o.value).join(",")));
const v2 = E.build(ex, prices, rules, answers);
console.log("v2 questions:", v2.questions.length, "status:", v2.status, "total:", v2.totals.total_eur, "subtotal:", v2.totals.subtotal_eur, "discount:", v2.totals.discount_eur);
const ok = v1.questions.length === 4 && Math.abs(v1.totals.total_eur - 417.25) < 0.005 && v2.questions.length === 0 && Math.abs(v2.totals.total_eur - 2890.79) < 0.005;
console.log(ok ? "PASS: matches Python prototype" : "FAIL");
process.exit(ok ? 0 : 1);
