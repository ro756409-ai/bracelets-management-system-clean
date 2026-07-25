# Matjarak brand assets — placement guide

`BrandLogo` (`client/src/components/BrandLogo.tsx`) currently renders an inline SVG
placeholder mark (`BrandMark.tsx`) instead of reading files from this folder, because no
final asset files exist yet. Once you have the approved SVG/PNG exports, drop them here
using these exact filenames, then update `BrandLogo.tsx` to import from this folder instead
of rendering the placeholder — no other file needs to change, since every screen already
goes through `BrandLogo`/`BrandMark`.

| File | Use |
|---|---|
| `logo-full-ar.svg` | Full Arabic-only lockup (icon + "متجرك") |
| `logo-full-ar-en.svg` | Full bilingual lockup (icon + "متجرك" + "Matjarak") |
| `logo-icon.svg` | Icon/mark only |
| `logo-light.svg` | Light-colored version, for dark backgrounds |
| `logo-dark.svg` | Dark-colored version, for light backgrounds |
| `favicon.svg` | Replaces the temporary `client/public/favicon.svg` |
| `logo-icon.png`, `logo-full-ar.png`, `logo-full-ar-en.png` | PNG fallbacks (raster export at 2x/3x) for contexts that can't use SVG |

Per the approved brand book: minimum size is 16px for the icon-only mark, 96px minimum
width for the full lockup with wordmark. Clear space around the mark equals the height of
one leg of the "M" — keep that space free of text/edges when placing these files anywhere
outside `BrandLogo`.
