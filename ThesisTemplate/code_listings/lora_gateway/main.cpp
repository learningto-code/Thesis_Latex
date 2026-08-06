#include <Arduino.h>
#include <SPI.h>
#include <LoRa.h>
#include <WiFi.h>
#include <esp_wifi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <esp_log.h>
#include <vector>

// Fixed configuration
#define BACKEND_URL      "https://thesis-ug1z.onrender.com"
#define DEVICE_API_KEY   "fleet-device-key-2024"
#define AP_SSID          "FleetGateway"   // AP name shown on phone WiFi scan
#define AP_PASS          ""
#define WIFI_CONNECT_TIMEOUT_MS  15000    // 15s to connect before giving up
#define WIFI_MAX_ATTEMPTS        3        // failed attempts before re-entering portal

// LoRa settings -- MUST match truck device exactly
#define LORA_FREQUENCY  433000000UL
#define LORA_SF         7             // Spreading Factor 7
#define LORA_BW         125000        // Bandwidth 125 kHz
#define LORA_SYNC_WORD  0x12          // Private network sync word

#define LORA_NSS_PIN    5
#define LORA_RST_PIN    14
#define LORA_DIO0_PIN   2

// Retry config for backend HTTP forward
#define HTTP_RETRIES    3
#define HTTP_TIMEOUT_MS 10000

// Bidirectional LoRa configuration
#define DOWNLINK_ACK_TIMEOUT_MS   2000   // wait 2s for HMI to ACK a downlink
#define DOWNLINK_MAX_RETRIES      2      // total LoRa transmits per pending action
#define DOWNLINK_INFO_RETRY_MS    15000  // retry informational downlinks until ACKed
#define POLL_ACTIONS_INTERVAL_MS  5000   // 5s -- fast cadence for rest/resume/end_trip/snooze
#define POLL_ALERTS_INTERVAL_MS   15000  // 15s -- slower cadence for nav/threshold/maintenance/zones
#define ACTIVE_TRIP_TIMEOUT_MS    300000 // 5 min of no uplink -> trip pruned from active list

// State
Preferences  prefs;
WebServer    server(80);
DNSServer    dns;
bool         wifiConnected  = false;
bool         portalActive   = false;
uint32_t     pktsReceived   = 0;
uint32_t     pktsForwarded  = 0;
uint32_t     pktsFailed     = 0;
uint32_t     downlinksSent  = 0;
uint32_t     downlinksAcked = 0;
uint32_t     downlinksFailed= 0;

// Mutex protects activeTrips + pendingDownlinks (read/written by both cores).
SemaphoreHandle_t gwMutex = nullptr;

// Active trip tracking -- populated from uplinks, pruned on timeout
struct ActiveTrip {
  String        trip_id;
  String        truck_code;
  unsigned long last_uplink_ms;
  unsigned long last_action_poll_ms;
  unsigned long last_alert_poll_ms;
  // Last-seen state for diff'ing -- only push downlinks when these change.
  String        last_nav_signature;     // hash-like concat of step instruction + dist + type
  uint32_t      last_rest_threshold_ms;
  bool          has_companion_state;
  bool          last_mobile_companion_active;
};
std::vector<ActiveTrip> activeTrips;

// Pending downlinks -- outstanding LoRa sends awaiting HMI ACK
struct PendingDownlink {
  String        action_id;
  String        trip_id;
  String        truck_code;
  String        cmd;
  String        data_json;
  String        eid;           // LoRa event_id for ACK matching
  uint8_t       retries;
  unsigned long last_send_ms;
  bool          backend_tracked;
};
std::vector<PendingDownlink> pendingDownlinks;

// HTML PAGES
static const char PAGE_CONFIG[] PROGMEM = R"html(
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Fleet Gateway -- WiFi Setup</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:system-ui,sans-serif;background:#0d1f3c;color:#f0f0f0;
         display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}
    .card{background:#112240;border:1px solid #1e3a5f;border-radius:16px;
          padding:32px 28px;width:100%;max-width:380px}
    h2{color:#82B7DC;font-size:20px;margin-bottom:6px}
    p{font-size:13px;color:#9EB0C0;margin-bottom:24px;line-height:1.5}
    label{display:block;font-size:12px;color:#7ba3c8;margin-bottom:4px;margin-top:16px}
    input,select{width:100%;padding:11px 14px;border-radius:9px;border:1px solid #2a4a72;
          background:#0d1f3c;color:#f0f0f0;font-size:15px;outline:none}
    input:focus,select:focus{border-color:#346AA8}
    .scan-row{display:flex;gap:8px;align-items:center;margin-top:8px}
    .scan-row select{flex:1;min-width:0}
    button.scan{width:96px;padding:11px 10px;border-radius:9px;border:1px solid #346AA8;
          background:#17345b;color:#dceeff;font-size:13px;font-weight:700;cursor:pointer}
    button.scan:disabled{opacity:.65;cursor:wait}
    .hint{margin-top:7px;font-size:11px;color:#6686a8;line-height:1.4}
    .show-row{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px;color:#7ba3c8}
    button[type=submit]{margin-top:28px;width:100%;padding:14px;border-radius:10px;
          border:none;background:#346AA8;color:#fff;font-size:15px;font-weight:700;
          cursor:pointer;letter-spacing:.5px}
    button[type=submit]:active{background:#255080}
    .note{margin-top:14px;font-size:11px;color:#4a6a8a;text-align:center}
    .saved{background:#0a2a1a;border:1px solid #1a5a2a;border-radius:10px;
           padding:12px 16px;margin-bottom:20px;font-size:13px;color:#4cd98a}
  </style>
</head>
<body>
<div class="card">
  <h2>Fleet Gateway Setup</h2>
  <p>Enter your WiFi credentials. The gateway will save them to flash and reconnect automatically on every boot.</p>
  %SAVED_BADGE%
  <form action="/save" method="POST">
    <label>Nearby WiFi</label>
    <div class="scan-row">
      <select id="networks" onchange="selectNetwork(this.value)">
        <option value="">Tap Scan</option>
      </select>
      <button class="scan" type="button" id="scanBtn" onclick="scanNetworks()">Scan</button>
    </div>
    <div class="hint" id="scanHint">Choose your 2.4 GHz WiFi, or type the name manually below.</div>
    <label>WiFi Name (SSID)</label>
    <input type="text" name="ssid" id="ssid" value="%CURRENT_SSID%" placeholder="Your network name" required autocomplete="off" spellcheck="false">
    <label>WiFi Password</label>
    <input type="password" name="pass" id="pw" placeholder="Leave blank if open network" autocomplete="off">
    <div class="show-row">
      <input type="checkbox" id="show" onchange="document.getElementById('pw').type=this.checked?'text':'password'" style="width:auto;padding:0">
      <span>Show password</span>
    </div>
    <button type="submit">Save &amp; Connect</button>
  </form>
  <p class="note">After saving, the gateway restarts and connects to your network.<br>This page is available at http://&lt;gateway-ip&gt;/config anytime.</p>
</div>
<script>
const networks = document.getElementById('networks');
const scanBtn = document.getElementById('scanBtn');
const scanHint = document.getElementById('scanHint');
const ssidInput = document.getElementById('ssid');

function selectNetwork(ssid) {
  if (ssid) ssidInput.value = ssid;
}

function optionLabel(net) {
  const lock = net.secure ? ' locked' : ' open';
  return `${net.ssid} (${net.rssi} dBm, ch ${net.channel},${lock})`;
}

async function scanNetworks() {
  scanBtn.disabled = true;
  scanBtn.textContent = 'Scanning';
  scanHint.textContent = 'Scanning nearby 2.4 GHz networks...';
  networks.innerHTML = '<option value="">Scanning...</option>';

  try {
    const res = await fetch('/scan', { cache: 'no-store' });
    const data = await res.json();
    networks.innerHTML = '';

    if (!data.networks || data.networks.length === 0) {
      networks.innerHTML = '<option value="">No networks found</option>';
      scanHint.textContent = 'Move the gateway closer to the router, then scan again.';
      return;
    }

    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Select WiFi network';
    networks.appendChild(placeholder);

    data.networks.forEach(net => {
      if (!net.ssid) return;
      const opt = document.createElement('option');
      opt.value = net.ssid;
      opt.textContent = optionLabel(net);
      networks.appendChild(opt);
    });

    scanHint.textContent = `${data.networks.length} network(s) found. ESP32 can connect only to 2.4 GHz WiFi.`;
  } catch (err) {
    networks.innerHTML = '<option value="">Scan failed</option>';
    scanHint.textContent = 'Scan failed. Stay connected to FleetGateway and try again.';
  } finally {
    scanBtn.disabled = false;
    scanBtn.textContent = 'Scan';
  }
}

</script>
</body>
</html>
)html";

static const char PAGE_SAVED[] PROGMEM = R"html(
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="4">
  <title>Saved -- Fleet Gateway</title>
  <style>
    body{font-family:system-ui,sans-serif;background:#0d1f3c;color:#f0f0f0;
         display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}
    .card{background:#112240;border:1px solid #1e3a5f;border-radius:16px;
          padding:40px 28px;width:100%;max-width:360px;text-align:center}
    .icon{font-size:48px;margin-bottom:16px}
    h2{color:#4cd98a;margin-bottom:8px}
    p{font-size:13px;color:#9EB0C0;line-height:1.6}
  </style>
</head>
<body>
<div class="card">
  <div class="icon">&#10003;</div>
  <h2>Credentials Saved</h2>
  <p>The gateway is restarting and will connect to your WiFi network.<br><br>
     This page will refresh automatically.</p>
</div>
</body>
</html>
)html";

static const char PAGE_STATUS[] PROGMEM = R"html(
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="10">
  <title>Gateway Status</title>
  <style>
    body{font-family:system-ui,sans-serif;background:#0d1f3c;color:#f0f0f0;
         display:flex;align-items:center;justify-content:center;min-height:100vh;padding:16px}
    .card{background:#112240;border:1px solid #1e3a5f;border-radius:16px;
          padding:32px 28px;width:100%;max-width:380px}
    h2{color:#82B7DC;font-size:20px;margin-bottom:20px}
    .row{display:flex;justify-content:space-between;padding:10px 0;
         border-bottom:1px solid #1e3a5f;font-size:14px}
    .row:last-child{border-bottom:none}
    .label{color:#7ba3c8}
    .val{font-weight:600;color:#f0f0f0}
    .green{color:#4cd98a}.red{color:#ff6b6b}.amber{color:#FFB020}
    a{display:block;margin-top:20px;text-align:center;color:#82B7DC;font-size:13px}
  </style>
</head>
<body>
<div class="card">
  <h2>Gateway Status</h2>
  <div class="row"><span class="label">WiFi</span><span class="val %WIFI_CLASS%">%WIFI_STATUS%</span></div>
  <div class="row"><span class="label">IP Address</span><span class="val">%IP%</span></div>
  <div class="row"><span class="label">Network</span><span class="val">%SSID%</span></div>
  <div class="row"><span class="label">Packets received</span><span class="val">%PKTS_RX%</span></div>
  <div class="row"><span class="label">Forwarded to backend</span><span class="val green">%PKTS_FWD%</span></div>
  <div class="row"><span class="label">Failed forwards</span><span class="val %FAIL_CLASS%">%PKTS_FAIL%</span></div>
  <div class="row"><span class="label">LoRa</span><span class="val green">433.0 MHz / SF7 / BW125</span></div>
  <a href="/config">Change WiFi credentials</a>
</div>
</body>
</html>
)html";

// WEB SERVER HANDLERS
String htmlEscape(const String& value) {
  String out = value;
  out.replace("&", "&amp;");
  out.replace("\"", "&quot;");
  out.replace("'", "&#39;");
  out.replace("<", "&lt;");
  out.replace(">", "&gt;");
  return out;
}

bool jsonHas(JsonDocument& doc, const char* key) {
  return !doc[key].isNull();
}

void configureWiFiRadio() {
  WiFi.setSleep(false);
  esp_wifi_set_ps(WIFI_PS_NONE);

  // Philippines 2.4 GHz WiFi commonly uses channels 1-13.
  wifi_country_t country = { "PH", 1, 13, WIFI_COUNTRY_POLICY_MANUAL };
  esp_wifi_set_country(&country);
}

void handleConfig() {
  prefs.begin("wifi", true);
  String savedSsid = prefs.getString("ssid", "");
  prefs.end();

  String page = String(PAGE_CONFIG);
  if (savedSsid.length() > 0 && wifiConnected) {
    page.replace("%SAVED_BADGE%",
      "<div class='saved'>Currently connected to: <strong>" + htmlEscape(savedSsid) + "</strong></div>");
  } else {
    page.replace("%SAVED_BADGE%", "");
  }
  page.replace("%CURRENT_SSID%", htmlEscape(savedSsid));
  server.send(200, "text/html", page);
}

void handleScan() {
  Serial.println("[WiFi] Scanning nearby networks...");

  WiFi.mode(WIFI_AP_STA);
  configureWiFiRadio();
  WiFi.disconnect(true, false);
  delay(300);
  WiFi.scanDelete();
  int count = WiFi.scanNetworks(false, true, false, 300);

  JsonDocument doc;
  JsonArray networks = doc["networks"].to<JsonArray>();

  if (count < 0) {
    doc["error"] = count;
    String body;
    serializeJson(doc, body);
    server.sendHeader("Cache-Control", "no-store");
    server.send(200, "application/json", body);
    Serial.printf("[WiFi] Scan failed - code %d\n", count);
    return;
  }

  for (int i = 0; i < count; i++) {
    String ssid = WiFi.SSID(i);
    if (ssid.length() == 0) continue;

    JsonObject net = networks.add<JsonObject>();
    net["ssid"] = ssid;
    net["rssi"] = WiFi.RSSI(i);
    net["channel"] = WiFi.channel(i);
    net["secure"] = WiFi.encryptionType(i) != WIFI_AUTH_OPEN;
  }

  String body;
  serializeJson(doc, body);
  WiFi.scanDelete();

  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", body);
  Serial.printf("[WiFi] Scan complete - raw %d, listed %d network(s)\n", count, networks.size());
}

void handleSave() {
  if (!server.hasArg("ssid") || server.arg("ssid").length() == 0) {
    server.send(400, "text/plain", "SSID required");
    return;
  }
  String newSsid = server.arg("ssid");
  String newPass = server.arg("pass");

  prefs.begin("wifi", false);
  prefs.putString("ssid", newSsid);
  prefs.putString("pass", newPass);
  prefs.end();

  Serial.printf("[WiFi] Credentials saved -- SSID: %s\n", newSsid.c_str());
  server.send(200, "text/html", String(PAGE_SAVED));
  delay(2000);
  ESP.restart();
}

void handleStatus() {
  String page = String(PAGE_STATUS);
  if (wifiConnected) {
    page.replace("%WIFI_CLASS%",  "green");
    page.replace("%WIFI_STATUS%", "Connected");
    page.replace("%IP%",   WiFi.localIP().toString());
    page.replace("%SSID%", WiFi.SSID());
  } else {
    page.replace("%WIFI_CLASS%",  "red");
    page.replace("%WIFI_STATUS%", "Offline");
    page.replace("%IP%",   "--");
    page.replace("%SSID%", "--");
  }
  page.replace("%PKTS_RX%",   String(pktsReceived));
  page.replace("%PKTS_FWD%",  String(pktsForwarded));
  page.replace("%PKTS_FAIL%", String(pktsFailed));
  page.replace("%FAIL_CLASS%", pktsFailed > 0 ? "amber" : "val");
  server.send(200, "text/html", page);
}

void handleCaptiveRedirect() {
  server.sendHeader("Location", "http://192.168.4.1/config");
  server.send(302, "text/plain", "");
}

void registerRoutes() {
  server.on("/config",  HTTP_GET,  handleConfig);
  server.on("/scan",    HTTP_GET,  handleScan);
  server.on("/save",    HTTP_POST, handleSave);
  server.on("/status",  HTTP_GET,  handleStatus);
  server.onNotFound(handleCaptiveRedirect);
}

void startSetupAccessPoint() {
  if (portalActive) return;

  portalActive = true;
  Serial.printf("[Portal] Starting setup AP: \"%s\"\n", AP_SSID);

  WiFi.disconnect(true, true);
  delay(100);
  WiFi.mode(WIFI_AP_STA);
  delay(100);

  bool ok = WiFi.softAP(AP_SSID, "", 1, 0, 4);
  Serial.printf("[Portal] softAP() returned %s\n", ok ? "true" : "false");
  delay(500);

  dns.start(53, "*", IPAddress(192, 168, 4, 1));

  Serial.printf("[Portal] AP IP:  %s\n", WiFi.softAPIP().toString().c_str());
  Serial.printf("[Portal] AP MAC: %s\n", WiFi.softAPmacAddress().c_str());
  Serial.println("[Portal] Setup page: http://192.168.4.1/config");
}

void startConfigPortal() {
  portalActive = true;
  Serial.println("[Portal] No WiFi credentials (or STA failed) -- starting config portal");
  Serial.printf("[Portal] Connect to AP: \"%s\"\n", AP_SSID);
  Serial.println("[Portal] Then open http://192.168.4.1/config");

  WiFi.disconnect(true, true);
  delay(100);
  WiFi.mode(WIFI_AP_STA);
  delay(100);

  bool ok = WiFi.softAP(AP_SSID, "", 1, 0, 4);
  Serial.printf("[Portal] softAP() returned %s\n", ok ? "true" : "false");
  delay(500);

  dns.start(53, "*", IPAddress(192, 168, 4, 1));

  registerRoutes();
  server.begin();

  Serial.printf("[Portal] AP IP:  %s\n", WiFi.softAPIP().toString().c_str());
  Serial.printf("[Portal] AP MAC: %s\n", WiFi.softAPmacAddress().c_str());

  // Block here -- ESP restarts automatically via handleSave() when creds are submitted
  while (true) {
    dns.processNextRequest();
    server.handleClient();
    delay(2);
  }
}

// WIFI -- connect using saved credentials
bool wifiConnect() {
  prefs.begin("wifi", true);
  String ssid = prefs.getString("ssid", "");
  String pass = prefs.getString("pass", "");
  prefs.end();

  if (ssid.length() == 0) return false;   // no credentials saved yet

  Serial.printf("[WiFi] Connecting to \"%s\"", ssid.c_str());
  WiFi.mode(portalActive ? WIFI_AP_STA : WIFI_STA);
  WiFi.disconnect(false, false);
  configureWiFiRadio();
  delay(250);
  WiFi.begin(ssid.c_str(), pass.length() > 0 ? pass.c_str() : nullptr);

  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_CONNECT_TIMEOUT_MS) {
    delay(500);
    Serial.print(".");
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    wifiConnected = true;
    Serial.printf("[WiFi] Connected -- IP: %s\n", WiFi.localIP().toString().c_str());
    return true;
  }
  Serial.printf("[WiFi] Failed to connect to \"%s\"\n", ssid.c_str());
  wifiConnected = false;
  return false;
}

// SEND ACK via LoRa
void sendAck(const String& eventId) {
  String ack = "ACK:" + eventId;
  LoRa.beginPacket();
  LoRa.print(ack);
  LoRa.endPacket(false);
  Serial.printf("[LoRa] ACK sent: %s\n", ack.c_str());
}

// BIDIRECTIONAL LORA HELPERS

void addOrUpdateActiveTrip(const String& tripId, const String& truckCode) {
  if (tripId.length() == 0) return;
  for (auto& t : activeTrips) {
    if (t.trip_id == tripId) {
      t.last_uplink_ms = millis();
      if (truckCode.length() > 0 && t.truck_code != truckCode) t.truck_code = truckCode;
      return;
    }
  }
  ActiveTrip nt;
  nt.trip_id                = tripId;
  nt.truck_code             = truckCode;
  nt.last_uplink_ms         = millis();
  nt.last_action_poll_ms    = 0;
  nt.last_alert_poll_ms     = 0;
  nt.last_nav_signature     = "";
  nt.last_rest_threshold_ms = 0;
  nt.has_companion_state    = false;
  nt.last_mobile_companion_active = false;
  activeTrips.push_back(nt);
  Serial.printf("[GW] active trip registered -- trip=%s truck=%s (now tracking %u)\n",
                tripId.c_str(), truckCode.c_str(), (unsigned)activeTrips.size());
}

// Drop trips that haven't sent an uplink in ACTIVE_TRIP_TIMEOUT_MS.
void pruneActiveTrips() {
  unsigned long now = millis();
  size_t before = activeTrips.size();
  activeTrips.erase(
    std::remove_if(activeTrips.begin(), activeTrips.end(),
      [now](const ActiveTrip& t) { return now - t.last_uplink_ms > ACTIVE_TRIP_TIMEOUT_MS; }),
    activeTrips.end());
  if (activeTrips.size() < before) {
    Serial.printf("[GW] pruned %u stale trip(s); %u remain\n",
                  (unsigned)(before - activeTrips.size()), (unsigned)activeTrips.size());
  }
}

// Generic backend GET -- caller passes path, receives body (or "" on failure).
String backendGet(const String& path) {
  if (!wifiConnected || WiFi.status() != WL_CONNECTED) return "";
  HTTPClient http;
  String url = String(BACKEND_URL) + path;
  http.begin(url);
  http.addHeader("x-device-key", DEVICE_API_KEY);
  http.setTimeout(HTTP_TIMEOUT_MS);
  int code = http.GET();
  String body = (code >= 200 && code < 300) ? http.getString() : String("");
  http.end();
  if (body.length() == 0 && code != 200 && code != 204) {
    Serial.printf("[HTTP] GET %s -> HTTP %d\n", path.c_str(), code);
  }
  return body;
}

String backendPost(const String& path, const String& body) {
  if (!wifiConnected || WiFi.status() != WL_CONNECTED) return "";
  HTTPClient http;
  String url = String(BACKEND_URL) + path;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_API_KEY);
  http.setTimeout(HTTP_TIMEOUT_MS);
  int code = http.POST(body);
  String resp = (code >= 200 && code < 300) ? http.getString() : String("");
  http.end();
  if (resp.length() == 0 && code != 200 && code != 204) {
    Serial.printf("[HTTP] POST %s -> HTTP %d\n", path.c_str(), code);
  }
  return resp;
}

// Backend ack/fail/sent notifications -- single line so the polling loop stays readable.
void notifyBackendSent(const String& actionId) {
  if (actionId.length() == 0) return;
  backendPost("/device/pending-action/" + actionId + "/sent", "{}");
}
void notifyBackendAck(const String& actionId, bool success, const String& reason) {
  if (actionId.length() == 0) return;
  String body = success ? "{\"success\":true}"
                        : String("{\"success\":false,\"failure_reason\":\"") + reason + "\"}";
  backendPost("/device/pending-action/" + actionId + "/ack", body);
}
void notifyBackendFail(const String& actionId, const String& reason) {
  if (actionId.length() == 0) return;
  backendPost("/device/pending-action/" + actionId + "/fail",
              String("{\"failure_reason\":\"") + reason + "\"}");
}

// Has this action_id (or eid for nav/threshold) already been enqueued
bool isDownlinkPending(const String& key) {
  for (const auto& p : pendingDownlinks) {
    if (p.action_id == key || p.eid == key) return true;
  }
  return false;
}

bool isPersistentDownlink(const PendingDownlink& p) {
  return p.cmd == "threshold_update";
}

void enqueueDownlink(const String& actionId, const String& tripId,
                     const String& truckCode, const String& cmd,
                     const String& dataJson) {
  if (cmd == "threshold_update") {
    pendingDownlinks.erase(
      std::remove_if(pendingDownlinks.begin(), pendingDownlinks.end(),
        [&](const PendingDownlink& existing) {
          return existing.trip_id == tripId && existing.cmd == cmd;
        }),
      pendingDownlinks.end());
  }
  PendingDownlink p;
  p.action_id       = actionId;
  p.trip_id         = tripId;
  p.truck_code      = truckCode;
  p.cmd             = cmd;
  p.data_json       = dataJson;
  p.eid             = truckCode + "-D" + String(millis());
  p.retries         = 0;
  p.last_send_ms    = 0;
  p.backend_tracked = (actionId.length() > 0);
  pendingDownlinks.push_back(p);
  Serial.printf("[DL] enqueued cmd=%s to truck=%s eid=%s actionId=%s\n",
                cmd.c_str(), truckCode.c_str(), p.eid.c_str(), actionId.c_str());
}

// Compose and transmit one downlink packet over LoRa.
void sendDownlinkPacket(PendingDownlink& p) {
  JsonDocument doc;
  doc["to"]  = p.truck_code;
  doc["cmd"] = p.cmd;
  doc["eid"] = p.eid;
  if (p.data_json.length() > 0) {
    JsonDocument dataDoc;
    if (deserializeJson(dataDoc, p.data_json) == DeserializationError::Ok) {
      doc["data"] = dataDoc;
    }
  }
  String pkt;
  serializeJson(doc, pkt);
  if (pkt.length() > 240) {
    Serial.printf("[DL] WARNING packet=%u bytes (over 240) -- gateway must shorten cmd payload\n",
                  pkt.length());
  }
  LoRa.beginPacket();
  LoRa.print(pkt);
  LoRa.endPacket(false);
  LoRa.receive();
  p.last_send_ms = millis();
  p.retries++;
  downlinksSent++;
  if (isPersistentDownlink(p)) {
    Serial.printf("[DL] sent cmd=%s to=%s eid=%s attempt=%u/continuous (%u bytes)\n",
                  p.cmd.c_str(), p.truck_code.c_str(), p.eid.c_str(),
                  p.retries, pkt.length());
  } else {
    Serial.printf("[DL] sent cmd=%s to=%s eid=%s attempt=%u/%u (%u bytes)\n",
                  p.cmd.c_str(), p.truck_code.c_str(), p.eid.c_str(),
                  p.retries, DOWNLINK_MAX_RETRIES, pkt.length());
  }
}

void processDownlinks() {
  unsigned long now = millis();
  for (auto it = pendingDownlinks.begin(); it != pendingDownlinks.end(); ) {
    // First send
    if (it->retries == 0) {
      sendDownlinkPacket(*it);
      if (it->backend_tracked) notifyBackendSent(it->action_id);
      ++it;
      continue;
    }
    // Awaiting ACK -- wait DOWNLINK_ACK_TIMEOUT_MS before next retry / failure
    if (now - it->last_send_ms < DOWNLINK_ACK_TIMEOUT_MS) {
      ++it;
      continue;
    }
    // Timeout -- retry or fail
    if (isPersistentDownlink(*it)) {
      if (now - it->last_send_ms < DOWNLINK_INFO_RETRY_MS) {
        ++it;
        continue;
      }
      Serial.printf("[DL] ACK timeout cmd=%s eid=%s ?EUR" retrying continuously (attempt %u)\n",
                    it->cmd.c_str(), it->eid.c_str(), it->retries + 1);
      sendDownlinkPacket(*it);
      ++it;
    } else if (it->retries < DOWNLINK_MAX_RETRIES) {
      Serial.printf("[DL] ACK timeout cmd=%s eid=%s -- retransmitting (attempt %u)\n",
                    it->cmd.c_str(), it->eid.c_str(), it->retries + 1);
      sendDownlinkPacket(*it);
      if (it->backend_tracked) notifyBackendSent(it->action_id);
      ++it;
    } else {
      Serial.printf("[DL] FAIL cmd=%s eid=%s -- retry cap reached\n",
                    it->cmd.c_str(), it->eid.c_str());
      downlinksFailed++;
      if (it->backend_tracked) notifyBackendFail(it->action_id, "ack_timeout");
      it = pendingDownlinks.erase(it);
    }
  }
}

// Returns true if matched (and erased from queue), false otherwise.
bool tryMatchDownlinkAck(const String& packetText) {
  // HMI sends "ACK:<eid>" same format the gateway uses to ACK uplinks.
  if (!packetText.startsWith("ACK:")) return false;
  String eid = packetText.substring(4);
  eid.trim();
  for (auto it = pendingDownlinks.begin(); it != pendingDownlinks.end(); ++it) {
    if (it->eid == eid) {
      Serial.printf("[DL] ACK received cmd=%s eid=%s -- clearing\n",
                    it->cmd.c_str(), eid.c_str());
      downlinksAcked++;
      if (it->backend_tracked) notifyBackendAck(it->action_id, true, "");
      pendingDownlinks.erase(it);
      return true;
    }
  }
  return false;
}

void pollPendingActions(ActiveTrip& trip) {
  String body = backendGet("/device/pending-actions/" + trip.trip_id);
  if (body.length() == 0) return;
  JsonDocument doc;
  if (deserializeJson(doc, body) != DeserializationError::Ok) return;
  JsonArray arr = doc.as<JsonArray>();
  for (JsonObject a : arr) {
    String actionId = a["id"].as<String>();
    String action   = a["action"].as<String>();
    String status   = a["status"].as<String>();
    if (status != "pending" && status != "sent") continue;
    if (isDownlinkPending(actionId)) continue;
    String dataJson;
    if (a["data"].is<JsonVariant>()) {
      JsonVariant dv = a["data"];
      serializeJson(dv, dataJson);
    }
    enqueueDownlink(actionId, trip.trip_id, trip.truck_code, action, dataJson);
  }
}

// Poll backend for alerts/nav/threshold (15s cadence) and emit informational downlinks
void pollAlertsAndNav(ActiveTrip& trip) {
  String body = backendGet("/device/alerts/" + trip.trip_id);
  if (body.length() == 0) return;
  JsonDocument doc;
  if (deserializeJson(doc, body) != DeserializationError::Ok) return;

  const char* navInstr  = doc["nav_step_instruction"] | "";
  int         navDistM  = doc["nav_step_dist_m"]      | -1;
  String      navType   = doc["nav_step_type"].is<int>()
    ? String(doc["nav_step_type"].as<int>())
    : String((const char*)(doc["nav_step_type"] | ""));
  const char* navStreet = doc["nav_next_street"]      | "";
  if (strlen(navInstr) > 0 || navDistM >= 0) {
    String sig = String(navInstr) + "|" + String(navDistM) + "|" + navType + "|" + String(navStreet);
    if (sig != trip.last_nav_signature) {
      trip.last_nav_signature = sig;
      String dataJson;
      JsonDocument navDoc;
      navDoc["instr"]  = navInstr;
      navDoc["dist"]   = navDistM;
      navDoc["type"]   = navType;
      navDoc["street"] = navStreet;
      serializeJson(navDoc, dataJson);
      enqueueDownlink("", trip.trip_id, trip.truck_code, "nav_update", dataJson);
    }
  }

  // Companion presence -- push when the phone/mobile webapp active state changes.
  bool companionActive = doc["mobile_companion_active"] | false;
  if (!trip.has_companion_state || companionActive != trip.last_mobile_companion_active) {
    trip.has_companion_state = true;
    trip.last_mobile_companion_active = companionActive;
    String dataJson;
    JsonDocument compDoc;
    compDoc["active"] = companionActive;
    serializeJson(compDoc, dataJson);
    enqueueDownlink("", trip.trip_id, trip.truck_code, "companion_update", dataJson);
  }

  uint32_t threshMs = doc["rest_threshold_ms"] | 0;
  if (threshMs > 0 && threshMs != trip.last_rest_threshold_ms) {
    trip.last_rest_threshold_ms = threshMs;
    String dataJson;
    JsonDocument thrDoc;
    thrDoc["rest_threshold_ms"] = threshMs;
    serializeJson(thrDoc, dataJson);
    enqueueDownlink("", trip.trip_id, trip.truck_code, "threshold_update", dataJson);
  }
}

// Drive per-trip polling on the two cadences.
void processActiveTripPolls() {
  unsigned long now = millis();
  for (auto& trip : activeTrips) {
    if (now - trip.last_action_poll_ms >= POLL_ACTIONS_INTERVAL_MS) {
      trip.last_action_poll_ms = now;
      pollPendingActions(trip);
    }
    if (now - trip.last_alert_poll_ms >= POLL_ALERTS_INTERVAL_MS) {
      trip.last_alert_poll_ms = now;
      pollAlertsAndNav(trip);
    }
  }
}

// FORWARD to backend
bool forwardToBackend(const String& rawJson, int rssi, float snr) {
  JsonDocument doc;
  if (deserializeJson(doc, rawJson) != DeserializationError::Ok) {
    Serial.println("[HTTP] JSON parse error");
    return false;
  }

  doc["channel_used"] = "lora";
  doc["comm_channel"] = "lora";
  doc["rssi"]         = rssi;
  doc["snr"]          = snr;
  doc["gateway"]      = "office_lora_gw";

  if (jsonHas(doc, "eid")  && !jsonHas(doc, "event_id"))   doc["event_id"]   = doc["eid"];
  if (jsonHas(doc, "tid")  && !jsonHas(doc, "trip_id"))    doc["trip_id"]    = doc["tid"];
  if (jsonHas(doc, "vid")  && !jsonHas(doc, "truck_id"))   doc["truck_id"]   = doc["vid"];
  if (jsonHas(doc, "did")  && !jsonHas(doc, "driver_id"))  doc["driver_id"]  = doc["did"];
  if (jsonHas(doc, "spd")  && !jsonHas(doc, "speed"))      doc["speed"]      = doc["spd"];
  if (jsonHas(doc, "fuel") && !jsonHas(doc, "fuel_level")) doc["fuel_level"] = doc["fuel"];
  if (jsonHas(doc, "st")   && !jsonHas(doc, "start_time")) doc["start_time"] = doc["st"];
  if (jsonHas(doc, "et")   && !jsonHas(doc, "end_time"))   doc["end_time"]   = doc["et"];
  if (jsonHas(doc, "ch")   && !jsonHas(doc, "channel_used")) doc["channel_used"] = doc["ch"];
  // HMI-side trip clock snapshot -- preserve when forwarding so backend/dashboard
  if (jsonHas(doc, "hds")  && !jsonHas(doc, "hmi_driving_sec")) doc["hmi_driving_sec"] = doc["hds"];
  if (jsonHas(doc, "hrs")  && !jsonHas(doc, "hmi_rest_sec"))    doc["hmi_rest_sec"]    = doc["hrs"];
  if (jsonHas(doc, "nrs")  && !jsonHas(doc, "next_rest_in_sec")) doc["next_rest_in_sec"] = doc["nrs"];

  const char* path = jsonHas(doc, "path") ? doc["path"].as<const char*>() : "/telemetry";
  String body;
  serializeJson(doc, body);

  if (!wifiConnected || WiFi.status() != WL_CONNECTED) {
    // Try reconnect once before giving up on this packet
    wifiConnected = wifiConnect();
    if (!wifiConnected) {
      Serial.println("[HTTP] WiFi not available -- cannot forward");
      return false;
    }
  }

  String url = String(BACKEND_URL) + path;
  for (int attempt = 0; attempt < HTTP_RETRIES; attempt++) {
    HTTPClient http;
    http.begin(url);
    http.addHeader("Content-Type", "application/json");
    http.addHeader("x-device-key", DEVICE_API_KEY);
    http.setTimeout(HTTP_TIMEOUT_MS);
    int code = http.POST(body);
    String resp = http.getString();
    http.end();
    if (code >= 200 && code < 300) {
      Serial.printf("[HTTP] Forwarded to %s -- HTTP %d\n", path, code);
      pktsForwarded++;
      return true;
    }
    Serial.printf("[HTTP] Attempt %d failed -- HTTP %d\n", attempt + 1, code);
    if (resp.length() > 0) {
      Serial.printf("[HTTP] Error body: %.180s\n", resp.c_str());
    }
    if (attempt < HTTP_RETRIES - 1) delay(1000);
  }
  pktsFailed++;
  return false;
}

// SETUP
void setup() {
  Serial.begin(115200);
  delay(500);
  // Silence captive-portal probe noise (Android/iOS hit /generate_204,
  esp_log_level_set("WebServer", ESP_LOG_NONE);
  esp_log_level_set("WiFiUdp",   ESP_LOG_NONE);
  esp_log_level_set("Parsing",   ESP_LOG_NONE);
  Serial.println("\n[GW] Fleet LoRa Gateway starting...");

  portalActive = true;

  // WiFi: try saved credentials; open config portal if none / failed
  int attempts = 0;
  bool connected = false;
  while (!connected && attempts < WIFI_MAX_ATTEMPTS) {
    connected = wifiConnect();
    attempts++;
    if (!connected && attempts < WIFI_MAX_ATTEMPTS) delay(2000);
  }
  if (!connected) {
    // Opens the config portal -- blocks until user saves credentials + ESP restarts
    startConfigPortal();
  }

  portalActive = false;
  startSetupAccessPoint();

  // Web server (config + status) -- accessible on local network
  registerRoutes();
  server.begin();
  Serial.printf("[Web] Config: http://%s/config\n", WiFi.localIP().toString().c_str());
  Serial.printf("[Web] Status: http://%s/status\n", WiFi.localIP().toString().c_str());

  // LoRa
  LoRa.setPins(LORA_NSS_PIN, LORA_RST_PIN, LORA_DIO0_PIN);
  if (!LoRa.begin(LORA_FREQUENCY)) {
    Serial.println("[LoRa] FATAL: module not found -- check wiring");
    while (true) delay(1000);
  }
  LoRa.setSpreadingFactor(LORA_SF);
  LoRa.setSignalBandwidth(LORA_BW);
  LoRa.setSyncWord(LORA_SYNC_WORD);
  LoRa.receive();

  Serial.printf("[LoRa] Ready -- 433.0 MHz / SF%d / BW%d kHz\n", LORA_SF, LORA_BW / 1000);
  Serial.println("[GW] Listening for truck LoRa packets...");
}

// LOOP
void loop() {
  // Serve web requests (config page / status) while listening for LoRa
  if (portalActive) dns.processNextRequest();
  server.handleClient();

  // Reconnect WiFi if dropped
  if (WiFi.status() != WL_CONNECTED && wifiConnected) {
    Serial.println("[WiFi] Connection lost -- reconnecting...");
    wifiConnected = false;
    wifiConnect();
  }

  // Bidirectional LoRa background work -- polling, downlinks, pruning.
  processActiveTripPolls();
  processDownlinks();
  static unsigned long lastPrune = 0;
  if (millis() - lastPrune > 30000) { lastPrune = millis(); pruneActiveTrips(); }

  int pktSize = LoRa.parsePacket();
  if (pktSize == 0) return;

  String incoming = "";
  while (LoRa.available()) incoming += (char)LoRa.read();
  incoming.trim();

  int rssi = LoRa.packetRssi();
  float snr = LoRa.packetSnr();
  pktsReceived++;

  Serial.printf("\n[LoRa] Packet #%u -- %d bytes  RSSI=%d dBm  SNR=%.1f dB\n",
                pktsReceived, pktSize, rssi, snr);
  Serial.printf("[LoRa] Payload: %s\n", incoming.c_str());

  // First: is this an ACK for one of our outstanding downlinks
  if (tryMatchDownlinkAck(incoming)) {
    LoRa.receive();
    return;
  }

  JsonDocument peek;
  String eventId = "";
  String tripId  = "";
  String truckCode = "";
  if (deserializeJson(peek, incoming) == DeserializationError::Ok) {
    eventId = jsonHas(peek, "eid")      ? peek["eid"].as<String>()
            : jsonHas(peek, "event_id") ? peek["event_id"].as<String>()
            : "";
    tripId  = jsonHas(peek, "tid")      ? peek["tid"].as<String>()
            : jsonHas(peek, "trip_id")  ? peek["trip_id"].as<String>()
            : "";
    // Truck code prefix lives in eid (HMI format: <truckCode>-<suffix> where
    int dashIdx = eventId.lastIndexOf('-');
    if (dashIdx > 0) truckCode = eventId.substring(0, dashIdx);
  }

  if (eventId.length() > 0) {
    sendAck(eventId);
  } else {
    Serial.println("[GW] Warning: no event_id in packet -- ACK skipped");
  }

  if (tripId.length() > 0) addOrUpdateActiveTrip(tripId, truckCode);

  bool ok = forwardToBackend(incoming, rssi, snr);
  if (!ok) Serial.println("[GW] Forward failed -- logged to serial only");

  if (pktsReceived % 10 == 0) {
    Serial.printf("[GW] Stats: rx=%u fwd=%u fail=%u  |  DL sent=%u acked=%u failed=%u  |  active trips=%u  pending DL=%u\n",
                  pktsReceived, pktsForwarded, pktsFailed,
                  downlinksSent, downlinksAcked, downlinksFailed,
                  (unsigned)activeTrips.size(), (unsigned)pendingDownlinks.size());
  }

  LoRa.receive();
}
