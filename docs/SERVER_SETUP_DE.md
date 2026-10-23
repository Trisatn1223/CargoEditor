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
    reverse_proxy cargo-editor:8080
}
```

Caddy mit dem zur vorhandenen Installation passenden `docker exec … caddy validate` und `docker exec … caddy reload` neu laden. Konfigurationspfad und Containername hängen von deiner vorhandenen API-Installation ab und sind hier bewusst nicht geraten.

## 4. Erforderlich: API-CORS freigeben

Am 23.10.2026 lieferte `GET /editor/presets` echte Presets. Die OPTIONS-Vorabfrage von der neuen Editor-Domain wurde jedoch mit HTTP 400 abgelehnt.

In der **vorhandenen API** muss dieser erlaubte Origin ergänzt werden:

```text
https://cargo-editor.dreamislandstudio.de
```

Der konkrete Name der Umgebungsvariable ist aus der Übergabe nicht bekannt. Nicht einfach eine erfundene `CORS_ORIGINS`-Variable eintragen: im API-Quellcode bzw. in deren Compose-Konfiguration nachsehen. Wenn FastAPI direkt konfiguriert wird, entspricht die erforderliche Einstellung sinngemäß:

```python
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        # vorhandene erlaubte Origins behalten
        "https://cargo-editor.dreamislandstudio.de",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Authorization", "Content-Type", "Accept"],
)
```

Das ist ein Integrationsbeispiel, keine vollständige Ersatzkonfiguration. Die API darf weitere schon benötigte Methoden/Origins behalten. CORS nur an einer Stelle konsistent setzen; doppelte widersprüchliche Header vermeiden. Für Browser-Tests auf dem eigenen Rechner zusätzlich `http://localhost:8080` erlauben, wenn gewünscht.

Nach dem Neustart der API testen:

```bash
curl -i -X OPTIONS 'https://cargo-api.dreamislandstudio.de/levels' \
  -H 'Origin: https://cargo-editor.dreamislandstudio.de' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type'
```

Erwartet: erfolgreicher Status und `Access-Control-Allow-Origin: https://cargo-editor.dreamislandstudio.de`. In der Webseite sollte anschließend **API connected** erscheinen.

**Keinen Editor-/Service-Token in HTML, JavaScript, Nginx, Git oder Docker eintragen.** Die Webseite verwendet `/auth/anonymous` für einen individuellen Spieler-Token.

## 5. Automatisch den neuesten Main-Stand bereitstellen

Der Timer prüft ungefähr alle zwei Minuten `main`. Er baut nur bei einem neuen Commit, führt die Tests aus, prüft einen Probecontainer und ersetzt erst dann die laufende Version. Tests und Builds sind Wartungsarbeit beim Update; die Levelberechnungen laufen weiterhin ausschließlich im Browser.

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
2. **Check level**: Der große Dialog zeigt die lokale Suche. Der Balken ist bewusst unbestimmt, da der gesamte Suchraum vorher unbekannt ist. Abbruch ist möglich.
3. Nach Erfolg **Publish level** drücken.
4. Die API liefert den Code. Er erscheint im Dialog und oben rechts.
5. **Copy to clipboard** kopiert ihn. **New level** löscht den lokalen Entwurf vollständig.
6. **Open level code** lädt eine Kopie. Beim erneuten Speichern entsteht ein neuer Code.

Die Übergabe beschreibt eine noch fehlende serverseitige Replay-Freigabe. Dieser Editor behauptet daher nur dann „Published“, wenn die API ausdrücklich `published: true` zurückliefert. Andernfalls zeigt er „Saved · awaiting API approval“. Der gespeicherte Code bleibt sichtbar; andere Spieler können den Code möglicherweise erst nach der API-Freigabe laden.

Für sofort sichtbare Community-Level muss die API eine entsprechende Veröffentlichungsregel anbieten. Diese Änderung kann **nicht** allein im statischen Editor erfolgen. Der Backend-Quellcode wurde nicht mitgeliefert. Der Editor schickt keine geheimen Service-Anfragen und täuscht keine Freigabe vor.

Ein Suchlimit bedeutet „nicht abschließend geprüft“, nicht „unlösbar“. Die lokale Zugzahl bezieht sich auf das dokumentierte Regelnmodell, siehe [GODOT_RULES.md](GODOT_RULES.md). Dort stehen auch konkrete Abweichungen/Bugs des hochgeladenen Godot-Codes, besonders bei Lebensmittel-Effekten und dem letzten Schiffswechsel.

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
