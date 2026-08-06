// GSM/LTE Drive Test -- bare A7670E harness

#include <Arduino.h>
#include <HardwareSerial.h>

HardwareSerial modem(1);

static uint8_t  currentStop = 0;
static bool     btnLast     = HIGH;
static uint32_t btnPressedAt = 0;
static uint32_t lastCsqMs   = 0;

// Minimal AT helper
// AT+HTTPDATA we need to wait for "DOWNLOAD" instead of "OK".
static String atSend(const char* cmd, uint32_t timeoutMs = 2000,
                     const char* okToken = "OK") {
  while (modem.available()) modem.read();
  modem.println(cmd);
  uint32_t t0 = millis();
  String resp;
  while (millis() - t0 < timeoutMs) {
    while (modem.available()) resp += (char)modem.read();
    if (okToken && *okToken && resp.indexOf(okToken) >= 0) break;
    if (resp.indexOf("ERROR") >= 0) break;
    delay(5);
  }
  return resp;
}

static String waitHttpActionUrc(uint32_t timeoutMs) {
  uint32_t t0 = millis();
  String resp;
  while (millis() - t0 < timeoutMs) {
    while (modem.available()) resp += (char)modem.read();
    int marker = resp.indexOf("+HTTPACTION:");
    if (marker >= 0) {
      // Drain another 300 ms to capture the complete ",<status>,<len>" line.
      uint32_t drainT = millis();
      while (millis() - drainT < 300) {
        while (modem.available()) resp += (char)modem.read();
        int comma1 = resp.indexOf(',', marker);
        int comma2 = comma1 >= 0 ? resp.indexOf(',', comma1 + 1) : -1;
        int eol    = comma2 >= 0 ? resp.indexOf('\n', comma2) : -1;
        if (eol >= 0) return resp;
        delay(5);
      }
      return resp;
    }
    delay(5);
  }
  return resp;
}

static void modemPowerOn() {
  pinMode(MODEM_PWRKEY_PIN, OUTPUT);
  digitalWrite(MODEM_PWRKEY_PIN, HIGH);
  delay(100);
  digitalWrite(MODEM_PWRKEY_PIN, LOW);     // active-low pulse
  delay(1200);
  digitalWrite(MODEM_PWRKEY_PIN, HIGH);
}

// CSQ poll
static int parseCsq(const String& resp) {
  int p = resp.indexOf("+CSQ:");
  if (p < 0) return -1;
  int comma = resp.indexOf(',', p);
  if (comma < 0) return -1;
  return resp.substring(p + 6, comma).toInt();
}

// Active RAT detection via AT+CPSI
static const char* queryActiveRat() {
  String resp = atSend("AT+CPSI?", 1500);
  int p = resp.indexOf("+CPSI:");
  if (p < 0) return "unknown";
  int start = p + 7;
  while (start < (int)resp.length() && resp[start] == ' ') start++;
  int comma = resp.indexOf(',', start);
  if (comma < 0) return "unknown";
  String tech = resp.substring(start, comma);
  tech.trim();
  tech.toUpperCase();
  if (tech.startsWith("LTE"))   return "LTE";
  if (tech.startsWith("WCDMA")) return "WCDMA";  // 3G -- rare in PH but possible
  if (tech.startsWith("GSM"))   return "GSM";
  if (tech.startsWith("EDGE"))  return "GSM";    // EDGE is the 2G data layer
  if (tech.indexOf("NO SERVICE") >= 0) return "none";
  return "unknown";
}

// HTTPS POST via A7670E HTTP/SSL stack
static int doHttpsPost(uint32_t* outLatencyMs) {
  const char* body = "{\"t\":\"gsm_drive_test\",\"n\":1}";
  uint32_t t0 = millis();

  // Clear any half-open session from a previous attempt (HTTPINIT errors out
  atSend("AT+HTTPTERM", 800);

  atSend("AT+CSSLCFG=\"sslversion\",0,3",       500);
  atSend("AT+CSSLCFG=\"authmode\",0,0",         500);
  atSend("AT+CSSLCFG=\"ignorelocaltime\",0,1",  500);
  atSend("AT+CSSLCFG=\"enableSNI\",0,1",        500);

  atSend("AT+HTTPINIT",                         2000);
  atSend("AT+HTTPPARA=\"CID\",1",               1000);

  String url = String("AT+HTTPPARA=\"URL\",\"https://")
             + THESIS_TEST_HOST + THESIS_TEST_PATH + "\"";
  atSend(url.c_str(),                           1000);
  atSend("AT+HTTPPARA=\"SSLCFG\",0",            500);   // bind ssl_ctx 0 to HTTP
  atSend("AT+HTTPPARA=\"CONTENT\",\"application/json\"", 500);

  String dataLen = String("AT+HTTPDATA=") + strlen(body) + ",5000";
  String dl = atSend(dataLen.c_str(), 3000, "DOWNLOAD");
  if (dl.indexOf("DOWNLOAD") < 0) {
    atSend("AT+HTTPTERM", 500);
    if (outLatencyMs) *outLatencyMs = millis() - t0;
    return -1;
  }
  modem.print(body);
  modem.flush();
  // Brief settle for the modem to acknowledge the body before HTTPACTION.
  uint32_t dlT = millis();
  while (millis() - dlT < 800) {
    if (modem.available()) modem.read();   // drain echo
    delay(5);
  }

  // Issue POST and wait for the asynchronous +HTTPACTION URC (NOT just OK).
  modem.println("AT+HTTPACTION=1");
  String urc = waitHttpActionUrc(20000);
  atSend("AT+HTTPTERM", 500);

  uint32_t latency = millis() - t0;
  if (outLatencyMs) *outLatencyMs = latency;

  int p = urc.indexOf("+HTTPACTION: 1,");
  if (p < 0) return -1;
  return urc.substring(p + 15, urc.indexOf(',', p + 15)).toInt();
}

// Setup
void setup() {
  Serial.begin(115200);
  pinMode(BOOT_BTN_PIN, INPUT_PULLUP);
  modem.begin(115200, SERIAL_8N1, MODEM_RX_PIN, MODEM_TX_PIN);

  Serial.println("[gsm_drive] powering modem...");
  modemPowerOn();
  delay(8000);

  Serial.println("[gsm_drive] AT shake...");
  atSend("AT", 2000);
  atSend("AT+CMEE=2", 1500);
  atSend("AT+CFUN=1", 5000);
  atSend("AT+CNMP=2",  3000);
  atSend("AT+COPS=0",  8000);
  String reg = atSend("AT+CEREG?", 3000);
  Serial.printf("[gsm_drive] CEREG: %s\n", reg.c_str());

  // Activate PDP context
  String apnCmd = String("AT+CGDCONT=1,\"IP\",\"") + THESIS_APN + "\"";
  atSend(apnCmd.c_str(), 2000);
  atSend("AT+CGACT=1,1", 8000);

  Serial.println("[gsm_drive] ready -- press BOOT once at each stop");
  Serial.println("[gsm_drive] header: GSM|t=<ms>|stop=<n>|csq=<0..31>|rat=<LTE|GSM|WCDMA|none>|http=<code>|latency_ms=<n>");
}

// Loop
void loop() {
  bool btn = digitalRead(BOOT_BTN_PIN);
  uint32_t now = millis();
  if (btn == LOW && btnLast == HIGH) {
    btnPressedAt = now;
  } else if (btn == HIGH && btnLast == LOW) {
    uint32_t held = now - btnPressedAt;
    if (held >= 3000) {
      Serial.println("GSM|END");
      while (true) delay(1000);
    } else {
      currentStop = (currentStop + 1) % 6;
      Serial.printf("GSM|STOP_MARK|stop=%u|t=%lu\n",
                    (unsigned)currentStop, (unsigned long)now);
    }
    delay(150);
  }
  btnLast = btn;

  if (now - lastCsqMs >= CSQ_INTERVAL_MS) {
    lastCsqMs = now;
    String csqResp = atSend("AT+CSQ", 1500);
    int csq = parseCsq(csqResp);

    const char* rat = queryActiveRat();

    uint32_t latencyMs = 0;
    int httpCode = doHttpsPost(&latencyMs);

    Serial.printf("GSM|t=%lu|stop=%u|csq=%d|rat=%s|http=%d|latency_ms=%lu\n",
                  (unsigned long)now, (unsigned)currentStop, csq, rat, httpCode,
                  (unsigned long)latencyMs);
  }
}
