# Workspace redesign

Mode: Operate. Audience: developers teaching an unfamiliar local codebase. The task remains selecting an entry, stepping through calls, and manually choosing branches. All existing panels, static-analysis caveats and debugging controls remain available.

## Direction contract

THESIS: A composed code walkthrough inspired by the neutral navigation and typography of OpenDesign. The old tinted IDE shell and equally weighted diagram boxes are replaced by a clear hierarchy centered on the current function.

OWN-WORLD: Chalk #f7f7f5, white #ffffff, graphite #262626, stone #6c6a63, rule #e2e1dc, restrained ochre #78581c for unconfirmed paths. Albert Sans for interface and titles, Chinese system sans fallback, monospace only for source and identifiers. Dark appearance inverts neutral surfaces. No green or blue UI colors.

STORY: Find an API or component on the left, read the current function in the center, choose or advance the path, inspect source and assumptions on the right, then revisit a past event in the bottom timeline.

FIRST VIEWPORT: A 64px product bar, grouped playback toolbar, 244px entry rail, a dominant scrollable teaching canvas, and 292px inspector. Center tabs are segmented; breadcrumb is quieter. Entry title 24px, active function 22px, supporting prose 14px. The current function is the single solid graphite diagram block; pending targets use a dashed outline. A single traveling dot follows actual enter/leave events. Below it, a source expression, next-step action and source structure remain readable. Narrow centers stack the call diagram in the same order; mobile retains step/play and the two panel restore rails.

FORM: User-pinned OpenDesign direction overrides seed 08fd60e6, assigned index 4. Code-led implementation; no generated mockup is needed for this existing operational workspace. Candidate sources considered: OpenDesign neutral shell, API documentation, book indexes, instructional diagram notation, annotated source books, flowchart standards, and dependency atlases. The pin determines the system; unrelated catalog motifs are declined because they obscure the code-learning task. Their density and state discipline are retained as functional requirements, not decoration.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

Reference inspected: https://open-design.ai/zh/ on 2026-10-15. Its interface font is Albert Sans, foreground rgb(38,38,38), neutral navigation and rounded actions. Its hero's blue/green artwork is explicitly excluded by the user's color constraint. The user confirmed this reference and authorized direct implementation.
