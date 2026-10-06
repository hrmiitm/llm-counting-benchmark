# Page 4: the reasoning experiment

Open `reasoning.html`. This is a standalone page; no existing page, navigation,
script, stylesheet, prediction JSON or scoring metadata is modified.

The three charts are **Cost vs Counting Error**, **Confidence vs Counting Error**,
and **Error vs Coverage**, with zero error at the top. Use the all-model view,
model selector or model legend, effort checkboxes, linear/log cost axis, and
confidence cutoff. Focus or select a point for its details. The model/effort
selection and cutoff are saved in the URL. Light/dark mode uses the existing theme.

Predictions, confidence, costs and settings are read from top-level `eval4/`
JSON envelopes. Smoke tests and earlier evaluation folders are excluded.
Supplied counts are read from the existing `eval2/metadata.json`; they are not
copied into prediction files. All chart values, summaries and findings are
computed in the browser. The JSON files themselves are left unchanged.

`reasoning-sources.json` is a new Liquid/Jekyll template. The repository's current
GitHub Pages build (from `main`, repository root) generates its list from
[`site.static_files`](https://jekyllrb.com/docs/static-files/). Adding or removing
top-level `eval4/` JSON files therefore updates discovery on the next Pages
build, without maintaining filenames or editing the page. Changed prediction
values update the charts and answers when the published JSON is fetched again.
As with the existing site, local changes must be committed/pushed to the Pages
source before they are published. See [GitHub Pages build behavior](https://docs.github.com/en/pages/setting-up-a-github-pages-site-with-jekyll/about-github-pages-and-jekyll#building-your-site-locally).

The **Refresh data** button fetches JSON again without relying on browser cache.
**Update each minute** refreshes an open, visible page. For a plain local Python
server, the page uses its `eval4/` directory listing because the Liquid index
has not been rendered. A different hosting pipeline must render the index or
supply the equivalent `{ "files": ["eval4/…json"] }` list at that URL.

Full-image cost points require complete scored answers and known charges.
Failed-call costs remain in known subtotals; unknown charges never become zero.
Partial confidence/coverage curves may end below full coverage. Confidence ties
enter together rather than producing arbitrary intermediate steps.
Different non-effort settings within a model prevent connectors and reasoning
conclusions. Different model token caps remain visible as a comparison caveat.
Confidence is still P(exact count); these are selective-error/association plots,
not a claim of formal probability calibration.

Preview and verify without any model calls:

```bash
python3 -m http.server 8765
# Open http://localhost:8765/reasoning.html
node scripts/reasoning-data-test.mjs
# With isolated Chrome listening on port 9222:
node scripts/reasoning-browser-test.mjs
```

Publish the five new page assets (`reasoning.html`, `.css`, `.js`, `-data.mjs`,
and `-sources.json`) alongside the existing shared theme/navigation files,
`eval4/` results, scoring metadata and corresponding Group 1 images.
The existing publishing setup and original pages are unchanged.
