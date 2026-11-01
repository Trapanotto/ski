# Trapanotto Ski – Swiss Downhill

Stilisiertes Arcade-Abfahrtsspiel im Browser (three.js) auf echten Schweizer Weltcup-Strecken.
Gelände, Wald, Gebäude und Lifte stammen aus swisstopo-Geodaten. Modelle und Strecke werden per Skript in Blender gebaut.

**Spielen:** https://trapanotto.github.io/ski/

| Strecke | Ort | Stand |
|---|---|---|
| Lauberhorn | Wengen | spielbar |
| Mont Lachaux | Crans-Montana | geplant |
| Engiadina | St. Moritz | geplant |
| Silvano Beltrametti | Lenzerheide | geplant |
| Gran Becca | Zermatt / Cervinia | geplant |

Modi: **Rennen** (Zeit, Tore, Geist der Bestzeit), **Training** (Sprung zu Schlüsselstellen), **Freeride** (ganzer Berg, Lifte).
Steuerung: Tastatur, Gamepad oder Touch.

## Pipeline

```
tools/fetch_data.py      einmaliger Download (swisstopo STAC + OSM-Pistenlinie)  -> data/raw/   (nicht im Git)
tools/process_course.py  Höhenraster, Schneeglättung, Bäume/Gebäude, Tore, Schatten -> public/courses/<id>/, data/work/
tools/blender/build_assets.py   Fahrer (Herren/Damen), Tannen, Chalet, Tore, Lifte, Start/Ziel -> public/models/
tools/blender/build_course.py   Gelände (2 Detailstufen), Panorama, Strecke -> public/courses/<id>/*.glb + .blend
```

```bash
python -m venv .venv && .venv\Scripts\pip install rasterio numpy scipy requests pillow
.venv\Scripts\python tools/fetch_data.py lauberhorn
.venv\Scripts\python tools/process_course.py lauberhorn
blender -b --factory-startup -P tools/blender/build_assets.py
blender -b --factory-startup -P tools/blender/build_course.py -- lauberhorn
npm install && npm run dev
```

Eine neue Strecke: Eintrag in `tools/courses.json` (Ursprung LV95, Anzahl 512-m-Blöcke, OSM-Pistenname), dann die vier Schritte.
Tore, Netze und Zielraum können danach in `data/work/<id>/<id>.blend` von Hand angepasst und neu exportiert werden.

### Verwendete Daten

- swissALTI3D (2 m), swissSURFACE3D Raster (0,5 m, für Baumhöhen und Gebäude), SWISSIMAGE (2 m), swissALTIRegio (Panorama), Bahnen Winter
- Pistenlinie der Rennstrecke aus OpenStreetMap

Geodaten © swisstopo · Pistenlinien © OpenStreetMap-Mitwirkende (ODbL)
