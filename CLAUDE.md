# Health Dashboard – CLAUDE.md

## Projektübersicht

Electron-App für persönliche Gesundheitsdaten via Google Fit API.
Polar-Daten (Lauf, Schlaf) fließen über die Polar→Google Fit Synchronisation ein.

## Projektstruktur

```
health-dashboard/
├── main.js        # Electron Main Process – nur Fenster + 3 Window-Controls-IPC
├── renderer.js    # Gesamte App-Logik: OAuth, Google Fit API, UI, Charts
├── index.html     # HTML-Shell + CSS (Dark Theme)
├── package.json
└── CLAUDE.md
```

## Architektur

Gleiche Architektur wie LIPA BILLING (`c:\Tools\Billing 26`):
- `nodeIntegration: true`, `contextIsolation: false` – kein Preload, kein contextBridge
- **main.js** ist minimal (~25 Zeilen): erstellt nur das BrowserWindow + 3 IPC-Listener für Window-Controls
- **renderer.js** hat vollen Node.js-Zugriff: `require('https')`, `require('fs')`, `require('electron').shell` etc.
- Alle Logik (OAuth, API-Calls, Token-Storage, Charts) läuft in renderer.js

### IPC-Kanäle (nur Window Controls)

| Kanal | Richtung | Beschreibung |
|---|---|---|
| `win:minimize` | renderer→main | Fenster minimieren |
| `win:maximize` | renderer→main | Fenster maximieren/wiederherstellen |
| `win:close`    | renderer→main | Fenster schließen |

Kein IPC für Daten – alles läuft direkt im Renderer.

## Entwicklung

```
npm install        # einmalig – lädt Electron + Chart.js in node_modules
npm start          # öffnet die App (aus eigenem PowerShell-Terminal, nicht Claude-Tools)
npm run build      # Windows NSIS Installer in dist/
```

> **Wichtig:** `npm start` muss aus dem eigenen Windows-Terminal (PowerShell / Windows Terminal)
> ausgeführt werden, nicht über Claude Code's integrierte Shell – Electron's Modul-Hooks
> funktionieren in der sandboxed Umgebung von Claude nicht korrekt.

Electron: 29.x · Node.js: ≥18

## Google Fit API

### Credentials einrichten (einmalig)

1. [console.cloud.google.com](https://console.cloud.google.com) → Neues Projekt
2. APIs & Services → Library → **„Fitness API"** aktivieren
3. APIs & Services → Credentials → **„+ Create Credentials"** → OAuth client ID
   - Consent Screen: External, App-Name + E-Mail eintragen, Test-User hinzufügen
   - Application type: **Desktop app**
4. Client-ID + Secret kopieren → in `renderer.js` CONFIG-Block eintragen

### Konfiguration (`renderer.js`, CONFIG-Block oben)

```js
const CONFIG = {
  CLIENT_ID:     'DEINE_CLIENT_ID.apps.googleusercontent.com',
  CLIENT_SECRET: 'DEIN_CLIENT_SECRET',
  REDIRECT_PORT: 9876,
  REDIRECT_URI:  'http://localhost:9876/oauth',
  ...
};
```

Der Redirect-URI `http://localhost:9876/oauth` wird automatisch vom lokalen HTTP-Server
in renderer.js behandelt – kein Eintrag in Google Console nötig (Desktop App).

### OAuth Flow

1. User klickt „Mit Google anmelden"
2. renderer.js startet lokalen HTTP-Server auf Port 9876
3. `shell.openExternal()` öffnet Google Auth URL im Browser
4. Google redirectet zu `http://localhost:9876/oauth?code=...`
5. HTTP-Server tauscht Code gegen Tokens → `saveTokens()` schreibt in Datei
6. App zeigt Dashboard

### Token-Speicherort

`%APPDATA%\health-dashboard\tokens.json` (Windows)

Enthält `access_token`, `refresh_token`, `expiry_date` (als Unix-Timestamp).
Refresh passiert automatisch in `getValidToken()` wenn Token < 60s vor Ablauf.

### Google Fit Scopes

- `fitness.activity.read` – Schritte, Kalorien
- `fitness.sleep.read` – Schlafsessions
- `fitness.heart_rate.read` – Herzfrequenz
- `fitness.body.read` – Körperdaten

## Anthropic API

### Konfiguration

1. API-Key von [console.anthropic.com](https://console.anthropic.com/keys) kopieren
2. In `.env` Zeile 3 eintragen: `sk-ant-v1-...`

### .env Format

```
CLIENT_ID
CLIENT_SECRET
ANTHROPIC_API_KEY
```

### KI-Insights Feature

- Nutzt **Claude Sonnet 4.6** mit `max_tokens: 1000`
- Health-Coaching Ton
- Analysiert 7-Tage-Metriken und generiert:
  - Wochenübersicht (Aktivität, Schlaf, Vitals)
  - Bemerkenswerte Muster oder Anomalien
  - 2-3 konkrete, umsetzbare Vorschläge
- Daten werden kompakt zusammengefasst, bevor sie an die API gesendet werden (nur Statistiken, keine Rohdaten)

## Aktueller Funktionsumfang

| Feature | Status | Datenquelle |
|---|---|---|
| Schritte heute | ✅ | Fit aggregate API |
| Schritte 7 Tage (Balkendiagramm) | ✅ | Fit aggregate API |
| Kalorien heute | ✅ | Fit aggregate API |
| Schlaf letzte Nacht | ✅ | Fit sessions (activityType=72) |
| Schlaf 7 Nächte (Balkendiagramm) | ✅ | Fit sessions |
| Herzfrequenz 7 Tage (Bereichs-Balkendiagramm) | ✅ | Fit aggregate API |
| Laufaktivitäten 30 Tage (Liste) | ✅ | Fit sessions (activityType=8) |
| KI-Wocheninsights | ✅ | Claude API (Sonnet 4.6) |
| Pace / Distanz pro Lauf | ❌ | Dataset-API (`com.google.distance.delta`) |

## Design

- Dark Theme, CSS-Variablen in `index.html` (`:root`)
- Chart.js 4.x – lokal aus `node_modules/chart.js/dist/chart.umd.js` (kein CDN)
- Kein UI-Framework – reines HTML/CSS/JS
- Frameless Window (`frame: false`), Drag-Region via `-webkit-app-region: drag`
- Custom Window-Controls (Minimize / Maximize / Close) oben rechts im Titlebar

## Nächste geplante Features

- [ ] Distanz + Pace pro Lauf (Fit Dataset-API)
- [ ] Auto-Refresh alle X Minuten
- [ ] Tray-Icon für Hintergrundlauf
- [ ] Export als CSV

## Bekannte Einschränkungen

- Google Fit API wird langfristig durch Health Connect ersetzt (noch keine stabile Desktop-API)
- Rate Limits: kein automatisches Retry bei 429-Fehlern
- Schritte werden mit 7 einzelnen API-Calls abgerufen (1 pro Tag) – könnte mit einem
  7-Tage-Bucket optimiert werden
