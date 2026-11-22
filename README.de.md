<div align="center">

# WhatsApp AI Assistant

**Ohne Screenshots! Chatverläufe direkt in WhatsApp weiterleiten und sofort von der KI analysieren lassen**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![whatsapp-web.js](https://img.shields.io/badge/WhatsApp-whatsapp--web.js-25D366?logo=whatsapp&logoColor=white)](https://wwebjs.dev/)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-412991?logo=openai&logoColor=white)](https://platform.openai.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

*Designed & Authored by **[@Azumaserne](https://github.com/kaka714/whatsapp-assistant)***

<p>🌐 <a href="README.md">简体中文</a> | <a href="README.en.md">English</a> | <strong>Deutsch</strong></p>

</div>

---

> [!CAUTION]
> **Wichtiger Hinweis & Haftungsausschluss (Bitte vor der Nutzung lesen)**
>
> 1. **Eigener API-Schlüssel erforderlich (BYO API)**: Dieses Projekt stellt ausschließlich die WhatsApp-Brücke und die Analyse-Orchestrierung bereit. **Es sind keine kostenlosen Modell-Kontingente enthalten.** Sie benötigen einen eigenen API-Schlüssel (z. B. OpenAI, DeepSeek, OpenRouter, Gemini, Kimi oder ein lokales Ollama-Setup).
> 2. **Keine Haftung bei Kontosperrung**: Die Integration basiert auf der inoffiziellen Bibliothek [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js). Automatisierte Zugriffe können gegen die WhatsApp-Nutzungsbedingungen verstoßen und **zu Einschränkungen oder einer dauerhaften Kontosperrung führen**. **Nutzen Sie unbedingt ein separates Zweitkonto (Testnummer) und vermeiden Sie Massennachrichten. Der Autor übernimmt keinerlei Haftung für gesperrte Konten, Datenverlust oder API-Kosten.**

---

## 💡 Warum dieses Projekt? (Schluss mit Chat-Screenshots)

Wer ChatGPT, Claude oder DeepSeek um eine Einschätzung zu einem WhatsApp-Verlauf bitten möchte (z. B. *„Wie ist das gemeint?“*, *„Wie antworte ich höflich aber bestimmt?“*, *„Fasse die Aufgaben zusammen“*), kennt den umständlichen Standardweg:

| Vergleich | Herkömmliche KI-Nutzung per Screenshot | WhatsApp AI Assistant |
| :--- | :--- | :--- |
| **Arbeitsablauf** | 5–10 Screenshots machen → App wechseln → Bilder hochladen → auf OCR warten | **Nachrichten in WhatsApp markieren → direkt an den Assistenten weiterleiten** (oder `.txt`/`.zip` senden) |
| **Textgenauigkeit** | Screenshots leiden unter Kompression, abgeschnittenen Blasen & OCR-Fehlern | **Verarbeitet reinen Text und Zeitstempel direkt** ohne Erkennungsfehler |
| **Mehrfach-Weiterleitung** | Einzelnes Kopieren zerreißt die Reihenfolge | **Integrierter Debounce-Sammler**: N weitergeleitete Nachrichten lösen nur **1** KI-Anfrage aus |
| **Chat-übergreifend sammeln** | Ständiges Hin-und-her-Wechseln zwischen Chats | `/collect` aktivieren, aus mehreren Chats weiterleiten und einmalig mit `/analyze` auswerten |
| **Rückfragen** | App-Wechsel unterbricht den Kontext | Direkt im selben Chat nachfragen (inkl. Zitat-Antworten), um Tonfall oder Entwürfe anzupassen |

---

## ✨ Hauptfunktionen

- **📥 Bündelung mehrerer Weiterleitungen**: Beim Weiterleiten mehrerer Nachrichten sendet WhatsApp mehrere Einzelereignisse direkt hintereinander. Ein Debounce-Puffer pro Absender fügt sie zu einer geordneten Zeitleiste zusammen, bevor die KI aufgerufen wird. Folgen direkt danach noch eigene Fragen (z. B. *„Ist die Person verärgert?“*), wird **der Timer sofort abgebrochen und alles gemeinsam in einem Schritt analysiert**.
- **📦 Native Unterstützung für WhatsApp-Chatexporte (`.txt` / `.zip`)**: Bei sehr langen Verläufen einfach im jeweiligen Chat **Mehr → Chat exportieren → Ohne Medien** wählen und die `.txt`- oder `.zip`-Datei senden. Ein abhängigkeitsfreier `zlib`-Parser in reinem Node.js extrahiert `_chat.txt` automatisch und behält bei Überlänge den aktuellsten Gesprächsabschnitt.
- **🎭 5 integrierte Analyse-Modi (`/mode`)**:
  - `general` (Gesamtanalyse): Kernzusammenfassung + Stimmung/Subtext + Antwortvorschläge
  - `summary` (Kompakte Zusammenfassung): Zeitachse, Kernaussagen und To-dos
  - `emotion` (Stimmung & Subtext): Tonwechsel, versteckte Bedenken und versteckte Signale
  - `reply` (Souveräne Antworten): 3 kopierfertige Antwortentwürfe in unterschiedlichen Tonfällen
  - `translate` (Übersetzung & Nuancen): Präzise Übersetzung inkl. Erklärung von Umgangssprache und Tonfall
- **🔌 Beliebige OpenAI-kompatible APIs**: Über `LLM_BASE_URL`, `LLM_API_KEY` und `LLM_MODEL` lassen sich OpenAI, DeepSeek, OpenRouter, Gemini (OpenAI-kompatibler Endpunkt), Moonshot/Kimi, Zhipu GLM, OneAPI/NewAPI oder lokales Ollama einbinden (abwärtskompatibel zu `DEEPSEEK_API_KEY`).
- **⚠️ Automatische Erkennung & Warnung bei reinen Textmodellen**: Erkennt automatisch, ob das konfigurierte Modell multimodal ist (`LLM_MULTIMODAL=auto|true|false`). Wird ein **nicht-multimodales (reines Text-)Modell** gewählt (z. B. `deepseek-chat`, `deepseek-reasoner`, `moonshot-v1-8k`, `qwen2.5:7b`), sendet der Assistent proaktiv eine **Warnmeldung direkt in WhatsApp** sowie im Terminal. Multimodale Modelle (z. B. `gpt-4o-mini`, `gemini-2.5-flash`, `claude-3.5-sonnet`) können zudem Bilder innerhalb weitergeleiteter Chats auswerten.
- **🧠 Persistenter Verlauf & Hot-Reload-Prompt**: Der Gesprächsverlauf wird lokal in `memory.json` gespeichert (von Git ignoriert) und per `/reset` zurückgesetzt. Änderungen an `prompt.txt` greifen sofort bei der nächsten Nachricht ohne Neustart.
- **🛡️ Datenschutz- & Anti-Ban-Schutzmaßnahmen**: Optionale `ALLOWED_NUMBERS`-Whitelist (unterstützt Telefonnummern und WhatsApp-`@lid`-IDs), Beschränkung auf Direktnachrichten (Gruppen & Status-Meldungen werden ignoriert), Tipp-Anzeige mit zufälliger Verzögerung sowie Schutz vor Endlosschleifen im Selbstchat.

---

## 🚀 Schnellstart

### Option 1: Ein-Klick-PowerShell-Assistent für Windows (Empfohlen)

1. Doppelklicken Sie auf **`start.cmd`** (oder starten Sie `pwsh .\whatsapp-assistant.ps1` bzw. `.\whatsapp-assistant.ps1`).
2. Direkt im **selben Konsolenfenster** prüft das Skript Node.js & Abhängigkeiten automatisch und führt Sie durch alle erforderlichen Eingaben (API-Anbieter, Modellname, API-Schlüssel, Weiterleitungsmodus, Whitelist, Selbstchat & erkannten Browserpfad) — inklusive sofortiger Warnung bei reinen Textmodellen.
3. Direkt anschließend wird der **WhatsApp-Login-QR-Code im selben Fenster angezeigt**. Scannen Sie ihn mit Ihrem WhatsApp-Zweitkonto unter **Verknüpfte Geräte → Gerät hinzufügen**.
4. Alle erfassten Einstellungen und täglichen Chat-Analysen werden automatisch auf Ihrem Desktop unter `<Desktop>\WhatsApp-Assistant-Data\` gespeichert:
   - `config.env` — gespeicherte Laufzeitkonfiguration
   - `setup-info.txt` — übersichtliche Zusammenfassung aller Eingaben
   - `memory.json` — Gesprächsverlauf und Analyse-Modi pro Kontakt
   - `records\YYYY-MM-DD.md` — tägliche Markdown-Archive aller Analysen

> Tipp: Bei weiteren Starts genügt die Eingabetaste für den Schnellstart, oder wählen Sie `[2]`, um die Konfiguration anzupassen. Mit `Strg + C` beenden Sie das Programm sauber.

### Option 2: Manuelle CLI-Einrichtung (macOS / Linux / Server)

1. Stellen Sie sicher, dass [Node.js](https://nodejs.org/) **18.0.0 oder neuer** installiert ist, und halten Sie ein **WhatsApp-Zweitkonto** sowie Ihren eigenen **LLM-API-Schlüssel** bereit.
2. Repository klonen und Abhängigkeiten installieren:

```bash
git clone https://github.com/kaka714/whatsapp-assistant.git
cd whatsapp-assistant
npm install
```

3. `.env.example` nach `.env` kopieren und mindestens diese 3 Felder ausfüllen:

```bash
cp .env.example .env
```

```env
LLM_API_KEY=sk-ihr-echter-api-schluessel
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
```

4. Starten und QR-Code scannen:

```bash
npm start
```

Sobald der QR-Code erscheint, mit dem WhatsApp-Zweitkonto unter **Verknüpfte Geräte → Gerät hinzufügen** scannen. Nach `✅ WhatsApp AI 助手已成功上线！` ist der Assistent einsatzbereit. Die Sitzung bleibt in `.wwebjs_auth/` gespeichert.

---

## 🔌 Unterstützte API-Anbieter (BYO API)

| Anbieter | `LLM_BASE_URL` | Beispiel `LLM_MODEL` |
| :--- | :--- | :--- |
| **OpenAI** | `https://api.openai.com/v1` | `gpt-4o-mini` / `gpt-4.1-mini` |
| **DeepSeek** | `https://api.deepseek.com` | `deepseek-chat` / `deepseek-reasoner` |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` / `anthropic/claude-3.5-sonnet` |
| **Google Gemini (OpenAI-kompatibel)** | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-2.5-flash` |
| **Moonshot / Kimi** | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| **Zhipu GLM** | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| **Lokales Ollama** | `http://localhost:11434/v1` | `qwen2.5:7b` |

---

## 💬 Nutzung & WhatsApp-Befehle

### Typische Anwendungsfälle

1. **Direktes Weiterleiten (am häufigsten)**:
   - In einem beliebigen WhatsApp-Chat Nachrichten gedrückt halten, mehrere auswählen und an den Assistenten **weiterleiten**.
   - **Mit konkreter Frage**: Direkt danach eine Frage senden (z. B. *„Wie sage ich das diplomatisch ab?“*), damit beides sofort zusammen analysiert wird.
   - **Ohne weitere Eingabe**: Nach ca. 6 Sekunden (`FORWARD_DEBOUNCE_MS` in `.env`) startet die Analyse automatisch im gewählten Modus.
2. **Exportierte Chatdateien auswerten**:
   - Im Chat-Menü **Mehr → Chat exportieren → Ohne Medien** wählen und die `.txt`- oder `.zip`-Datei senden (optional mit Frage in der Dateibeschreibung).
3. **Gezielte Rückfragen**:
   - Stellen Sie direkt weitere Fragen oder nutzen Sie die WhatsApp-Funktion **Antworten (Zitieren)** auf eine bestimmte Nachricht.

### Befehlsübersicht

| Befehl | Funktion |
| :--- | :--- |
| `/help` | Zeigt Kurzanleitung, aktive Konfiguration und alle Befehle |
| `/analyze [Frage]` | Analysiert alle zwischengespeicherten Weiterleitungen sofort (optional mit Frage) |
| `/collect` | Schaltet den **manuellen Sammelmodus** ein/aus (ideal für Weiterleitungen aus mehreren Chats) |
| `/buffer` | Zeigt Anzahl und Vorschau der aktuell zwischengespeicherten Nachrichten |
| `/clear` | Leert den Weiterleitungs-Zwischenspeicher, ohne den Chatverlauf zu löschen |
| `/mode [Name]` | Zeigt oder wechselt den Analyse-Modus (`general` / `summary` / `emotion` / `reply` / `translate`) |
| `/reset` | Löscht Gesprächsverlauf sowie Zwischenspeicher und lädt `prompt.txt` neu |

---

## 📁 Projektstruktur

```text
whatsapp-assistant/
├── index.js               # Einstiegspunkt: WhatsApp-Client, Events und Nachrichten-Adapter
├── whatsapp-assistant.ps1 # Ein-Klick-PowerShell-Assistent, QR-Konsole & Desktop-Speicherung
├── start.cmd              # Windows-Doppelklick-Starter (ruft pwsh / powershell auf)
├── prompt.txt             # Standard-System-Prompt (Hot-Reload bei jeder Anfrage)
├── .env.example           # Vorlage für Umgebungsvariablen
├── LICENSE                # MIT-Lizenz
├── README.md              # Dokumentation (简体中文)
├── README.en.md           # Dokumentation (English)
├── README.de.md           # Dokumentation (Deutsch)
├── src/
│   ├── config.js          # Env-Konfiguration, Multimodal-Erkennung & Whitelist-Prüfung
│   ├── chatExport.js      # Reiner Node-zlib-Parser für .txt- / .zip-Chatexporte
│   ├── forwardBuffer.js   # Debounce-Sammler pro Absender & /collect-Zustandsverwaltung
│   ├── prompts.js         # Prompt-Builder, Warnungen bei reinen Textmodellen & Modi
│   ├── memory.js          # Lokale memory.json-Persistenz & Migration alter Formate
│   ├── llm.js             # OpenAI-kompatibler Client, Nachrichten-Aufteilung & Fehlertexte
│   ├── recorder.js        # Tägliche Markdown-Analysearchive im Desktop-Ordner
│   └── handler.js         # Nachrichten-Router, serielle Warteschlange & Selbstchat-Schutz
└── test/
    └── assistant.test.js  # Integrierte Node-Testsuite (Bündelung, ZIP-Parser, Befehle, Filter)
```

---

## 🧪 Tests & Überprüfung

Das Projekt enthält Offline-Unit-Tests auf Basis des nativen `node:test`-Runners (ohne Browser oder aktive WhatsApp-Sitzung):

```bash
npm run check   # Syntaxprüfung aller Quelldateien
npm test        # Automatisierte Unit-Tests ausführen
```

---

## 📄 Lizenz

Veröffentlicht unter der **[MIT-Lizenz](LICENSE)** — Copyright © 2026 **[Azumaserne](https://github.com/kaka714/whatsapp-assistant)**.
