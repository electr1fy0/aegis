# Aegis presentation source

`build.mjs` exports `build(presentation, options)` from `build-redesign.mjs`. It creates 13 editable slides through the first-party Artifact Tool presentation API. Screenshots are stored in `../latex-report/screenshots/`.

The optional `assetDirectory` argument can point to another absolute screenshot directory. The default resolves relative to this source file. Import the module and call `build` inside an Artifact Session presentation callback, then export the presentation as PPTX.

The current deck is `../../output/Aegis_Presentation_Redesigned.pptx`. It uses Avenir Next, charcoal and white backgrounds, and the orange accent from Aegis. The processing sequence, priority rows and report excerpts are editable text. All three charts are native PowerPoint objects with embedded workbooks containing their displayed data. Source references and demonstration notes are stored in each slide's speaker notes.
