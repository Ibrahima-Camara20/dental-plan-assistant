# Dental Plan Assistant

A static web app (GitHub Pages) that turns a dentist's dictated treatment notes into a
priced treatment plan PDF. The flow:

1. **Dictate**: record speech (browser speech recognition) or load a sample dictation.
2. **Plan & clarify**: the plan is built from the clinic price list. Anything that cannot be
   priced with confidence becomes a question with options (e.g. two prices for the same procedure).
3. **Review & approve**: the PDF is generated from the plan. Download unlocks only after approval.

Totals are computed in code (`engine.js`), never by a language model.

## Files

- `index.html`, `style.css`, `app.js`: the interface
- `engine.js`: plan engine (price search, rules, questions, totals), plain JavaScript
- `data/prices.json`: clinic price list, normalised (section, service, code, price)
- `data/rules.json`: discounts, sedation rule, items to confirm
- `data/extractions/`: the structured reading of a dictation (stand-in for the AI step)
- `data/samples/`: sample dictations
- `vendor/jspdf.umd.min.js`: PDF library, vendored so the site works without a CDN
- `test_engine.js`: parity test (`node test_engine.js`)

## Run locally

```
python3 -m http.server 8000
```

then open http://localhost:8000. Speech recognition needs Chrome or Edge.

## Not included yet

- **AI extraction**: turning free-text dictation into the structured plan. It needs a model
  call from a back end, because API keys must not sit in a public page.
- **Corrections by voice or text**: same reason.
- **Sending to the patient**: needs a back end.

## Publish on GitHub Pages

Settings → Pages → Source: "Deploy from a branch", branch `main`, folder `/ (root)`.
