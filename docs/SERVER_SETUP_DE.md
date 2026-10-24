# Cargo Editor auf dem STRATO-Server einrichten

Ziel: **https://cargo-editor.dreamislandstudio.de**

Git: **https://github.com/Trisatn1223/CargoEditor**

Der Editor-Docker liefert ausschließlich HTML, CSS, JavaScript und JSON-Dateien aus. Zugberechnung, Lösbarkeitssuche und das Nachspielen der gefundenen Lösung laufen auf dem Gerät des Besuchers. Die vorhandene Cargo-API übernimmt weiterhin Anmeldung, Presets, Speichern und Levelcodes.

## 1. Voraussetzungen und DNS

Benötigt werden ein Linux-Server mit Docker Engine, Docker Compose Plugin, Git und systemd. Ubuntu/Debian sind für diese Anleitung angenommen. Bei einem anderen System die Installationsschritte anpassen.

Docker nur installieren, falls es noch fehlt. Offizielle Anleitungen:

- https://docs.docker.com/engine/install/ubuntu/
- https://docs.docker.com/engine/install/debian/
- https://docs.docker.com/compose/install/linux/

Prüfen:

```bash
docker --version
docker compose version
git --version
```

Beim DNS-Anbieter einen **A-Eintrag** für `cargo-editor.dreamislandstudio.de` auf die öffentliche IPv4-Adresse deines Servers setzen. Einen AAAA-Eintrag nur anlegen, wenn IPv6 auf diesem Server korrekt funktioniert. Ein DNS-Eintrag enthält keine Portnummer.

Die vorhandene API antwortet bereits über Caddy. Deshalb **keinen zweiten Webserver auf Port 80/443 starten** und die vorhandene API-Konfiguration nicht ersetzen. Der Editor wird auf `127.0.0.1:8090` bereitgestellt.

## 2. Repository klonen und Container starten

Die folgenden Befehle sind für eine Root-Sitzung auf dem Server. Das Verzeichnis `/opt/cargo-editor` sollte noch nicht existieren. Falls es schon eine Installation enthält, erst deren Inhalt prüfen.

```bash
git clone https://github.com/Trisatn1223/CargoEditor.git /opt/cargo-editor
cd /opt/cargo-editor
docker compose up -d --build
curl --fail http://127.0.0.1:8090/healthz
```

Die letzte Zeile muss `ok` anzeigen. Der Build führt die automatisierten Regel- und API-Vertragstests aus. Node wird nur in der Build-Stufe verwendet; im laufenden Container gibt es nur Nginx und die statischen Dateien.

## 3. Domain mit dem vorhandenen Caddy verbinden

### Variante A: Caddy läuft direkt auf dem Host

Zur **bestehenden** `/etc/caddy/Caddyfile` diesen zusätzlichen Block hinzufügen:

```caddyfile
cargo-editor.dreamislandstudio.de {
    encode zstd gzip
    reverse_proxy 127.0.0.1:8090
}
```

Anschließend:

```bash
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

Caddy übernimmt die HTTPS-Zertifikate, wenn DNS und die öffentliche Erreichbarkeit über Port 80/443 stimmen. Die bestehenden Domainblöcke bleiben bestehen.

### Variante B: Caddy läuft bereits in Docker

In einem Caddy-Container ist `127.0.0.1` der Caddy-Container selbst. Deshalb beide Container in dasselbe vorhandene Docker-Netzwerk aufnehmen.

```bash
docker network ls
docker ps
```

Den tatsächlichen Netzwerknamen des Caddy-Containers ermitteln, z. B. mit `docker inspect NAME_DES_CADDY_CONTAINERS`. Ersetze `DEIN_PROXY_NETZ` im folgenden Befehl:

```bash
cd /opt/cargo-editor
PROXY_NETWORK=DEIN_PROXY_NETZ docker compose -f compose.yaml -f deploy/compose.proxy.yaml up -d --build
```

Diesen Block in die **bereits verwendete** Caddy-Konfiguration aufnehmen:

```caddyfile
cargo-editor.dreamislandstudio.de {
    encode zstd gzip

    handle_path /api/* {
        reverse_proxy api:8000
    }

    handle {
        reverse_proxy cargo-editor:8080
    }
}
```

Caddy mit dem zur vorhandenen Installation passenden `docker exec … caddy validate` und `docker exec … caddy reload` neu laden. Konfigurationspfad und Containername hängen von deiner vorhandenen API-Installation ab und sind hier bewusst nicht geraten.

## 4. API ohne CORS-Fehler (Same-Origin-Proxy)

Der produktive Editor sendet API-Aufrufe an `https://cargo-editor.dreamislandstudio.de/api/...`. Caddy entfernt den Prefix `/api` und leitet an den **bereits laufenden** API-Container `api:8000` weiter. Im Browser sind damit HTML und API dieselbe Origin; zusätzliche CORS-Freigaben sind für diese Domain nicht erforderlich.

Im bestehenden `/opt/container-game/ops/Caddyfile` **nur den Cargo-Editor-Block** wie in Schritt 3 ändern. Der bestehende `{$API_DOMAIN}`-Block muss unverändert bleiben:

```caddyfile
{$API_DOMAIN} {
    # Existing API config remains unchanged.
    reverse_proxy api:8000
}

cargo-editor.dreamislandstudio.de {
    encode zstd gzip
    handle_path /api/* {
        reverse_proxy api:8000
    }
    handle {
        reverse_proxy cargo-editor:8080
    }
}
```

Dabei ist der API-Block nur ein **schematisches Beispiel** – keinen bereits konfigurierten Header, Limits oder Sicherheitsregeln entfernen.

Caddy neu laden:

```bash
cd /opt/container-game
docker compose exec -T caddy caddy validate --config /etc/caddy/Caddyfile
docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile
```

Testen:

```bash
curl -fsS https://cargo-editor.dreamislandstudio.de/healthz
curl -fsS https://cargo-editor.dreamislandstudio.de/api/editor/presets
```

Der zweite Aufruf muss JSON mit Schiffen und Containern liefern. Bei HTTP 404 oder HTML wurde der neue `handle_path /api/*`-Block noch nicht in der laufenden Caddy-Konfiguration übernommen. Bei HTTP 502 das gemeinsame Docker-Netzwerk und den Namen `api` prüfen.

Der Editor benutzt nur anonyme Spieler-Authentifizierung (`/api/auth/anonymous`); niemals einen Studio-/Service-Token in Browser-Dateien hinterlegen. Lokal (localhost) läuft die Entwicklung weiterhin über die öffentliche API-Origin und benötigt dort ggf. CORS.

## 5. Automatisch den neuesten Main-Stand bereitstellen

Der Timer prüft ungefähr alle 30 Minuten `main`. Er baut nur bei einem neuen Commit, führt die Tests aus, prüft einen Probecontainer und ersetzt erst dann die laufende Version. Tests und Builds sind Wartungsarbeit beim Update; die Levelberechnungen laufen weiterhin ausschließlich im Browser.

```bash
cd /opt/cargo-editor
install -m 755 deploy/update.sh /usr/local/sbin/cargo-editor-update
install -m 644 deploy/cargo-editor-update.service /etc/systemd/system/cargo-editor-update.service
install -m 644 deploy/cargo-editor-update.timer /etc/systemd/system/cargo-editor-update.timer
install -m 600 deploy/update.env.example /etc/cargo-editor-update.env
```

Nur bei **Caddy in Docker**: `/etc/cargo-editor-update.env` bearbeiten und setzen:

```bash
COMPOSE_FILES="compose.yaml deploy/compose.proxy.yaml"
PROXY_NETWORK="DEIN_PROXY_NETZ"
```

Bei Caddy auf dem Host bleibt `COMPOSE_FILES="compose.yaml"`.

```bash
systemctl daemon-reload
systemctl start cargo-editor-update.service
systemctl enable --now cargo-editor-update.timer
systemctl list-timers cargo-editor-update.timer
journalctl -u cargo-editor-update.service -n 60 --no-pager
```

Aktuellen Stand prüfen:

```bash
curl --fail https://cargo-editor.dreamislandstudio.de/version.json
```

Die Antwort enthält den Git-Commit. Ein Update ist nicht auf die Sekunde sofort: Timerintervall plus Buildzeit. Bereits geöffnete Browser-Tabs einmal neu laden; es gibt keinen Service-Worker mit veralteten Dateien.

Manuell sofort nach Updates suchen:

```bash
systemctl start cargo-editor-update.service
```

Denselben Commit mit aktuellen Basisimages erneut bauen:

```bash
/usr/local/sbin/cargo-editor-update --force
```

Der Updater ist absichtlich als fest installierte Datei außerhalb des Git-Repositories hinterlegt. Änderungen am Updater selbst nach Prüfung erneut mit `install` übernehmen. Produktänderungen in `public/` werden automatisch aktualisiert. Keine eigenen Änderungen an den getrackten Dateien auf dem Server vornehmen; sonst stoppt der Updater, statt sie zu überschreiben. Git-Zugriff auf `main` entsprechend nur vertrauenswürdigen Personen geben.

## 6. Levelcodes und Veröffentlichung

1. Schiff, Startladung, Zielmengen, erlaubte Positionen, Depot und Zugfolge bearbeiten.
2. **Check level**: Der große Dialog zeigt die lokale Suche. Der Balken zeigt den genutzten Suchbudget-Anteil (bis zu 2.000.000 Zustände), **nicht** den tatsächlichen Lösungsfortschritt. Die Suche betrachtet bis zu zehn unterschiedliche optimale Lösungswege und bevorzugt unter gleich kurzen Routen weniger unnötige Umlagerungen. Bei HTTP 422 zeigt die Editor-Meldung den konkreten Validierungsfehler der API. Abbruch ist möglich.
3. Nach Erfolg **Publish level** drücken.
4. Die API liefert den Code. Er erscheint im Dialog und oben rechts.
5. **Copy to clipboard** kopiert ihn. **New level** löscht den lokalen Entwurf vollständig.
6. **Open level code** lädt eine Kopie. Beim erneuten Speichern entsteht ein neuer Code.

Die Übergabe beschreibt eine noch fehlende serverseitige Replay-Freigabe. Dieser Editor behauptet daher nur dann „Published“, wenn die API ausdrücklich `published: true` zurückliefert. Andernfalls zeigt er „Saved · awaiting API approval“. Der gespeicherte Code bleibt sichtbar; andere Spieler können den Code möglicherweise erst nach der API-Freigabe laden.

Für sofort sichtbare Community-Level muss die API eine entsprechende Veröffentlichungsregel anbieten. Diese Änderung kann **nicht** allein im statischen Editor erfolgen. Der Backend-Quellcode wurde nicht mitgeliefert. Der Editor schickt keine geheimen Service-Anfragen und täuscht keine Freigabe vor.

Ein Suchlimit bedeutet „nicht abschließend geprüft“, nicht „unlösbar“. Die Editor-Prüfung nutzt wie der übergebene Godot-Easy-Code die **Y-Achse** und den im Spiel verwendeten X-Varianz-Grenzwert. Andere dokumentierte Laufzeit-Unterschiede müssen vor einer Freigabe im Godot-Spiel abgeglichen werden. Siehe [GODOT_RULES.md](GODOT_RULES.md). Dort stehen auch konkrete Abweichungen/Bugs des hochgeladenen Godot-Codes, besonders bei Lebensmittel-Effekten und dem letzten Schiffswechsel.

### HTTP 422: Schiff 7.max_x_variance wird abgelehnt

Der Browser-Editor schickt ab Commit `c42f961e3cdd7919957d6f11173fafa5b2523416`
den numerischen Wert `max_x_variance` zusammen mit `max_y_variance`,
`center_offset` und `scene_path` aus dem zugelassenen Live-Preset.

**Zuerst die ausgelieferte Version prüfen:**

```bash
curl -fsS https://cargo-editor.dreamislandstudio.de/version.json
cat /var/lib/cargo-editor/current
git -C /opt/cargo-editor rev-parse HEAD
```

Die drei Commits sollten gleich sein. Falls nicht, das Systemd-Updateprotokoll
prüfen: `journalctl -u cargo-editor-update.service -n 100 --no-pager`.

**Live-Preset der API sicher ausgeben (kein Passwort/Token erforderlich):**

```bash
curl -fsS https://cargo-editor.dreamislandstudio.de/api/editor/presets \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(*[{"id":s.get("id"),"scene_path":s.get("scene_path"),"max_x_variance":s.get("max_x_variance"),"variance_type":type(s.get("max_x_variance")).__name__} for s in d.get("ships",[]) if s.get("id")==7],sep="\\n")'
```

Nach dem Browser-Update hängt der Editor bei einer solchen 422-Meldung die
**tatsächlich gesendeten** öffentlichen Preset-ID-/Varianzzahlen an. Wenn
`preset 7: 3 (number)` gesendet wurde, aber die API weiterhin
`Schiff 7.max_x_variance` ablehnt, liegt der Fehler vermutlich beim
serverseitigen Preset-Lookup, Snapshot-Aufbau oder der Validator-Eingabe –
nicht bei der lokalen A*-Suche. Dafür sind Backend-Code bzw. API-Logs nötig.
Nicht durch das Setzen eines Dummy-Werts oder das Abschalten der
API-Validierung umgehen. Keine Bearer-Tokens im Terminal oder Chat ausgeben.

```bash
cd /opt/container-game
docker compose logs --since 15m --tail 200 api
```

Wenn die Live-Preset-Antwort `max_x_variance` nicht als endliche Zahl im
Bereich 0..100000 enthält, zuerst die autoritative Preset-Datenbank bzw.
die API-Serialisierung korrigieren und anschließend die Presets erneut laden.

## 7. Fehler und Rückkehr zur vorherigen Version

| Beobachtung | Prüfung |
| --- | --- |
| Webseite nicht erreichbar | DNS, Caddy-Block, Ports 80/443, `docker compose ps` |
| 502 von Caddy | Host-/Docker-Caddy-Variante prüfen; gemeinsames Netzwerk oder Port 8090 |
| Offline presets | API-CORS und Erreichbarkeit; Entwerfen und lokale Prüfung funktionieren trotzdem |
| Code gespeichert, aber nicht öffentlich | API-Freigabe prüfen; Editor kann sie nicht erzwingen |
| „No solution“ | Zielmengen, erlaubte Positionen, Kühlung, Startlast, Zugfolge ändern |
| „Not fully checked“ | Suchbudget ausgeschöpft; Level vereinfachen |
| Updates stoppen | `journalctl -u cargo-editor-update.service`, lokale Git-Änderungen, fehlgeschlagene Tests |
| Nach langer Zeit viel Docker-Speicher | Alte Images gezielt prüfen und entfernen; aktuellen/vorherigen Stand behalten |

Automatik anhalten:

```bash
systemctl disable --now cargo-editor-update.timer
```

Vorherigen Commit lesen:

```bash
cat /var/lib/cargo-editor/previous
```

Mit dieser SHA das vorhandene Image `cargo-editor:SHA` manuell über Compose starten. Beispiel für Host-Caddy, `SHA` durch den vollständigen Wert ersetzen:

```bash
cd /opt/cargo-editor
CARGO_EDITOR_IMAGE=cargo-editor:SHA docker compose up -d --no-build --wait
```

Bei Docker-Caddy dieselben zusätzlichen `-f`-Optionen und `PROXY_NETWORK` wie oben verwenden. Solange der Timer deaktiviert ist, wird diese Version nicht automatisch ersetzt. Ein fehlerhafter Commit sollte anschließend über einen neuen Git-Commit korrigiert oder zurückgenommen werden, bevor die Automatik wieder aktiviert wird.

## Referenzen

- Docker Engine: https://docs.docker.com/engine/install/ubuntu/
- Docker Compose: https://docs.docker.com/compose/install/linux/
- Caddy Reverse Proxy: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- Caddy HTTPS: https://caddyserver.com/docs/automatic-https
