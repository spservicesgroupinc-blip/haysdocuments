# Brand & UI Reference

**Hays + Sons — Restoration Document Suite**
Applies to the web app (`src/`), the generated PDF packet (`src/services/pdfService.ts`) and the
Google Sheets database header (`apps-script/Code.gs`).

---

## 1. Logo

The mark is **typographic only** — there is no image asset, SVG or favicon in the repository.

| Element | Specification | Source |
| --- | --- | --- |
| Mark | Rounded square, `rounded-lg` (8px), 36x36px | `src/components/Navbar.tsx` |
| Mark fill | Brand red `#DC2626` | |
| Mark glyph | `H+`, white, `font-bold`, 14px, `tracking-tight` | |
| Wordmark | "Hays & Sons" — 15px, `font-semibold`, `tracking-tight`, `slate-900` | |
| Sub-label | "Restoration Document Suite" — 11px, `slate-500` | |

The glyph is a text node rather than vector art, so it renders slightly differently per platform.

---

## 2. Colour

Deliberately narrow: **one brand red plus the neutral `slate` ramp**, with three semantic signals.

### Core palette

| Role | Token | Hex | Used for |
| --- | --- | --- | --- |
| Brand primary | `red-600` | `#DC2626` | Logo mark, Save, primary CTAs, active tab |
| Brand hover | `red-700` | `#B91C1C` | Button hover states |
| Focus | `red-500` | `#EF4444` | Input focus border and ring |
| Brand tint | `red-50` | `#FEF2F2` | Icon chips, file badges |
| Page canvas | `slate-50` | `#F8FAFC` | App background |
| Surface | `white` | `#FFFFFF` | Cards, header |
| Border | `slate-200` | `#E2E8F0` | All card and control borders |
| Text primary | `slate-900` | `#0F172A` | Headings, values |
| Text secondary | `slate-500` | `#64748B` | Labels, hints |
| Text tertiary | `slate-400` | `#94A3B8` | Placeholders, decorative icons |

### Semantic signals

| State | Token | Hex | Applied to |
| --- | --- | --- | --- |
| Saved / connected | `emerald-500` | `#10B981` | Header status dot |
| Unsaved / caution | `amber-500` | `#F59E0B` | Unsaved dot, developer-mode warning |
| Error | `rose-700` | `#BE123C` | Error copy |

### Known inconsistency — three reds

| Surface | Red | Source |
| --- | --- | --- |
| Web app | `#DC2626` | Tailwind `red-600` |
| Generated PDFs | `#D91A1A` | `rgb(0.85, 0.1, 0.1)` in `pdfService.ts` |
| Google Sheet header | `#B91C1C` | `applySheetFormatting_` in `Code.gs` |

Printed collateral therefore does not match the app exactly. **Recommendation:** collapse to a single
brand red token and reference it from all three surfaces.

---

## 3. Typography

**Family:** no webfont is loaded. The stack is Tailwind's default `font-sans`
(`ui-sans-serif`, `system-ui`, `"Segoe UI"`, `Roboto`, ...), applied on the app root. Rendering
therefore varies by operating system.

| Role | Size | Weight | Notes |
| --- | --- | --- | --- |
| Headline figure | 24px | 600 | `tabular-nums` |
| Card / section title | 15px | 600 | `tracking-tight` on the wordmark |
| Body, inputs, buttons | 13px | 400-600 | |
| Labels, hints | 12px | 500 | |
| Micro (badges, filenames) | 11px | 500 | |
| Mono | 11px | | Filenames, job numbers |

All financial numerals use `tabular-nums` so columns do not shift as values change.

**Recommendation:** promote these sizes to named theme tokens (`text-body`, `text-title`) instead of
inline arbitrary values such as `text-[13px]`, which is how drift starts.

---

## 4. Surfaces, radius and elevation

| Layer | Radius | Elevation |
| --- | --- | --- |
| Controls (inputs, buttons) | `rounded-lg` — 8px | none; `shadow-sm` on primary only |
| Cards and panels | `rounded-xl` — 12px | none — **borders carry the structure** |
| Modals | `rounded-2xl` — 16px | `shadow-lg` / `shadow-2xl` |
| Toast | `rounded-xl` | `shadow-lg` |

Cards use a 1px `slate-200` border rather than drop shadows. Shadows are reserved for genuinely
floating layers, which is what keeps the interface from reading as decorative.

---

## 5. Layout and navigation

- **Canvas** — max-width 1400px, 20px gutters, `slate-50` background
- **Header** — sticky, 64px tall, white at 95% opacity with backdrop blur, 1px bottom border
- **Header order** — brand, job-context chip, Customers, primary Save, account menu
- **Navigation** — persistent side menu, one entry per section, with a red-tinted active pill; below
  the `lg` breakpoint it collapses into a scrollable pill strip. The intake parser card always stays
  at the top of the workspace, above the selected section.
- **Content** — single column of cards on a 24px vertical rhythm
- **Control heights** — 36px in the header, 40px for form inputs

---

## 6. Component conventions

- **Icons** — `lucide-react`; 16px inline, 20px inside tiles. Icon tiles are `bg-slate-100` with
  `slate-500` glyphs. Colour is never used purely for decoration.
- **Inputs** — `slate-50` fill, white on focus; `slate-300` border, `red-500` plus a soft ring on focus.
- **Status** — always a coloured dot *plus* text, never colour alone.
- **Buttons** — one primary (red) action per view; everything else is a white bordered or ghost button.

---

## 7. Motion

Restrained and functional: `transition-colors` on interactive elements, `animate-spin` on loaders,
a 200ms slide-in for the toast, and a rotating chevron on the account menu. No spring, bounce or
parallax effects.

---

## 8. Accessibility

Contrast ratios measured against white:

| Pair | Ratio | Verdict |
| --- | --- | --- |
| `slate-900` text | 17.9:1 | Passes AAA |
| `slate-500` text | 4.76:1 | Passes AA |
| White on `red-600` | approx. 4.4:1 | Just under the 4.5:1 AA threshold for normal text |
| `slate-400` text | 2.56:1 | Fails AA — also below the 3:1 minimum for UI components |

**Actions:**

1. Darken placeholder and tertiary text from `slate-400` to `slate-500` (4.76:1).
2. Use `red-700` behind white button text (approx. 5.9:1).

---

## 9. Outstanding gaps

1. **No real logo asset** — the mark is text in a coloured box. No SVG, no favicon (`index.html` has
   no `icon` link), and no usage guidance for print or PDF.
2. **Three reds** in circulation — see section 2.
3. **Type scale is approximately 85% unified.** The legacy section components (`SectionInsurance`,
   `SectionTeam`, `SectionMortgage`, `SectionChangeOrder`, `SectionChecklist`) still use `text-sm`
   (14px) inputs and a few `text-[10px]` labels, while `Navbar`, `FinancialSummaryCard`,
   `SectionCustomer` and `DocumentGenerationPanel` use the 13px / 12px scale.
4. **No named type tokens** — sizes are inline arbitrary values.
5. **System font only** — Windows and macOS render the product differently. Consider a licensed or
   open typeface such as Inter if cross-platform consistency matters.
6. **White on red** is the only place brand red carries small text; verify in print, where `#DC2626`
   can shift noticeably.
