# Project assets

The app icon, used by app-store packaging (Umbrel, Start9, future
community stores) and general branding.

| File | Size | Use |
|---|---|---|
| `icon.webp` | 1024×1024 | Master / canonical source. |
| `icon-512.png` | 512×512 | Common app-store raster fallback. |
| `icon-256.png` | 256×256 | Smaller raster for compact contexts. |

The illustration was contributed by a community member ("from
Bainter"); operator approved it for project-wide use under the
project's MIT license. To regenerate the PNGs from the master:

```bash
magick assets/icon.webp -resize 512x512 assets/icon-512.png
magick assets/icon.webp -resize 256x256 assets/icon-256.png
```
