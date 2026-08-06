#include <Arduino.h>
#include <SPI.h>
#include <TFT_eSPI.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <TinyGPSPlus.h>
#include <SPIFFS.h>
#include <freertos/FreeRTOS.h>
#include <freertos/task.h>
#include <freertos/queue.h>
#include <esp_task_wdt.h>
#include <mcp2515.h>
#include <LoRa.h>
#include <vector>


// Backend
#define API_BASE    "https://thesis-ug1z.onrender.com"
#define API_HOST    "thesis-ug1z.onrender.com"  // SNI hostname for A7670E SSL

// Hardware pins
#define TOUCH_CS_PIN   21   // used by TFT_eSPI via -DTOUCH_CS build flag
#define TOUCH_IRQ_PIN  27   // T_IRQ -- active LOW when screen is touched
#define BUZZER        25

#define DEVICE_API_KEY "fleet-device-key-2024"

// GSM / A7670E (UART1) -- backup internet path
#define GSM_RX_PIN    34
#define GSM_TX_PIN    32   // ESP32 GPIO 32 -> A7670E RXD
#define GSM_PWRKEY     5   // ESP32 GPIO 5 -> transistor/open-drain PWRKEY control
#define GSM_BAUD  115200   // A7670E factory default -- never needs AT+IPR
#define GSM_APN     "internet"   // Philippine SIM APN -- change to "globe" for Globe

#define GPS_RX_PIN    16   // ESP32 GPIO 16 <- GY-NEO-8M TX
#define GPS_TX_PIN    17   // ESP32 GPIO 17 -> GY-NEO-8M RX
#define GPS_BAUD    9600
#define GPS_FIX_TIMEOUT_MS  20000
#define GPS_STATUS_REFRESH_MS 4000 // how often to redraw GPS badge on screen

#define BTN_TAKE_REST  22
#define BTN_SNOOZE     39
#define BTN_DEBOUNCE_MS 50  // confirm press after 50 ms for clean debounce

#define CAN_CS_PIN   14
#define CAN_INT_PIN  35
#define CAN_POLL_MS 2000
#define CAN_HSPI_SCK  12  // output; SPI mode 0 idles LOW -- safe for GPIO12
#define CAN_HSPI_MISO  2  // input from MCP2515; GPIO2 as input is boot-safe
#define CAN_HSPI_MOSI 15  // output to MCP2515

#define LORA_NSS_PIN    13    // GPIO13: free output GPIO, no boot-strapping side effects
#define LORA_DIO0_PIN   36    // GPIO36: input-only, used as TX/RX-done interrupt
#define LORA_RST_PIN    -1    // Ra-02 RST not wired -- library uses software reset
#define LORA_FREQUENCY  433000000UL
#define LORA_SF          7    // Spreading Factor 7: fastest, shortest airtime, ~1-3km urban
#define LORA_BW     125000
#define LORA_TX_POWER   17
#define LORA_ACK_TIMEOUT_MS 2000   // wait 2s for ACK before falling back to GSM
#define LORA_MAX_RETRIES    1

// Communication channel tracking
enum CommChannel { CH_WIFI_OK, CH_LORA_OK, CH_LORA_NO_ACK, CH_LTE_OK, CH_GSM_OK, CH_GSM_NO_SERVER, CH_OFFLINE_BUFFERED, CH_SYNCING };
// Active cellular RAT -- set by gsmReconnect when a bearer comes up.
enum GsmRat { RAT_UNKNOWN = 0, RAT_LTE = 1, RAT_GSM_2G = 2 };
volatile GsmRat gsmActiveRat = RAT_UNKNOWN;

// Determine the active radio access technology from the A7670E's serving-cell
GsmRat detectGsmRat();
CommChannel lastCommChannel = CH_GSM_OK;
volatile unsigned long lastLoraOkMs = 0;
volatile unsigned long lastLoraFailMs = 0;
inline bool loraGatewayRecentlyOk() {
  return lastLoraOkMs != 0 && (millis() - lastLoraOkMs) < 90000UL;
}
inline bool loraGatewayBackoffActive() {
  return lastLoraFailMs != 0 && !loraGatewayRecentlyOk()
      && (millis() - lastLoraFailMs) < 60000UL;
}
bool loraReady = false;   // set true if LoRa module initialized successfully


// Screen
#define SCREEN_W 480
#define SCREEN_H 320

// Touch is read directly from XPT2046 over VSPI because this ILI9488 module

#define C_BG        0x08E7  // #0D1F3C -- very dark navy page background
#define C_SURFACE   0x1A70  // #194D84 -- deep navy header / bar surface
#define C_CARD      0x19AC  // #1A3460 -- medium navy card background
#define C_PANEL     0x1108  // #112240 -- inner panel / badge bg
#define C_BTN       0x3355  // #346AA8 -- medium blue button face
#define C_DIV       0x3355  // #346AA8 -- medium blue border / divider
#define C_ACCENT    0x85BB  // #82B7DC -- soft sky blue accent / arrows
#define C_ACCENT2   0x3355  // #346AA8 -- medium blue for headings
#define C_DIM       0xAD75  // #A8ACA8 -- medium grey secondary text
#define C_DIM2      0x7412  // #718096 -- muted grey-blue text
#define C_TEXT      0xF7BE  // #F7F7F7 -- off-white primary text
#define C_WHITE     0xFFFF  // pure white
#define C_GREEN     0x266C
#define C_ORANGE    0xFB40
#define C_RED       0xF988
#define C_AMBER     0xFD84
#define C_BTN_SOFT  0x2AD5  // muted fleet blue for primary action buttons
#define C_RED_SOFT  0xB986  // muted red for destructive action buttons
#define C_REST_SOFT 0xD565  // calm amber for rest mode
#define C_LOGOUT    0x3355  // #346AA8 -- medium blue back/logout button
#define C_BLUE      0x85BB  // alias for soft sky blue
#define C_ALERT     0xF988  // alias for RED
#define C_BAR       0x08E7

// Timing
#define TOUCH_DEBOUNCE_MS       300
#define TOUCH_SAMPLE_COUNT       12
#define TOUCH_MIN_SAMPLES         2
#define TOUCH_SAMPLE_DELAY_MS     3
#define HEALTH_CHECK_MS       20000
#define ALERT_POLL_MS         15000  // 15s: fast enough for route/pause sync, avoids GSM queue saturation at 10s
#define ALERT_POLL_WIFI_MS     5000  // WiFi-only path polls /device/alerts faster so mobile button presses
                                     // (rest/resume/end_trip via /device/pending-action) reach the HMI on the
#define TELEMETRY_INTERVAL_MS   5000  // sample/buffer interval -- offline SPIFFS gets full 5s resolution
#define TELEMETRY_PUSH_MS      15000
#define LORA_TELEMETRY_PUSH_MS 30000  // LoRa telemetry/log packet cadence while gateway is available
#define SYNC_HTTP_TIMEOUT      4000
#define ASYNC_HTTP_TIMEOUT     6000   // ms for background task HTTP calls

// State machine
enum State {
  BOOT, WIFI_CONNECT, LOGIN_PIN,
  TRUCK_SELECT, READY,
  TRIP_ACTIVE, TRIP_PAUSED, TRIP_ENDED,
  WIFI_SETTINGS
};
State state = BOOT;
State wifiReturnState = LOGIN_PIN;

// GPS
enum GpsStatus { GPS_SEARCHING, GPS_READY, GPS_ACTIVE, GPS_LOST };
TinyGPSPlus      gps;
HardwareSerial   gpsSerial(2);      // UART2
TinyGPSCustom    gpsGgaFixQualityGP(gps, "GPGGA", 6);
TinyGPSCustom    gpsGgaFixQualityGN(gps, "GNGGA", 6);
TinyGPSCustom    gpsGsaFixTypeGP(gps, "GPGSA", 2);
TinyGPSCustom    gpsGsaFixTypeGN(gps, "GNGSA", 2);
TinyGPSCustom    gpsGsvSatsInViewGP(gps, "GPGSV", 3);  // satellites the receiver can see
TinyGPSCustom    gpsGsvSatsInViewGN(gps, "GNGSV", 3);
TinyGPSCustom    gpsRmcStatusGP(gps, "GPRMC", 2);
TinyGPSCustom    gpsRmcStatusGN(gps, "GNRMC", 2);
double           gpsLat       = 0.0;
double           gpsLon       = 0.0;
double           gpsSpeedKmh  = 0.0;
bool             gpsFix          = false;
bool             gpsEverHadFix   = false;  // true once first fix acquired this session
unsigned long    lastGpsFix   = 0;
unsigned long    lastGpsStatusRefresh = 0;

// GPS distance accumulation for Model C distance fusion features.
double           gpsPrevLat       = 0.0;
double           gpsPrevLon       = 0.0;
bool             gpsPrevValid     = false;
float            telGpsDistKm     = 0.0f;  // km accumulated since last telemetry send
unsigned long    prevTelSentMs    = 0;      // millis() when last telemetry was dispatched

// Session
String driverName        = "";
String driverPin         = "";
String driverId          = "";
String selectedTruckId   = "";
String selectedTruckCode = "";
String selectedTruckModel = "";
String activeTripId      = "";
String deviceId          = "";   // WiFi MAC address -- stable hardware identity
String hmiSessionId      = "";   // active hmi_sessions.id from backend
bool   mobileCompanionActive = false;  // true when mobile app has polled within companion stale window
String activeTripStatus  = "active";
String activeTripStartIso = "";
String activeTripPausedIso = "";
String activeTripNextRestAlertIso = "";
unsigned long activeTripRestSeconds = 0;
long activeTripDrivingSeconds = -1;
// -- restoreServerTripClock falls back to deriving from server next_rest_alert_at.
long activeTripSinceRestSeconds = -1;

volatile bool isOnline         = false;
enum PendingScreen {
  SCR_NONE = 0,
  SCR_TRIP_ACTIVE = 1,
  SCR_TRIP_PAUSED = 2,
  SCR_TRIP_ENDED = 3
};
volatile uint8_t pendingScreenRedraw = SCR_NONE;
unsigned long pendingTripEndedSeconds = 0;
volatile bool backendReachable = false;

// Truck list
struct Truck { String id; String code; String plate; String model; String status; bool active; };
Truck trucks[10];
int   truckCount = 0;

// Trip timer
unsigned long tripStart    = 0;
unsigned long pauseStart   = 0;
unsigned long pausedTotal  = 0;
unsigned long lastTimerSec = 0xFFFFFFFF;

// Rest alert countdown
unsigned long restThresholdMs     = 4UL * 3600UL * 1000UL;
unsigned long lastRestMs          = 0;
long          lastRestCountdownSec = -9999;

// Touch debounce
unsigned long touchDebounceUntil = 0;
bool touchReleasedSinceLastTap = true;

struct TouchAffineCal {
  float ax;
  float bx;
  float cx;
  float ay;
  float by;
  float cy;
};

TouchAffineCal touchCal = {
  0.1288f, -0.0303f, 74.42f,
 -0.0122f, -0.0838f, 315.0f
};

// Background timers
unsigned long lastHealthCheck    = 0;
unsigned long lastAlertPoll      = 0;
unsigned long lastTelemetryPost  = 0;
unsigned long lastEndRetry       = 0;
unsigned long lastHmiHeartbeat   = 0;
bool          prevOnlineState    = false;  // detect reconnect to fire immediate heartbeat
int           gsmLastStatus     = 0;   // HTTP status of last gsmPost/gsmGet call
#define GSM_RETRY_MS   15000
#define CSQ_POLL_MS    1500

bool loginFoundActiveTrip = false;

String        externalTripId       = "";
String        externalDriverId     = "";   // driver_id of the externally-started trip
String        externalDriverName   = "";
String        externalTripStart    = "";   // ISO8601 start_time from server
String        externalPausedAt     = "";   // ISO8601 paused_at from server
String        externalNextRestAlert = "";
unsigned long externalRestSeconds  = 0;
String        externalChannel      = "";   // 'mobile_app' | 'gsm' | etc.
unsigned long lastExternalTripCheck = 0;
#define EXTERNAL_TRIP_CHECK_MS  8000      // 8 s -- fast enough to reflect mobile-started trips promptly
#define RDY_TAKEOVER_X  RDY_START_X
#define RDY_TAKEOVER_Y  RDY_START_Y
#define RDY_TAKEOVER_W  RDY_START_W
#define RDY_TAKEOVER_H  RDY_START_H

String      pendingEndTripId     = "";
String      pendingEndTime       = "";   // ISO8601 timestamp of button-press, empty if unknown
String      pendingSnoozeId      = "";
String      pendingPauseTripId   = "";
String      pendingPauseTime     = "";
String      pendingResumeTripId  = "";
String      pendingResumeTime    = "";
String        pendingTripStartBody    = "";   // full /trip/start JSON body; empty once sent to server
unsigned long pendingTripStartReadyAt  = 0;
String      locallyEndedTripId   = "";
uint32_t    evtLogSyncPtr        = 0;   // /evt_log.jsonl
uint32_t    telFlushPtr          = 0;   // /tel_flush.log
volatile bool pendingEventsDirty = false;
Preferences prefs;

// Overspeed threshold -- declared here so NVS load/SPIFFS log functions can use it
float         overspeedThresholdKmh = 80.0f;  // updated from /device/alerts response
float         fuelTankCapacityL    = 80.0f;

// SPIFFS mutex -- declared here so spiffsLogEvent/flushSpiffsEventLog can use it
SemaphoreHandle_t spiffsMutex = nullptr;

SemaphoreHandle_t nvsMutex = nullptr;

// Forward declaration -- defined later, used by spiffsLogEvent below
String getTimestamp();

static inline void nvsBegin(bool readOnly = false) {
  if (nvsMutex) xSemaphoreTake(nvsMutex, pdMS_TO_TICKS(200));
  prefs.begin("fleet", readOnly);
}
static inline void nvsEnd() {
  prefs.end();
  if (nvsMutex) xSemaphoreGive(nvsMutex);
}

void nvsSavePendingEnd(const String& tripId) {
  Preferences p; p.begin("fleet", false);
  p.putString("pendingEnd", tripId); p.end();
}
void nvsSavePendingEndTime(const String& ts) {
  Preferences p; p.begin("fleet", false);
  p.putString("pendingEndTs", ts); p.end();
}
void nvsLoadPendingEnd() {
  Preferences p; p.begin("fleet", true);
  pendingEndTripId = p.getString("pendingEnd", "");
  pendingEndTime   = p.getString("pendingEndTs", "");
  p.end();
  if (pendingEndTripId.length() > 0)
    Serial.printf("[NVS] restored pendingEnd=%s ts=%s\n",
                  pendingEndTripId.c_str(),
                  pendingEndTime.isEmpty() ? "(none)" : pendingEndTime.c_str());
}
void nvsSaveLocallyEndedTripId(const String& tripId) {
  Preferences p; p.begin("fleet", false);
  p.putString("localEndId", tripId); p.end();
}
void nvsLoadLocallyEndedTripId() {
  Preferences p; p.begin("fleet", true);
  locallyEndedTripId = p.getString("localEndId", "");
  p.end();
  if (locallyEndedTripId.length() > 0)
    Serial.printf("[NVS] restored locallyEndedTripId=%s\n", locallyEndedTripId.c_str());
}
void nvsSavePendingSnooze(const String& tripId) {
  Preferences p; p.begin("fleet", false);
  p.putString("pendSnooze", tripId); p.end();
}
void nvsLoadPendingSnooze() {
  Preferences p; p.begin("fleet", true);
  pendingSnoozeId = p.getString("pendSnooze", "");
  p.end();
  if (pendingSnoozeId.length() > 0)
    Serial.printf("[NVS] restored pendingSnooze=%s\n", pendingSnoozeId.c_str());
}
void nvsSavePendingTripBody(const String& body) {
  Preferences p; p.begin("fleet", false);
  p.putString("pendTripBody", body); p.end();
}
void nvsLoadPendingTripBody() {
  Preferences p; p.begin("fleet", true);
  pendingTripStartBody = p.getString("pendTripBody", "");
  p.end();
  if (!pendingTripStartBody.isEmpty())
    Serial.println("[NVS] restored pending trip start");
}
void nvsSaveEvtPtr(uint32_t ptr) {
  Preferences p; p.begin("fleet", false);
  p.putUInt("evtPtr", ptr); p.end();
}
void nvsLoadEvtPtr() {
  Preferences p; p.begin("fleet", true);
  evtLogSyncPtr = p.getUInt("evtPtr", 0); p.end();
}
void nvsSaveTelPtr(uint32_t ptr) {
  Preferences p; p.begin("fleet", false);
  p.putUInt("telPtr", ptr); p.end();
}
void nvsLoadTelPtr() {
  Preferences p; p.begin("fleet", true);
  telFlushPtr = p.getUInt("telPtr", 0); p.end();
}
void nvsLoadPendingEvents() {
  nvsLoadEvtPtr();
  nvsLoadTelPtr();
  // Check if there are unsynced records in the event log
  File f = SPIFFS.open("/evt_log.jsonl", "r");
  if (f) {
    uint32_t fileSize = f.size();
    f.close();
    if (fileSize > evtLogSyncPtr) {
      Serial.printf("[evt] %u unsynced byte(s) in /evt_log.jsonl from ptr=%u\n",
                    fileSize - evtLogSyncPtr, evtLogSyncPtr);
      pendingEventsDirty = true;
    }
  }
}
void nvsSaveOverspeedKmh(float kmh) {
  Preferences p; p.begin("fleet", false);
  p.putFloat("ovspdKmh", kmh); p.end();
}
void nvsLoadOverspeedKmh() {
  Preferences p; p.begin("fleet", true);
  overspeedThresholdKmh = p.getFloat("ovspdKmh", 80.0f); p.end();
  Serial.printf("[NVS] overspeedThreshold=%.1f km/h\n", overspeedThresholdKmh);
}
void nvsLoadFuelTankCapacity() {
  Preferences p; p.begin("fleet", true);
  fuelTankCapacityL = p.getFloat("tankCapL", 80.0f); p.end();
  Serial.printf("[NVS] fuelTankCapacityL=%.1f L\n", fuelTankCapacityL);
}
extern String lastShownAlertTs;  // defined later in this file
void nvsSaveLastAlertTs(const String& ts) {
  Preferences p; p.begin("fleet", false);
  p.putString("lastAlertTs", ts); p.end();
}
void nvsLoadLastAlertTs() {
  Preferences p; p.begin("fleet", true);
  lastShownAlertTs = p.getString("lastAlertTs", "");
  p.end();
  if (lastShownAlertTs.length())
    Serial.printf("[NVS] lastShownAlertTs=%s\n", lastShownAlertTs.c_str());
}
extern float  truckLifetimeKm;
extern float  truckLifetimeSavedKm;
extern String truckLifetimeNvsKey;
String shortTruckKey(const String& truckId) {
  String k = "lkm_";
  if (truckId.length() >= 8) k += truckId.substring(0, 8);
  else                       k += truckId;
  return k;
}
void nvsSaveTruckLifetimeKm(float km) {
  if (truckLifetimeNvsKey.isEmpty()) return;
  Preferences p; p.begin("fleet", false);
  p.putFloat(truckLifetimeNvsKey.c_str(), km); p.end();
  truckLifetimeSavedKm = km;
}
void nvsLoadTruckLifetimeKm(const String& truckId) {
  if (truckId.isEmpty()) return;
  truckLifetimeNvsKey = shortTruckKey(truckId);
  Preferences p; p.begin("fleet", true);
  truckLifetimeKm      = p.getFloat(truckLifetimeNvsKey.c_str(), 0.0f);
  p.end();
  truckLifetimeSavedKm = truckLifetimeKm;
  Serial.printf("[NVS] truckLifetimeKm[%s]=%.2f km\n",
                truckLifetimeNvsKey.c_str(), truckLifetimeKm);
}

void nvsSaveHmiSession() {
  Preferences p; p.begin("fleet", false);
  p.putString("hmiSessId", hmiSessionId); p.end();
}

void nvsLoadHmiSession() {
  Preferences p; p.begin("fleet", true);
  hmiSessionId = p.getString("hmiSessId", ""); p.end();
  if (!hmiSessionId.isEmpty())
    Serial.printf("[NVS] restored hmiSessionId=%s\n", hmiSessionId.c_str());
}

void nvsClearHmiSession() {
  hmiSessionId = "";
  Preferences p; p.begin("fleet", false);
  p.remove("hmiSessId"); p.end();
}

// Called once after WiFi/GSM init so MAC is readable.
void initDeviceId() {
  deviceId = WiFi.macAddress();
  deviceId.replace(":", "");
  if (deviceId.isEmpty()) deviceId = "ESP32-UNKNOWN";
  Serial.printf("[device] id=%s\n", deviceId.c_str());
}

// Confirmed active-trip persistence -- survives power-cycle without network
static unsigned long currentSinceRestSec() {
  if (lastRestMs == 0) return 0;
  unsigned long ref = (state == TRIP_PAUSED && pauseStart > 0) ? pauseStart : millis();
  if (ref < lastRestMs) return 0;
  return (ref - lastRestMs) / 1000UL;
}

void nvsSaveActiveTrip() {
  Preferences p; p.begin("actTrip", false);
  p.putString("tid",     activeTripId);
  p.putString("trkId",   selectedTruckId);
  p.putString("trkCode", selectedTruckCode);
  p.putString("trkModel", selectedTruckModel);
  p.putString("tStatus", activeTripStatus);
  p.putString("drvId",   driverId);
  // Persist the timing fields too, so restoreServerTripClock() can rebuild the
  p.putString("startIso",  activeTripStartIso);
  p.putString("pausedIso", activeTripPausedIso);
  p.putString("nextRest",  activeTripNextRestAlertIso);
  p.putULong("restSec",    activeTripRestSeconds);
  if (activeTripDrivingSeconds >= 0) {
    p.putBool("hasDrive", true);
    p.putULong("driveSec", (unsigned long)activeTripDrivingSeconds);
  }
  if (lastRestMs > 0) {
    p.putBool("hasSinceR", true);
    p.putULong("sinceRSec", currentSinceRestSec());
  }
  p.end();
  Serial.printf("[NVS] saved active trip=%s truck=%s start=%s\n",
                activeTripId.c_str(), selectedTruckCode.c_str(),
                activeTripStartIso.c_str());
}
void nvsClearActiveTrip() {
  Preferences p; p.begin("actTrip", false);
  p.clear(); p.end();
}
bool nvsRestoreActiveTrip(const String& forDriverId) {
  Preferences p; p.begin("actTrip", true);
  String tid       = p.getString("tid",       "");
  String trkId     = p.getString("trkId",     "");
  String trkCode   = p.getString("trkCode",   "");
  String trkModel  = p.getString("trkModel",  "");
  String tStatus   = p.getString("tStatus",   "active");
  String drvId     = p.getString("drvId",     "");
  String startIso  = p.getString("startIso",  "");
  String pausedIso = p.getString("pausedIso", "");
  String nextRest  = p.getString("nextRest",  "");
  unsigned long restSec = p.getULong("restSec", 0);
  bool hasDrive = p.getBool("hasDrive", false);
  unsigned long driveSec = p.getULong("driveSec", 0);
  bool hasSinceR = p.getBool("hasSinceR", false);
  unsigned long sinceRSec = p.getULong("sinceRSec", 0);
  p.end();
  if (tid.isEmpty() || trkId.isEmpty() || drvId != forDriverId) return false;
  activeTripId          = tid;
  selectedTruckId       = trkId;
  selectedTruckCode     = trkCode;
  selectedTruckModel    = trkModel;
  activeTripStatus      = tStatus;
  activeTripStartIso    = startIso;
  activeTripPausedIso   = pausedIso;
  activeTripNextRestAlertIso = nextRest;
  activeTripRestSeconds = restSec;
  activeTripDrivingSeconds = hasDrive ? (long)driveSec : -1;
  activeTripSinceRestSeconds = hasSinceR ? (long)sinceRSec : -1;
  loginFoundActiveTrip = true;
  Serial.printf("[NVS] restored active trip=%s truck=%s status=%s start=%s\n",
                tid.c_str(), trkCode.c_str(), tStatus.c_str(), startIso.c_str());
  return true;
}

void nvsSaveTripClock(unsigned long driveSec, unsigned long restSec) {
  if (activeTripId.isEmpty()) return;
  Preferences p; p.begin("actTrip", false);
  p.putBool("hasDrive", true);
  p.putULong("driveSec", driveSec);
  p.putULong("restSec", restSec);
  if (lastRestMs > 0) {
    p.putBool("hasSinceR", true);
    p.putULong("sinceRSec", currentSinceRestSec());
  }
  p.end();
}

String httpPost(const String& path, const String& body, int maxAttempts, unsigned long actionTimeoutMs);

// SPIFFS EVENT LOG  -- /evt_log.jsonl

// Append one event record to /evt_log.jsonl.
void spiffsLogEvent(const char* type, const String& tripId, const String& evTime = "") {
  String ts = evTime.isEmpty() ? getTimestamp() : evTime;

  // Build compact JSON record -- all fields needed for server replay
  String rec = "{\"type\":\"";
  rec += type;
  rec += "\",\"trip_id\":\"";
  rec += tripId;
  rec += "\",\"truck_id\":\"";
  rec += selectedTruckId;
  rec += "\",\"driver_id\":\"";
  rec += driverId;
  rec += "\",\"ts\":\"";
  rec += ts.isEmpty() ? "" : ts;
  rec += "\"}";

  xSemaphoreTake(spiffsMutex, portMAX_DELAY);
  File f = SPIFFS.open("/evt_log.jsonl", FILE_APPEND);
  if (f) { f.println(rec); f.close(); }
  xSemaphoreGive(spiffsMutex);

  pendingEventsDirty = true;
  Serial.printf("[evt] logged %s trip=%s ts=%s\n",
                type, tripId.c_str(), ts.isEmpty() ? "none" : ts.c_str());
}

// Replay all unsynced records from /evt_log.jsonl to the server.
void flushSpiffsEventLog() {
  xSemaphoreTake(spiffsMutex, portMAX_DELAY);
  File f = SPIFFS.open("/evt_log.jsonl", "r");
  if (!f) { xSemaphoreGive(spiffsMutex); pendingEventsDirty = false; return; }
  uint32_t fileSize = f.size();
  if (fileSize <= evtLogSyncPtr) {
    f.close(); xSemaphoreGive(spiffsMutex); pendingEventsDirty = false; return;
  }
  f.seek(evtLogSyncPtr);
  xSemaphoreGive(spiffsMutex);

  int sent = 0;
  while (true) {
    xSemaphoreTake(spiffsMutex, portMAX_DELAY);
    if (!f.available()) { f.close(); xSemaphoreGive(spiffsMutex); break; }
    String line = f.readStringUntil('\n');
    uint32_t posAfter = (uint32_t)f.position();
    xSemaphoreGive(spiffsMutex);

    line.trim();
    if (line.length() < 5) { evtLogSyncPtr = posAfter; nvsSaveEvtPtr(evtLogSyncPtr); continue; }

    JsonDocument doc;
    if (deserializeJson(doc, line) != DeserializationError::Ok) {
      evtLogSyncPtr = posAfter; nvsSaveEvtPtr(evtLogSyncPtr); continue;
    }

    String type   = doc["type"].as<String>();
    String tripId = doc["trip_id"].as<String>();
    String ts     = doc["ts"].as<String>();

    String resp;
    if (type == "trip_pause" || type == "trip_resume") {
      const char* path = (type == "trip_pause") ? "/trip/pause" : "/trip/resume";
      String body = "{\"trip_id\":\"" + tripId + "\"";
      if (ts.length()) body += ",\"event_time\":\"" + ts + "\"";
      body += "}";
      resp = httpPost(path, body, 1, 7000);
    } else if (type == "snooze") {
      String body = "{\"trip_id\":\"" + tripId + "\",\"duration_ms\":600000}";
      resp = httpPost("/trip/snooze", body, 1, 7000);
    }

    bool networkFail = resp.isEmpty() && !(gsmLastStatus >= 400 && gsmLastStatus <= 499);
    if (networkFail) {
      Serial.printf("[evt] flush stopped at ptr=%u (network/modem err %d)\n", evtLogSyncPtr, gsmLastStatus);
      xSemaphoreTake(spiffsMutex, portMAX_DELAY); f.close(); xSemaphoreGive(spiffsMutex);
      return;
    }

    // Success or 4xx (server rejected/duplicate) -- advance pointer
    evtLogSyncPtr = posAfter;
    nvsSaveEvtPtr(evtLogSyncPtr);
    sent++;
    Serial.printf("[evt] %s ts=%s -> %s\n", type.c_str(), ts.c_str(),
                  resp.isEmpty() ? "4xx/skip" : "OK");
  }

  xSemaphoreTake(spiffsMutex, portMAX_DELAY);
  File chk = SPIFFS.open("/evt_log.jsonl", "r");
  uint32_t currentSize = chk ? (uint32_t)chk.size() : 0;
  if (chk) chk.close();
  if (evtLogSyncPtr >= currentSize) {
    SPIFFS.remove("/evt_log.jsonl");
    xSemaphoreGive(spiffsMutex);
    evtLogSyncPtr = 0;
    nvsSaveEvtPtr(0);
    Serial.printf("[evt] log fully synced (%d record(s)) -- file cleared\n", sent);
  } else {
    xSemaphoreGive(spiffsMutex);
    Serial.printf("[evt] %d record(s) synced -- %u new byte(s) appended during flush\n",
                  sent, currentSize - evtLogSyncPtr);
  }
  pendingEventsDirty = (evtLogSyncPtr > 0);
}

// Rest-alert snooze
unsigned long restAlertSnoozedUntil  = 0;
bool          localRestAlertPending  = false; // local offline-safe rest timer flag

int  telBufCount = 0;  // approximate; restored at boot, updated on each append/flush

static int countFileLines(const char* path) {
  File f = SPIFFS.open(path, "r");
  if (!f) return 0;
  int n = 0;
  while (f.available()) { if (f.read() == '\n') n++; }
  f.close();
  return n;
}

// SO2: telemetry sequence counter + GSM state
uint32_t          telSeq          = 0;
volatile bool     gsmReady        = false;  // written by Core 0 worker, read by Core 1 UI
volatile int      gsmActiveCid    = 1;
uint8_t           gsmHttpInitFailStreak = 0; // reset the modem if its HTTP engine stays wedged

volatile uint32_t gsmHttpReqIdCounter      = 0;      // monotonic per-request ID for [HTTP] start/end correlation
volatile int8_t   lastCgattState           = -1;
volatile int8_t   lastCgactCid1State       = -1;
volatile uint32_t gsmPostWindowStartMs     = 0;      // start of current 60s rate window
volatile uint16_t gsmPostsInWindow         = 0;
volatile int      gsmRssi         = 0;
volatile bool     statusBarDirty  = false;  // set by Core 0 to request a status bar redraw
bool              wifiReady       = false;
volatile uint8_t  wifiConsecFailures = 0;
volatile uint32_t wifiBackoffUntilMs = 0;
// A7670E HTTP stack wedge: AT+HTTPDATA repeatedly returns ERROR even though the
volatile uint8_t  gsmHttpDataFailStreak = 0;
String            nvsWifiSsid     = "";     // loaded from NVS "wifiCfg"
String            nvsWifiPass     = "";
HardwareSerial    gsmSerial(1);             // UART1: GPIO 34 RX, GPIO 32 TX

// Alert tracking
String lastShownAlertId  = "";
// Timestamp of the most recent alert we've shown (ISO-8601 from backend).
String lastShownAlertTs  = "";
bool   alertOverlayActive = false;   // guard against re-entrant overlay

// HMI action priority window -- after any local driver action (REST/RESUME/END),
#define HMI_PRIORITY_MS  30000UL
unsigned long lastLocalActionMs = 0;

static volatile bool  gSpinnerActive = false;
static TaskHandle_t   gSpinnerTask   = NULL;

String   navDestination = "";   // assigned_destination from dashboard
uint32_t navDistM       = 0;    // route_dist_m in metres
uint32_t navDurS        = 0;    // route_dur_s in seconds
String   navStepInstruction = ""; // current turn instruction from mobile
uint32_t navStepDistM       = 0;  // distance to next turn in metres
int8_t   navStepType        = -1;
String   navState           = "navigating"; // navigating | arrived | rerouting
String   navGpsSource       = "";           // mobile_gps | embedded_gps
int32_t  navCurrentStepIdx  = -1;
String   navNextStreet      = "";
bool     arrivalBeepArmed   = true;
double   navDestLat         = 0.0;
double   navDestLon         = 0.0;
bool     navDestValid       = false; // true when navDestLat/Lon are populated
String   serverNowIso       = "";

// MCP2515 CAN state
SPIClass      canSpi(HSPI);                    // dedicated HSPI bus -- no LoRa MISO conflict
MCP2515       mcp2515can(CAN_CS_PIN, 500000, &canSpi); // 500 kHz on HSPI
bool          canReady      = false; // true after SPI init + setBitrate + setLoopbackMode
bool          canLoopbackOk = false; // true after first successful TX->RX self-test
uint32_t      canTxCount    = 0;
uint32_t      canRxCount    = 0;
unsigned long lastCanPoll   = 0;
uint8_t       canCrystalMhz = 8;
// Bitrate at which tryObd2Mode() successfully handshook the vehicle bus.
CAN_SPEED     canObd2ActiveBitrate = CAN_500KBPS;

volatile bool canDiscoveryBusy = false;
volatile bool canDiscoveryDone = false;

// OBD2 state
bool          canObd2Ready    = false;
unsigned long obdReconnectAtMs = 0;
float         obdSpeedKmh     = -1.0f;
float         obdOdometerKm   = -1.0f; // PID 0xA6 or Mode 21/22 DID when supported
float         obdTripIntegratedKm = -1.0f;
// GPS-haversine trip integrator -- third-tier odometer fallback for vehicles
float         gpsTripIntegratedKm = -1.0f;
// Per-truck lifetime mileage in NVS -- gives the device a stable cumulative
float         truckLifetimeKm = -1.0f;
float         truckLifetimeSavedKm = -1.0f;   // last value flushed to NVS -- for delta gate
String        truckLifetimeNvsKey = "";        // "lifeKm:<trkId>" -- set when truck selected
static constexpr float LIFETIME_SAVE_STEP_KM = 1.0f;
float         obdFuelPct      = -1.0f;
bool          obdFuelChecked  = false;
bool          obdFuelMode01   = true;  // false if ECU bitmap confirms 0x2F absent -> skip to Mode 22

float         obdRpm            = -1.0f;  // PID 0x0C: (A*256+B)/4 rpm
float         obdEngineLoadPct  = -1.0f;  // PID 0x04: A*100/255 %
float         obdThrottlePct    = -1.0f;  // PID 0x11: A*100/255 %
float         obdMafGps         = -1.0f;  // PID 0x10: (A*256+B)/100 g/s
float         obdCoolantTempC   = -1.0f;  // PID 0x05: A-40  degC
int           obdRuntimeSec     = -1;     // PID 0x1F: A*256+B seconds
bool          obdDtcPresent     = false;
uint8_t       obdDtcCount       = 0;      // PID 0x01: bits 6-0 of byte 0

// Fuel validation metadata -- set alongside obdFuelPct
bool          obdFuelValid      = false;
const char*   obdFuelSource     = "none"; // "mode01" | "mode22" | "none"
const char*   obdFuelConfidence = "low";  // "high" | "medium" | "low"

#define OBD_POLL_MS    1000            // poll speed + fuel every 1 s
#define OBD_TIMEOUT_MS   50

// PIN digit reveal
int           pinRevealIdx   = -1;
unsigned long pinRevealUntil = 0;

// DRIVER CACHE  -- persisted to NVS "drvCache" namespace
// Stores up to 5 driver records so login works without Wi-Fi.
#define MAX_CACHED_DRIVERS 5
struct CachedDriver {
  char id[40];
  char name[64];
  char pin[8];
};
CachedDriver cachedDrivers[MAX_CACHED_DRIVERS];
int          cachedDriverCount = 0;

void loadDriverCache() {
  Preferences p; p.begin("drvCache", false);
  cachedDriverCount = p.getInt("count", 0);
  if (cachedDriverCount > MAX_CACHED_DRIVERS) cachedDriverCount = MAX_CACHED_DRIVERS;
  for (int i = 0; i < cachedDriverCount; i++) {
    char key[12];
    snprintf(key, sizeof(key), "d%d_id",   i); p.getString(key, cachedDrivers[i].id,   sizeof(cachedDrivers[i].id));
    snprintf(key, sizeof(key), "d%d_name", i); p.getString(key, cachedDrivers[i].name, sizeof(cachedDrivers[i].name));
    snprintf(key, sizeof(key), "d%d_pin",  i); p.getString(key, cachedDrivers[i].pin,  sizeof(cachedDrivers[i].pin));
  }
  p.end();
  Serial.printf("[drvCache] loaded %d driver(s)\n", cachedDriverCount);
}

void saveDriverCache() {
  Preferences p; p.begin("drvCache", false);
  p.putInt("count", cachedDriverCount);
  for (int i = 0; i < cachedDriverCount; i++) {
    char key[12];
    snprintf(key, sizeof(key), "d%d_id",   i); p.putString(key, cachedDrivers[i].id);
    snprintf(key, sizeof(key), "d%d_name", i); p.putString(key, cachedDrivers[i].name);
    snprintf(key, sizeof(key), "d%d_pin",  i); p.putString(key, cachedDrivers[i].pin);
  }
  p.end();
}

void upsertDriverCache(const char* id, const char* name, const char* pin) {
  for (int i = 0; i < cachedDriverCount; i++) {
    if (strcmp(cachedDrivers[i].id, id) == 0) {
      strlcpy(cachedDrivers[i].name, name, sizeof(cachedDrivers[i].name));
      strlcpy(cachedDrivers[i].pin,  pin,  sizeof(cachedDrivers[i].pin));
      saveDriverCache();
      Serial.printf("[drvCache] updated driver %s\n", id);
      return;
    }
  }
  if (cachedDriverCount >= MAX_CACHED_DRIVERS) {
    memmove(&cachedDrivers[0], &cachedDrivers[1],
            sizeof(CachedDriver) * (MAX_CACHED_DRIVERS - 1));
    cachedDriverCount = MAX_CACHED_DRIVERS - 1;
  }
  strlcpy(cachedDrivers[cachedDriverCount].id,   id,   sizeof(cachedDrivers[0].id));
  strlcpy(cachedDrivers[cachedDriverCount].name, name, sizeof(cachedDrivers[0].name));
  strlcpy(cachedDrivers[cachedDriverCount].pin,  pin,  sizeof(cachedDrivers[0].pin));
  cachedDriverCount++;
  saveDriverCache();
  Serial.printf("[drvCache] cached driver %s (%s)\n", name, id);
}

// Returns index in cachedDrivers if PIN matches, -1 otherwise
int lookupCachedDriver(const char* pin) {
  for (int i = 0; i < cachedDriverCount; i++) {
    if (strcmp(cachedDrivers[i].pin, pin) == 0) return i;
  }
  return -1;
}

// TRUCK CACHE  -- persisted to NVS "trkCache" namespace
void saveTruckCache() {
  Preferences p; p.begin("trkCache", false);
  p.putInt("count", truckCount);
  for (int i = 0; i < truckCount; i++) {
    char key[12];
    snprintf(key, sizeof(key), "t%d_id",     i); p.putString(key, trucks[i].id.c_str());
    snprintf(key, sizeof(key), "t%d_code",   i); p.putString(key, trucks[i].code.c_str());
    snprintf(key, sizeof(key), "t%d_plate",  i); p.putString(key, trucks[i].plate.c_str());
    snprintf(key, sizeof(key), "t%d_model",  i); p.putString(key, trucks[i].model.c_str());
    snprintf(key, sizeof(key), "t%d_status", i); p.putString(key, trucks[i].status.c_str());
  }
  p.end();
  Serial.printf("[trkCache] saved %d truck(s)\n", truckCount);
}

void loadTruckCache() {
  Preferences p; p.begin("trkCache", false);
  int count = p.getInt("count", 0);
  if (count == 0) { p.end(); return; }
  truckCount = 0;
  for (int i = 0; i < count && i < 10; i++) {
    char key[12], val[64];
    snprintf(key, sizeof(key), "t%d_id",     i); p.getString(key, val, sizeof(val)); trucks[truckCount].id     = String(val);
    snprintf(key, sizeof(key), "t%d_code",   i); p.getString(key, val, sizeof(val)); trucks[truckCount].code   = String(val);
    snprintf(key, sizeof(key), "t%d_plate",  i); p.getString(key, val, sizeof(val)); trucks[truckCount].plate  = String(val);
    snprintf(key, sizeof(key), "t%d_model",  i); p.getString(key, val, sizeof(val)); trucks[truckCount].model  = String(val);
    snprintf(key, sizeof(key), "t%d_status", i); p.getString(key, val, sizeof(val)); trucks[truckCount].status = String(val).isEmpty() ? String("idle") : String(val);
    trucks[truckCount].active = false;  // active status is live -- never stale from cache
    truckCount++;
  }
  p.end();
  Serial.printf("[trkCache] loaded %d cached truck(s)\n", truckCount);
}

// WIFI CREDENTIALS -- NVS "wifiCfg" namespace
void nvsLoadWifi() {
  Preferences p; p.begin("wifiCfg", true);
  nvsWifiSsid = p.getString("ssid", "");
  nvsWifiPass = p.getString("pass", "");
  p.end();
  Serial.printf("[wifi] loaded creds: ssid='%s'\n", nvsWifiSsid.c_str());
}

void nvsSaveWifi(const String& ssid, const String& pass) {
  Preferences p; p.begin("wifiCfg", false);
  p.putString("ssid", ssid);
  p.putString("pass", pass);
  p.end();
  nvsWifiSsid = ssid;
  nvsWifiPass = pass;
  Serial.printf("[wifi] saved creds: ssid='%s'\n", ssid.c_str());
}

bool tryWifiConnect() {
  if (nvsWifiSsid.isEmpty()) return false;
  WiFi.mode(WIFI_STA);
  WiFi.begin(nvsWifiSsid.c_str(), nvsWifiPass.c_str());
  Serial.printf("[wifi] connecting to '%s'...\n", nvsWifiSsid.c_str());
  unsigned long t = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t < 8000) delay(200);
  if (WiFi.status() == WL_CONNECTED) {
    wifiReady = true;
    Serial.printf("[wifi] connected -- IP %s\n", WiFi.localIP().toString().c_str());
    return true;
  }
  WiFi.disconnect(true);
  wifiReady = false;
  Serial.println("[wifi] connection failed -- falling back to GSM");
  return false;
}

String wifiGet(const String& path, unsigned long timeoutMs = 8000) {
  if (!wifiReady || WiFi.status() != WL_CONNECTED) return "";
  Serial.printf("[WIFI] GET start %s heap=%u\n", path.c_str(), (unsigned)ESP.getFreeHeap());
  HTTPClient http;
  String url = String(API_BASE) + path;
  http.begin(url);
  http.addHeader("x-device-key", DEVICE_API_KEY);
  http.setTimeout((int)timeoutMs);
  int code = http.GET();
  String body = (code > 0) ? http.getString() : "";
  http.end();
  if (code >= 200 && code < 300) {
    backendReachable = true;
    gsmLastStatus = code;
    wifiConsecFailures = 0;
    return body;
  }
  if (code > 0) {
    backendReachable = true;
    gsmLastStatus = code;  // expose WiFi status to callers that read gsmLastStatus
    wifiConsecFailures = 0;  // server responded (even if non-2xx) -- WiFi path is healthy
    Serial.printf("[WIFI] GET %s -> %d (non-2xx) body=%s\n", path.c_str(), code, body.substring(0, 80).c_str());
  } else {
    if (++wifiConsecFailures >= 3) {
      wifiBackoffUntilMs = millis() + 30000UL;
      Serial.printf("[WIFI] GET %s fail code=%d -- 3 consecutive failures, backing off WiFi for 30 s\n",
                    path.c_str(), code);
      wifiConsecFailures = 0;
    } else {
      Serial.printf("[WIFI] GET %s fail code=%d (%u/3 before backoff)\n",
                    path.c_str(), code, (unsigned)wifiConsecFailures);
    }
  }
  return "";
}

String wifiPost(const String& path, const String& body, unsigned long timeoutMs = 8000) {
  if (!wifiReady || WiFi.status() != WL_CONNECTED) return "";
  Serial.printf("[WIFI] POST start %s bytes=%u heap=%u\n",
                path.c_str(), (unsigned)body.length(), (unsigned)ESP.getFreeHeap());
  HTTPClient http;
  String url = String(API_BASE) + path;
  http.begin(url);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_API_KEY);
  http.setTimeout((int)timeoutMs);
  int code = http.POST(body);
  String resp = (code > 0) ? http.getString() : "";
  http.end();
  if (code >= 200 && code < 300) {
    backendReachable = true;
    gsmLastStatus = code;
    wifiConsecFailures = 0;
    return resp;
  }
  if (code > 0) {
    backendReachable = true;
    gsmLastStatus = code;  // expose WiFi status to callers that read gsmLastStatus
    wifiConsecFailures = 0;  // server responded -- WiFi path is healthy
    Serial.printf("[WIFI] POST %s -> %d (non-2xx) body=%s\n", path.c_str(), code, resp.substring(0, 80).c_str());
  } else {
    if (++wifiConsecFailures >= 3) {
      wifiBackoffUntilMs = millis() + 30000UL;
      Serial.printf("[WIFI] POST %s fail code=%d -- 3 consecutive failures, backing off WiFi for 30 s\n",
                    path.c_str(), code);
      wifiConsecFailures = 0;
    } else {
      Serial.printf("[WIFI] POST %s fail code=%d (%u/3 before backoff)\n",
                    path.c_str(), code, (unsigned)wifiConsecFailures);
    }
  }
  return "";
}

// ASYNC HTTP -- FreeRTOS task on Core 0
enum HttpJobType {
  HJ_PAUSE, HJ_RESUME, HJ_END,
  HJ_TELEMETRY, HJ_HEALTH, HJ_ALERT, HJ_SNOOZE, HJ_HEARTBEAT, HJ_EXT_TRIP,
  HJ_PENDING_ACK   // POST /device/pending-action/:id/ack -- closes the pending-action loop
};

struct HttpJob {
  HttpJobType   type;
  bool          isPost;
  char          path[80];
  char          body[900];
  int           maxAttempts;
  unsigned long actionTimeoutMs;
};

struct HttpResult {
  HttpJobType type;
  bool        ok;
  int         httpStatus;
  // /device/alerts response carries nav fields, pending_actions[], thresholds, and trip
  char        resp[2048];
  char        body[900];    // original request body -- used to re-buffer failed telemetry
};

QueueHandle_t     gHttpJobQ;    // main -> worker
QueueHandle_t     gHttpDoneQ;   // worker -> main
SemaphoreHandle_t gsmMutex;     // prevents CSQ poll racing with HTTP AT commands
volatile bool     telemetryJobQueued = false;
volatile bool     alertJobQueued     = false;
volatile bool     heartbeatJobQueued = false;
volatile uint32_t telemetryJobQueuedAt = 0;
volatile uint32_t alertJobQueuedAt     = 0;
static const uint32_t STUCK_JOB_MS = 60000UL;

// Hardware objects
TFT_eSPI            tft = TFT_eSPI();

// Touch: tft.getTouchRawZ() + tft.getTouchRaw() via TFT_eSPI's managed SPI

static uint16_t readXpt2046Channel(uint8_t command) {
  // Defensively deassert every other VSPI/MISO device before this read.
  digitalWrite(TFT_CS,        HIGH);
  digitalWrite(LORA_NSS_PIN,  HIGH);
  digitalWrite(CAN_CS_PIN,    HIGH);
  digitalWrite(TOUCH_CS_PIN,  LOW);
  delayMicroseconds(5);
  SPI.beginTransaction(SPISettings(2500000, MSBFIRST, SPI_MODE0));
  SPI.transfer(command);
  uint16_t hi = SPI.transfer(0x00);
  uint16_t lo = SPI.transfer(0x00);
  SPI.endTransaction();
  digitalWrite(TOUCH_CS_PIN, HIGH);
  return ((hi << 8) | lo) >> 3;
}

static bool readTouchRaw(uint16_t *rawX, uint16_t *rawY) {
  if (digitalRead(TOUCH_IRQ_PIN) != LOW) return false;

  uint32_t sumX = 0;
  uint32_t sumY = 0;
  int samples = 0;
  for (int i = 0; i < TOUCH_SAMPLE_COUNT; i++) {
    uint16_t x = readXpt2046Channel(0xD0);
    uint16_t y = readXpt2046Channel(0x90);
    if (x > 0 && x < 4095 && y > 0 && y < 4095) {
      sumX += x;
      sumY += y;
      samples++;
    }
    delay(TOUCH_SAMPLE_DELAY_MS);
  }
  if (samples < TOUCH_MIN_SAMPLES) return false;

  *rawX = sumX / samples;
  *rawY = sumY / samples;
  return true;
}

static bool getFleetTouch(uint16_t *screenX, uint16_t *screenY) {
  uint16_t rawX = 0;
  uint16_t rawY = 0;
  if (!readTouchRaw(&rawX, &rawY)) return false;

  int sx = lroundf(touchCal.ax * rawX + touchCal.bx * rawY + touchCal.cx);
  int sy = lroundf(touchCal.ay * rawX + touchCal.by * rawY + touchCal.cy);
  *screenX = constrain(sx, 0, SCREEN_W - 1);
  *screenY = constrain(sy, 0, SCREEN_H - 1);
  return true;
}

static bool solve3x3(float m[3][4], float out[3]) {
  for (int col = 0; col < 3; col++) {
    int pivot = col;
    for (int row = col + 1; row < 3; row++) {
      if (fabsf(m[row][col]) > fabsf(m[pivot][col])) pivot = row;
    }
    if (fabsf(m[pivot][col]) < 0.0001f) return false;

    if (pivot != col) {
      for (int k = col; k < 4; k++) {
        float tmp = m[col][k];
        m[col][k] = m[pivot][k];
        m[pivot][k] = tmp;
      }
    }

    float div = m[col][col];
    for (int k = col; k < 4; k++) m[col][k] /= div;

    for (int row = 0; row < 3; row++) {
      if (row == col) continue;
      float factor = m[row][col];
      for (int k = col; k < 4; k++) m[row][k] -= factor * m[col][k];
    }
  }

  out[0] = m[0][3];
  out[1] = m[1][3];
  out[2] = m[2][3];
  return true;
}

static bool fitTouchAffine(const uint16_t rx[4], const uint16_t ry[4],
                           const int sx[4], const int sy[4]) {
  float n = 4.0f;
  float sumX = 0, sumY = 0, sumXX = 0, sumYY = 0, sumXY = 0;
  float sumSX = 0, sumSY = 0, sumXSX = 0, sumYSX = 0, sumXSY = 0, sumYSY = 0;

  for (int i = 0; i < 4; i++) {
    float x = rx[i];
    float y = ry[i];
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumYY += y * y;
    sumXY += x * y;
    sumSX += sx[i];
    sumSY += sy[i];
    sumXSX += x * sx[i];
    sumYSX += y * sx[i];
    sumXSY += x * sy[i];
    sumYSY += y * sy[i];
  }

  float mx[3][4] = {
    { sumXX, sumXY, sumX, sumXSX },
    { sumXY, sumYY, sumY, sumYSX },
    { sumX,  sumY,  n,    sumSX  }
  };
  float my[3][4] = {
    { sumXX, sumXY, sumX, sumXSY },
    { sumXY, sumYY, sumY, sumYSY },
    { sumX,  sumY,  n,    sumSY  }
  };
  float xcoef[3];
  float ycoef[3];
  if (!solve3x3(mx, xcoef) || !solve3x3(my, ycoef)) return false;

  touchCal.ax = xcoef[0];
  touchCal.bx = xcoef[1];
  touchCal.cx = xcoef[2];
  touchCal.ay = ycoef[0];
  touchCal.by = ycoef[1];
  touchCal.cy = ycoef[2];
  return true;
}

static void drawCalibrationTarget(int x, int y, int idx) {
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_WHITE, TFT_BLACK);
  tft.drawCentreString("Touch Calibration", SCREEN_W / 2, 48, 4);
  char msg[40];
  snprintf(msg, sizeof(msg), "Tap target %d of 4", idx + 1);
  tft.drawCentreString(msg, SCREEN_W / 2, 88, 2);
  tft.drawLine(x - 18, y, x + 18, y, TFT_RED);
  tft.drawLine(x, y - 18, x, y + 18, TFT_RED);
  tft.drawCircle(x, y, 12, TFT_RED);
}

static bool waitForCalibrationTap(int x, int y, int idx, uint16_t *rawX, uint16_t *rawY) {
  if (digitalRead(TOUCH_IRQ_PIN) == LOW) {
    tft.fillScreen(TFT_BLACK);
    tft.setTextColor(TFT_WHITE, TFT_BLACK);
    tft.drawCentreString("Release screen", SCREEN_W / 2, 130, 4);
    Serial.printf("[touch-cal] waiting release before target %d\n", idx + 1);
    while (digitalRead(TOUCH_IRQ_PIN) == LOW) delay(10);
    delay(500);
  }

  drawCalibrationTarget(x, y, idx);
  Serial.printf("[touch-cal] waiting target %d screen=(%d,%d)\n", idx + 1, x, y);

  uint32_t started     = millis();
  uint32_t lastHeartMs = 0;
  while (millis() - started < 30000) {
    if (readTouchRaw(rawX, rawY)) {
      Serial.printf("[touch-cal] target %d raw=(%u,%u)\n", idx + 1, *rawX, *rawY);
      tft.fillCircle(x, y, 8, TFT_GREEN);
      while (digitalRead(TOUCH_IRQ_PIN) == LOW) delay(10);
      delay(300);
      return true;
    }
    if (millis() - lastHeartMs >= 1000) {
      lastHeartMs = millis();
      int irq = digitalRead(TOUCH_IRQ_PIN);
      uint16_t rx = readXpt2046Channel(0xD0);
      uint16_t ry = readXpt2046Channel(0x90);
      Serial.printf("[touch-cal] heartbeat target %d  T_IRQ=%s  raw_probe=(%u,%u)\n",
                    idx + 1,
                    irq == LOW ? "LOW (pressed)" : "HIGH (released)",
                    rx, ry);
    }
    delay(10);
  }

  Serial.printf("[touch-cal] timeout target %d\n", idx + 1);
  return false;
}

static bool calibrateFleetTouch() {
  const int sx[4] = { 42, SCREEN_W - 43, SCREEN_W - 43, 42 };
  const int sy[4] = { 42, 42, SCREEN_H - 43, SCREEN_H - 43 };
  uint16_t rx[4];
  uint16_t ry[4];

  for (int i = 0; i < 4; i++) {
    if (!waitForCalibrationTap(sx[i], sy[i], i, &rx[i], &ry[i])) return false;
  }

  if (!fitTouchAffine(rx, ry, sx, sy)) {
    Serial.println("[touch-cal] affine solve failed");
    return false;
  }

  // Save to NVS with explicit success verification
  size_t bytesWritten = 0;
  bool   beginOk      = false;
  bool   readbackOk   = false;
  TouchAffineCal verify = {};
  {
    Preferences p;
    beginOk = p.begin("fleet", false);
    if (beginOk) {
      bytesWritten = p.putBytes("touchAffineCal", &touchCal, sizeof(touchCal));
      // Immediately read it back from the same handle to confirm it stuck.
      size_t readSz = p.getBytes("touchAffineCal", &verify, sizeof(verify));
      readbackOk = (readSz == sizeof(verify))
                   && (memcmp(&verify, &touchCal, sizeof(touchCal)) == 0);
      p.end();
    }
  }
  Serial.printf("[touch-cal] NVS save: begin=%s wrote=%u/%u readback=%s\n",
                beginOk ? "OK" : "FAIL",
                (unsigned)bytesWritten, (unsigned)sizeof(touchCal),
                readbackOk ? "OK" : "MISMATCH");
  if (!beginOk || bytesWritten != sizeof(touchCal) || !readbackOk) {
    Serial.println("[touch-cal] WARNING -- calibration was NOT persisted. "
                   "Will re-prompt on next boot.");
    tft.fillScreen(TFT_BLACK);
    tft.setTextColor(TFT_RED, TFT_BLACK);
    tft.drawCentreString("NVS save FAILED", SCREEN_W / 2, 130, 4);
    tft.drawCentreString("Will re-prompt next boot", SCREEN_W / 2, 170, 2);
    delay(2500);
  }
  Serial.printf("[touch-cal] saved affine: x=%.6f*rx + %.6f*ry + %.2f, y=%.6f*rx + %.6f*ry + %.2f\n",
                touchCal.ax, touchCal.bx, touchCal.cx, touchCal.ay, touchCal.by, touchCal.cy);
  tft.fillScreen(TFT_BLACK);
  tft.setTextColor(TFT_GREEN, TFT_BLACK);
  tft.drawCentreString("Calibration saved!", SCREEN_W / 2, 148, 2);
  delay(800);
  return true;
}

// GPS HELPERS
const char *gpsCustomValue(TinyGPSCustom &primary, TinyGPSCustom &fallback) {
  if (primary.isValid() && primary.value()[0]) return primary.value();
  if (fallback.isValid() && fallback.value()[0]) return fallback.value();
  return "--";
}

// Haversine great-circle distance (km) between two WGS-84 points.
static float haversineKm(double lat1, double lon1, double lat2, double lon2) {
  const double R = 6371.0;
  double dlat = (lat2 - lat1) * (M_PI / 180.0);
  double dlon = (lon2 - lon1) * (M_PI / 180.0);
  double a = sin(dlat / 2) * sin(dlat / 2)
           + cos(lat1 * (M_PI / 180.0)) * cos(lat2 * (M_PI / 180.0))
           * sin(dlon / 2) * sin(dlon / 2);
  return (float)(R * 2.0 * asin(sqrt(a)));
}

void pollGPS() {
  static unsigned long lastGpsDiag  = 0;
  static unsigned long gpsRawBytes  = 0;   // total bytes received from GPS UART

  // Drain UART into TinyGPSPlus, count raw bytes for diagnostics
  while (gpsSerial.available()) {
    gps.encode(gpsSerial.read());
    gpsRawBytes++;
  }

  if (gps.location.isValid() && gps.location.isUpdated()) {
    double newLat = gps.location.lat();
    double newLon = gps.location.lng();
    gpsSpeedKmh = gps.speed.isValid() ? gps.speed.kmph() : 0.0;
    if (!gpsFix) Serial.printf("[GPS] fix acquired: %.6f, %.6f\n", newLat, newLon);

    // Accumulate Haversine distance since last telemetry send for Model C.
    if (gpsPrevValid && gpsSpeedKmh > 3.0f) {
      float segKm = haversineKm(gpsPrevLat, gpsPrevLon, newLat, newLon);
      if (segKm < 0.5f) telGpsDistKm += segKm;
    }
    gpsPrevLat   = newLat;
    gpsPrevLon   = newLon;
    gpsPrevValid = true;

    gpsLat        = newLat;
    gpsLon        = newLon;
    gpsFix        = true;
    gpsEverHadFix = true;
    lastGpsFix    = millis();
  }

  if (gpsFix && (millis() - lastGpsFix > GPS_FIX_TIMEOUT_MS)) {
    gpsFix = false;
    Serial.println("[GPS] fix lost");
  }

  // Periodic diagnostic -- every 5 s
  if (millis() - lastGpsDiag >= 5000) {
    lastGpsDiag = millis();
    Serial.println(F("-------- [GPS DIAG] --------"));
    Serial.printf("  Raw bytes received : %lu\n", gpsRawBytes);
    Serial.printf("  TinyGPS chars proc : %lu\n", gps.charsProcessed());
    Serial.printf("  Sentences OK/Failed: %lu / %lu\n",
                  gps.passedChecksum(), gps.failedChecksum());
    Serial.printf("  RMC status         : %s\n",
                  gpsCustomValue(gpsRmcStatusGN, gpsRmcStatusGP));
    Serial.printf("  GGA fix quality    : %s\n",
                  gpsCustomValue(gpsGgaFixQualityGN, gpsGgaFixQualityGP));
    Serial.printf("  GSA fix type       : %s\n",
                  gpsCustomValue(gpsGsaFixTypeGN, gpsGsaFixTypeGP));
    Serial.printf("  Sats in view (GSV) : %s\n",
                  gpsCustomValue(gpsGsvSatsInViewGN, gpsGsvSatsInViewGP));
    Serial.printf("  Sats used (GGA)    : %s (%d)\n",
                  gps.satellites.isValid() ? "valid" : "invalid",
                  gps.satellites.isValid() ? (int)gps.satellites.value() : 0);
    Serial.printf("  HDOP               : %s (%.2f)\n",
                  gps.hdop.isValid() ? "valid" : "invalid",
                  gps.hdop.isValid() ? gps.hdop.hdop() : 0.0);
    Serial.printf("  Location valid     : %s\n", gps.location.isValid() ? "YES" : "no");
    Serial.printf("  Fix active         : %s\n", gpsFix ? "YES" : "no");
    if (gpsFix)
      Serial.printf("  Position           : %.6f, %.6f  speed %.1f km/h\n",
                    gpsLat, gpsLon, gpsSpeedKmh);
    if (gpsRawBytes == 0)
      Serial.println(F("  *** NO DATA from GPS UART -- check TX wiring on GPIO16 ***"));
    else if (!gps.location.isValid())
      Serial.println(F("  *** NMEA data OK but no fix yet -- move near a window/outdoors ***"));
    Serial.println(F("----------------------------"));
  }
}

GpsStatus computeGpsStatus() {
  if (!gpsFix) {
    // Before the first fix is ever acquired, always show SEARCHING.
    if (gpsEverHadFix && (state == TRIP_ACTIVE || state == TRIP_PAUSED)) return GPS_LOST;
    return GPS_SEARCHING;
  }
  if (state == TRIP_ACTIVE || state == TRIP_PAUSED) return GPS_ACTIVE;
  return GPS_READY;
}

const char* gpsStatusLabel(GpsStatus s) {
  switch (s) {
    case GPS_READY:     return "GPS: Ready";
    case GPS_ACTIVE:    return "GPS: Active";
    case GPS_LOST:      return "GPS: Lost";
    default:            return "GPS: Searching";
  }
}

const char* gpsShortStatusLabel(GpsStatus s) {
  switch (s) {
    case GPS_READY:     return "READY";
    case GPS_ACTIVE:    return "ACTIVE";
    case GPS_LOST:      return "LOST";
    default:            return "SEARCHING";
  }
}

uint16_t gpsStatusColor(GpsStatus s) {
  switch (s) {
    case GPS_READY:  return C_ACCENT;
    case GPS_ACTIVE: return C_GREEN;
    case GPS_LOST:   return C_RED;
    default:         return C_ORANGE;
  }
}

// FORWARD DECLARATIONS
void screenTripPaused();
void screenTripActive();
void screenTripEnded(unsigned long secs);
void screenReady();
void queueTripEvent(HttpJobType type, const char* path, const String& tripId);
void processAlertResponse(const String& resp);
bool flushTelemetryBuffer();
void flushSpiffsEventLog();
void queueEndTrip(const String& tripId, const String& endTime);
void flushPendingTripEnd();
void queueSnoozeEvent(const String& tripId);
void spiffsLogEvent(const char* type, const String& tripId, const String& evTime);
void nvsSavePendingTripBody(const String& body);

// BUZZER
#define BUZZER_LEDC_CHANNEL 6
#define BUZZER_LEDC_FREQ    2000
#define BUZZER_LEDC_RES     8
#define BUZZER_QUIET_DUTY   0
#define BUZZER_SILENT_DUTY  255

void buzzerOff() { ledcWrite(BUZZER_LEDC_CHANNEL, BUZZER_SILENT_DUTY); }
void buzzerOn()  { ledcWrite(BUZZER_LEDC_CHANNEL, BUZZER_QUIET_DUTY);  }

// Original signature preserved -- freq is intentionally ignored on an active
void buzzerTone(unsigned int , unsigned int ms) {
  buzzerOn();
  delay(ms);
  buzzerOff();
}

// Rhythmic patterns -- distinguishable by RHYTHM, not pitch
void beepOk()    { buzzerTone(0,  40); }                              // tiny tick
void beepAck()   { buzzerTone(0, 200); }                              // single audible action confirm -- REST / RESUME button press
void beepError() {                                                     // three quick blips
  for (int i = 0; i < 3; i++) { buzzerTone(0, 60); delay(80); }
}
void beepAlert() {                                                     // urgent dit-dit-dit-dit
  for (int i = 0; i < 4; i++) { buzzerTone(0, 80); delay(100); }
}
void beepBoot()  { buzzerTone(0, 50); delay(80); buzzerTone(0, 50); }  // two quick taps
void beepDone()  {
  buzzerTone(0, 50); delay(70);
  buzzerTone(0, 50); delay(70);
  buzzerTone(0, 180);
}

// TIMER
String getTimestamp();

unsigned long tripElapsedSec() {
  unsigned long p = pausedTotal;
  if (state == TRIP_PAUSED) p += (millis() - pauseStart);
  // Guard against unsigned underflow when the restored clock has
  unsigned long elapsed = millis() - tripStart;
  if (p >= elapsed) return 0;
  return (elapsed - p) / 1000UL;
}
void formatTime(unsigned long s, char* buf) {
  sprintf(buf, "%02lu:%02lu:%02lu", s / 3600, (s % 3600) / 60, s % 60);
}

time_t parseIsoUtc(const String& iso) {
  if (iso.length() < 19) return 0;
  struct tm ti = {};
  int yr, mo, dy, hr, mn, sc;
  if (sscanf(iso.c_str(), "%d-%d-%dT%d:%d:%d", &yr, &mo, &dy, &hr, &mn, &sc) != 6)
    return 0;
  ti.tm_year = yr - 1900;
  ti.tm_mon  = mo - 1;
  ti.tm_mday = dy;
  ti.tm_hour = hr;
  ti.tm_min  = mn;
  ti.tm_sec  = sc;
  ti.tm_isdst = 0;
  return mktime(&ti);
}

void restoreServerTripClock() {
  unsigned long wallMs = 0;
  unsigned long restMs = 0;
  unsigned long pauseMs = 0;
  time_t startEpoch = parseIsoUtc(activeTripStartIso);
  // Fall back to local RTC only if server_now wasn't received.
  time_t nowEpoch = (!serverNowIso.isEmpty())
    ? parseIsoUtc(serverNowIso)
    : parseIsoUtc(getTimestamp());

  if (activeTripDrivingSeconds >= 0) {
    unsigned long drivingMs = (unsigned long)activeTripDrivingSeconds * 1000UL;
    restMs = activeTripRestSeconds * 1000UL;
    wallMs = drivingMs + restMs;
  } else if (startEpoch > 0 && nowEpoch > startEpoch) {
    unsigned long wallSec = (unsigned long)(nowEpoch - startEpoch);
    wallMs = wallSec * 1000UL;
    restMs = activeTripRestSeconds * 1000UL;
    if (restMs > wallMs) restMs = wallMs;
  }

  if (activeTripStatus == "paused") {
    time_t pausedEpoch = parseIsoUtc(activeTripPausedIso);
    if (pausedEpoch > 0 && nowEpoch > pausedEpoch) {
      unsigned long pauseSec = (unsigned long)(nowEpoch - pausedEpoch);
      pauseMs = pauseSec * 1000UL;
      if (pauseMs > wallMs) pauseMs = 0;
    }
  }

  tripStart = wallMs > 0 ? (millis() - wallMs) : millis();
  pausedTotal = restMs;
  if (activeTripStatus == "paused") pauseStart = millis() - pauseMs;
  if (activeTripStatus == "active") {
    unsigned long sinceRestMs = 0;
    // Prefer the HMI's own saved "since last rest" -- accurate across USB
    if (activeTripSinceRestSeconds >= 0) {
      sinceRestMs = (unsigned long)activeTripSinceRestSeconds * 1000UL;
      if (sinceRestMs > restThresholdMs) sinceRestMs = restThresholdMs;
    } else {
      time_t nextRestEpoch = parseIsoUtc(activeTripNextRestAlertIso);
      if (nextRestEpoch > nowEpoch) {
        unsigned long remainingMs = (unsigned long)(nextRestEpoch - nowEpoch) * 1000UL;
        sinceRestMs = (remainingMs < restThresholdMs) ? (restThresholdMs - remainingMs) : 0;
      } else if (wallMs > restMs) {
        unsigned long drivingMs = wallMs - restMs;
        sinceRestMs = (drivingMs < restThresholdMs) ? drivingMs : restThresholdMs;
      }
    }
    lastRestMs = (millis() > sinceRestMs) ? (millis() - sinceRestMs) : 0;
  } else {
    lastRestMs = millis();
  }
  if (obdTripIntegratedKm < 0.0f) {
    obdTripIntegratedKm = 0.0f;
    Serial.println("[trip] obdTripIntegratedKm armed at 0 km (resumed/adopted trip)");
  }
  if (gpsTripIntegratedKm < 0.0f) {
    gpsTripIntegratedKm = 0.0f;
    Serial.println("[trip] gpsTripIntegratedKm armed at 0 km (resumed/adopted trip)");
  }
  // Idempotent: re-loading the same truck just refreshes the in-memory value.
  if (!selectedTruckId.isEmpty()) {
    nvsLoadTruckLifetimeKm(selectedTruckId);
  }
  Serial.printf("[trip] restored clock wall=%lus rest=%lus pause=%lus sinceRest=%lus status=%s\n",
                wallMs / 1000UL, restMs / 1000UL, pauseMs / 1000UL,
                (millis() - lastRestMs) / 1000UL, activeTripStatus.c_str());
}

String fitText(String s, int maxChars) {
  if ((int)s.length() <= maxChars) return s;
  if (maxChars <= 3) return s.substring(0, maxChars);
  return s.substring(0, maxChars - 3) + "...";
}

// UI PRIMITIVES
uint16_t rgb565Blend(uint16_t c, uint8_t amount, bool lighten) {
  uint8_t r = (c >> 11) & 0x1F;
  uint8_t g = (c >> 5)  & 0x3F;
  uint8_t b =  c        & 0x1F;
  if (lighten) {
    r += ((31 - r) * amount) / 255;
    g += ((63 - g) * amount) / 255;
    b += ((31 - b) * amount) / 255;
  } else {
    r = (r * (255 - amount)) / 255;
    g = (g * (255 - amount)) / 255;
    b = (b * (255 - amount)) / 255;
  }
  return (r << 11) | (g << 5) | b;
}

uint16_t uiLight(uint16_t c, uint8_t amount) { return rgb565Blend(c, amount, true); }
uint16_t uiDark(uint16_t c, uint8_t amount)  { return rgb565Blend(c, amount, false); }

void drawSoftCard(int x, int y, int w, int h, uint16_t accent = C_ACCENT, bool active = false) {
  tft.fillRoundRect(x + 2, y + 3, w, h, 8, C_DIV);  // light grey shadow
  tft.fillRoundRect(x, y, w, h, 8, C_CARD);
  tft.fillRect(x + 2, y + 2, 4, h - 4, accent);
  tft.drawRoundRect(x, y, w, h, 8, active ? accent : C_DIV);
}

void drawStatusPill(int x, int y, int w, const char* lbl, uint16_t col) {
  tft.fillRoundRect(x, y, w, 18, 7, uiDark(col, 160));
  tft.drawRoundRect(x, y, w, 18, 7, uiDark(col, 70));
  tft.fillCircle(x + 10, y + 9, 3, col);
  tft.setTextColor(col);
  tft.drawString(lbl, x + 18, y + 5, 1);
}

void drawBtn(int x, int y, int w, int h, const char* lbl, uint32_t col) {
  uint16_t base = (uint16_t)col;
  tft.fillRoundRect(x + 2, y + 3, w, h, 10, C_DIV);
  tft.fillRoundRect(x, y, w, h, 10, base);
  tft.fillRoundRect(x + 2, y + 2, w - 4, h / 2, 8, uiLight(base, 42));
  tft.drawRoundRect(x, y, w, h, 10, uiLight(base, 92));
  tft.drawFastHLine(x + 14, y + h - 3, w - 28, uiDark(base, 72));
  tft.setTextColor(TFT_WHITE);
  tft.drawCentreString(lbl, x + w / 2, y + (h - tft.fontHeight(4)) / 2, 4);
}
void drawSmallBtn(int x, int y, int w, int h, const char* lbl, uint32_t col) {
  uint16_t base = (uint16_t)col;
  tft.fillRoundRect(x + 1, y + 2, w, h, 7, C_DIV);
  tft.fillRoundRect(x, y, w, h, 7, base);
  tft.fillRoundRect(x + 1, y + 1, w - 2, h / 2, 6, uiLight(base, 34));
  tft.drawRoundRect(x, y, w, h, 7, uiLight(base, 72));
  tft.setTextColor(TFT_WHITE);
  tft.drawCentreString(lbl, x + w / 2, y + (h - tft.fontHeight(2)) / 2, 2);
}
bool inBtn(int sx, int sy, int x, int y, int w, int h) {
  return sx >= x && sx <= (x + w) && sy >= y && sy <= (y + h);
}

// Draws a thick arc ring segment using fillTriangle approximation.
void drawThickArc(int cx, int cy, int ro, int thick, float startDeg, float endDeg, uint16_t col) {
  if (endDeg <= startDeg) return;
  float total = endDeg - startDeg;
  int steps = max(6, (int)(ro * total * 0.0175f));  // ~1 step per 2px of arc length
  float prev_a = (startDeg - 90.0f) * 0.017453f;
  for (int i = 1; i <= steps; i++) {
    float curr_a = ((startDeg + (float)i / (float)steps * total) - 90.0f) * 0.017453f;
    float cpA = cosf(prev_a), spA = sinf(prev_a);
    float cpB = cosf(curr_a), spB = sinf(curr_a);
    int x1o = cx + (int)(cpA * ro),       y1o = cy + (int)(spA * ro);
    int x2o = cx + (int)(cpB * ro),       y2o = cy + (int)(spB * ro);
    int ri  = ro - thick;
    int x1i = cx + (int)(cpA * ri),       y1i = cy + (int)(spA * ri);
    int x2i = cx + (int)(cpB * ri),       y2i = cy + (int)(spB * ri);
    tft.fillTriangle(x1o, y1o, x2o, y2o, x1i, y1i, col);
    tft.fillTriangle(x2o, y2o, x2i, y2i, x1i, y1i, col);
    prev_a = curr_a;
  }
}

// Draws signal strength bars (4 bars, increasing height).
void drawSignalBars(int x, int y, int rssi, uint16_t col) {
  int strength = 0;
  if (rssi > 0 && rssi != 99) strength = (rssi > 20) ? 4 : (rssi > 12) ? 3 : (rssi > 5) ? 2 : 1;
  for (int i = 0; i < 4; i++) {
    int bh = 4 + i * 3;
    int bx = x + i * 5;
    int by = y + 12 - bh;
    tft.fillRect(bx, by, 3, bh, (i < strength) ? col : C_DIM2);
  }
}

// WiFi/Settings button -- far right of status bar, clear of GSM/WiFi/LoRa indicators.
#define STATUS_H     38
#define WIFI_BTN_X  382
#define WIFI_BTN_Y    4
#define WIFI_BTN_W   90
#define WIFI_BTN_H   30

void drawWifiGlyph(int x, int y, uint16_t col) {
  tft.fillCircle(x, y + 12, 2, col);
  tft.drawLine(x - 6, y + 8, x, y + 4, col);
  tft.drawLine(x, y + 4, x + 6, y + 8, col);
  tft.drawLine(x - 11, y + 4, x, y - 3, col);
  tft.drawLine(x, y - 3, x + 11, y + 4, col);
}

void drawStatusBar() {
  tft.fillRect(0, 0, SCREEN_W, STATUS_H, C_BAR);
  tft.fillRect(0, STATUS_H - 1, SCREEN_W, 1, uiDark(C_DIV, 60));

  // Left: Brand + truck/driver identifier
  tft.setTextColor(C_TEXT);
  tft.drawString("FM", 8, 11, 2);
  tft.setTextColor(C_ACCENT);
  tft.drawString("HMI", 30, 11, 2);
  if (!selectedTruckCode.isEmpty()) {
    tft.setTextColor(C_TEXT);
    tft.drawString(fitText(selectedTruckCode, 8).c_str(), 70, 11, 2);
  }

  // Center: connectivity indicators
  int cx = 142;
  // GSM signal bars
  int sig = (gsmRssi == 99 || gsmRssi == 0) ? 0 : gsmRssi;
  uint16_t gsmCol = gsmReady ? (backendReachable ? (uint16_t)C_GREEN : (uint16_t)C_ORANGE) : (uint16_t)C_DIM2;
  drawSignalBars(cx, 12, gsmReady ? sig : 0, gsmCol);
  tft.setTextColor(gsmCol);
  tft.drawString("CELL", cx + 23, 14, 1);  // covers both LTE and 2G fallback

  // WiFi indicator dot
  uint16_t wCol = wifiReady ? (uint16_t)C_GREEN : (uint16_t)C_DIM2;
  tft.fillCircle(cx + 85, 19, 4, wCol);
  tft.setTextColor(wCol);
  tft.drawString("WiFi", cx + 93, 14, 1);

  // LoRa indicator
  uint16_t lCol = loraReady ? (uint16_t)C_ACCENT : (uint16_t)C_DIM2;
  tft.fillCircle(cx + 143, 19, 4, lCol);
  tft.setTextColor(lCol);
  tft.drawString("LoRa", cx + 151, 14, 1);

  // Right: WiFi button (tap -> settings) + mobile companion + time
  uint16_t wBg  = wifiReady ? (uint16_t)C_BTN : (uint16_t)C_PANEL;
  uint16_t wBdr = wifiReady ? (uint16_t)C_ACCENT : (uint16_t)C_DIV;
  uint16_t wTxt = wifiReady ? (uint16_t)C_WHITE : (uint16_t)C_ACCENT;
  tft.fillRoundRect(WIFI_BTN_X, WIFI_BTN_Y, WIFI_BTN_W, WIFI_BTN_H, 7, wBg);
  tft.drawRoundRect(WIFI_BTN_X, WIFI_BTN_Y, WIFI_BTN_W, WIFI_BTN_H, 7, wBdr);
  tft.setTextColor(wTxt);
  drawWifiGlyph(WIFI_BTN_X + 18, WIFI_BTN_Y + 9, wTxt);
  tft.drawString(wifiReady ? "ON" : "WiFi", WIFI_BTN_X + 34, WIFI_BTN_Y + 9, 2);

  tft.fillRect(0, STATUS_H - 1, SCREEN_W, 1, uiDark(C_DIV, 60));
}

bool inWifiStatusBtn(int sx, int sy) {
  return inBtn(sx, sy, WIFI_BTN_X, WIFI_BTN_Y, WIFI_BTN_W, WIFI_BTN_H);
}

void drawGradientBg() {
  tft.fillScreen(C_BG);
}

void drawPageHeader(const char* title, uint32_t titleCol) {
  drawStatusBar();
  tft.fillRect(0, STATUS_H, SCREEN_W, 42, C_SURFACE);
  tft.fillRect(0, STATUS_H + 41, SCREEN_W, 1, C_DIV);
  tft.setTextColor((uint16_t)titleCol);
  tft.drawCentreString(title, SCREEN_W / 2, STATUS_H + 7, 4);
}

#define BACK_X   8
#define BACK_Y  270
#define BACK_W  112
#define BACK_H   44

void drawBackBtn(const char* lbl = "< BACK") {
  drawSmallBtn(BACK_X, BACK_Y, BACK_W, BACK_H, lbl, C_LOGOUT);
}

// Forward declarations -- defined after gsmReconnect/gsmInit
String gsmPost(const String& path, const String& body, int maxAttempts = 3, unsigned long actionTimeoutMs = 30000, TickType_t mutexTimeout = pdMS_TO_TICKS(15000));
String gsmGet(const String& path, int maxAttempts = 3, unsigned long actionTimeoutMs = 30000);

// HTTP -- WiFi first (if connected), GSM fallback.
String httpPost(const String& path, const String& body, int maxAttempts = 3, unsigned long actionTimeoutMs = 30000) {
  gsmLastStatus = 0;
  // Skip WiFi during backoff window -- accumulated wifiPost failures indicated
  bool wifiUsable = wifiReady && millis() >= wifiBackoffUntilMs;
  if (wifiUsable) {
    String r = wifiPost(path, body, min((unsigned long)8000, actionTimeoutMs));
    if (!r.isEmpty()) return r;
  }
  return gsmPost(path, body, maxAttempts, actionTimeoutMs);
}

String httpGet(const String& path, int maxAttempts = 3, unsigned long actionTimeoutMs = 30000) {
  gsmLastStatus = 0;  // see httpPost -- prevents stale-status false success
  bool wifiUsable = wifiReady && millis() >= wifiBackoffUntilMs;
  if (wifiUsable) {
    String r = wifiGet(path, min((unsigned long)8000, actionTimeoutMs));
    if (!r.isEmpty()) return r;
  }
  return gsmGet(path, maxAttempts, actionTimeoutMs);
}

void healthCheck() {
  // Nothing to do here -- the flag updates itself on every real request.
}

// Polls GET /device/trip/active/:truck_id every EXTERNAL_TRIP_CHECK_MS while
void checkExternalTrip() {
  if (selectedTruckId.isEmpty() || !isOnline || !wifiReady) return;

  String path = "/device/trip/active/" + selectedTruckId;
  String resp = wifiGet(path, 2500);

  if (resp.isEmpty()) {
    if (!externalTripId.isEmpty()) {
      externalTripId     = "";
      externalDriverId   = "";
      externalDriverName = "";
      externalTripStart  = "";
      externalPausedAt   = "";
      externalNextRestAlert = "";
      externalRestSeconds = 0;
      externalChannel    = "";
      Serial.println("[ext-trip] no active trip on server -- banner cleared");
      // Redraw READY screen to remove banner
      if (state == READY) screenReady();
    }
    return;
  }

  JsonDocument doc;
  if (deserializeJson(doc, resp) != DeserializationError::Ok) return;

  String newTripId = doc["trip_id"].as<String>();
  if (newTripId.isEmpty()) return;

  bool changed = (newTripId != externalTripId);
  externalTripId     = newTripId;
  externalDriverId   = doc["driver_id"].as<String>();
  externalDriverName = doc["driver_name"].as<String>();
  externalTripStart  = doc["start_time"].as<String>();
  externalPausedAt   = doc["paused_at"].as<String>();
  externalNextRestAlert = doc["next_rest_alert_at"].as<String>();
  externalRestSeconds = doc["total_rest_seconds"] | 0;
  externalChannel    = doc["channel_used"].as<String>();
  activeTripStatus   = doc["trip_status"] | "active";

  Serial.printf("[ext-trip] detected trip=%s driver=%s channel=%s\n",
    externalTripId.c_str(), externalDriverName.c_str(), externalChannel.c_str());

  if (changed && state == READY) {
    screenReady();  // redraw READY screen; main loop will auto-adopt on next iteration
  }
}

bool loraEventSend(const String& path, const String& jsonBody, const String& eventId, bool allowTouchAbort = true) {
  if (!loraReady) return false;
  if (loraGatewayBackoffActive()) {
    Serial.printf("[LoRa] gateway backoff active -- %s goes directly to cellular/WiFi\n", eventId.c_str());
    return false;
  }

  // Compose LoRa packet: inject path and event_id into the payload
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, jsonBody);
  if (err) {
    // If body isn't parseable JSON, send raw with envelope
    String pkt = "{\"eid\":\"" + eventId + "\",\"path\":\"" + path + "\",\"raw\":1}";
    LoRa.beginPacket();
    LoRa.print(pkt);
    LoRa.endPacket(false);  // blocking send
  } else {
    // Compress long field names to short ones -- SX1278 MTU is 255 bytes.
    auto renameKey = [&doc](const char* from, const char* to) {
      JsonVariant v = doc[from];
      if (!v.isNull() && doc[to].isNull()) {
        doc[to] = v;
        doc.remove(from);
      }
    };
    renameKey("truck_id",     "vid");
    renameKey("driver_id",    "did");
    renameKey("trip_id",      "tid");
    renameKey("event_id",     "eid");
    renameKey("start_time",   "st");
    renameKey("end_time",     "et");
    renameKey("channel_used", "ch");
    renameKey("speed",        "spd");
    renameKey("fuel_level",   "fuel");

    doc["eid"]  = eventId;
    doc["path"] = path;
    String pkt;
    serializeJson(doc, pkt);
    if (pkt.length() > 220) {
      // Still oversized -- trim optional fields to fit LoRa MTU
      doc.remove("notes");
      doc.remove("model_source");
      doc.remove("ch");
      serializeJson(doc, pkt);
    }
    if (pkt.length() > 250) {
      Serial.printf("[LoRa] WARN packet %u bytes -- may truncate at MTU 255\n", pkt.length());
    }
    LoRa.beginPacket();
    LoRa.print(pkt);
    LoRa.endPacket(false);
  }

  // Wait for ACK from gateway: "ACK:<event_id>"
  extern std::vector<String> loraInboundQueue;
  String expectedAck = "ACK:" + eventId;
  unsigned long t0 = millis();
  while (millis() - t0 < LORA_ACK_TIMEOUT_MS) {
    esp_task_wdt_reset();  // prevent TWDT reset during 2s ACK wait
    if (allowTouchAbort && (millis() - t0) > 250 && digitalRead(TOUCH_IRQ_PIN) == LOW) {
      Serial.printf("[LoRa] ACK wait aborted by touch for %s -- deferring to GSM\n", eventId.c_str());
      lastCommChannel = CH_LORA_NO_ACK;
      lastLoraFailMs  = millis();
      return false;
    }
    int pktSize = LoRa.parsePacket();
    if (pktSize > 0) {
      String incoming = "";
      while (LoRa.available()) incoming += (char)LoRa.read();
      incoming.trim();
      if (incoming == expectedAck) {
        lastCommChannel = CH_LORA_OK;
        lastLoraOkMs    = millis();   // refresh the "LoRa gateway is alive" timestamp
        lastLoraFailMs  = 0;
        Serial.printf("[LoRa] ACK received for %s\n", eventId.c_str());
        return true;
      }
      if (incoming.length() > 0) {
        loraInboundQueue.push_back(incoming);
        Serial.printf("[LoRa] queued out-of-band packet (%d bytes) for main-loop dispatch\n",
                      incoming.length());
      }
    }
    delay(10);
  }
  lastCommChannel = CH_LORA_NO_ACK;
  lastLoraFailMs  = millis();
  Serial.printf("[LoRa] No ACK for %s -- falling back to GSM\n", eventId.c_str());
  return false;
}

// BIDIRECTIONAL LORA -- downlink listener + command dispatch.
std::vector<String> loraInboundQueue;     // populated by loraEventSend; drained by checkLoRaIncoming

String   loraNavInstr     = "";
int      loraNavDistM     = -1;
String   loraNavType      = "";   // 'right' / 'left' / 'straight' / 'arrive'
String   loraNavStreet    = "";   // upcoming road name
uint32_t loraNavUpdatedAt = 0;    // millis() -- UI uses this to draw "fresh"/"stale"

void refreshCompanionBadge();
void refreshNavPanel();

void sendLoraAck(const String& eid) {
  if (eid.length() == 0) return;
  String ack = "ACK:" + eid;
  LoRa.beginPacket();
  LoRa.print(ack);
  LoRa.endPacket(false);
  LoRa.receive();
  Serial.printf("[LoRa] ACK sent: %s\n", ack.c_str());
}

// Dispatch a parsed downlink command to its handler.
// Returns true if the command was recognised and executed successfully.
bool dispatchLoraDownlink(const String& cmd, JsonDocument& doc) {
  if (cmd == "rest") {
    if (activeTripId.isEmpty()) return false;
    activeTripStatus = "paused";
    if (state == TRIP_ACTIVE || state == READY) {
      state = TRIP_PAUSED;
      pauseStart = millis();   // start the local pause clock so hmi_rest_sec ticks
      pendingScreenRedraw = SCR_TRIP_PAUSED;
    }
    nvsSaveActiveTrip();
    Serial.println("[DL] cmd=rest -> entered paused state");
    return true;
  }
  if (cmd == "resume") {
    if (activeTripId.isEmpty()) return false;
    activeTripStatus = "active";
    if (state == TRIP_PAUSED) {
      state = TRIP_ACTIVE;
      if (pauseStart > 0) { pausedTotal += millis() - pauseStart; pauseStart = 0; }
      lastRestMs = millis();
      pendingScreenRedraw = SCR_TRIP_ACTIVE;
    }
    nvsSaveActiveTrip();
    Serial.println("[DL] cmd=resume -> resumed");
    return true;
  }
  if (cmd == "end_trip") {
    if (activeTripId.isEmpty()) return false;
    Serial.println("[DL] cmd=end_trip -> ending trip locally");
    unsigned long total = tripElapsedSec();
    activeTripId          = "";
    activeTripStatus      = "ended";
    activeTripStartIso    = "";
    activeTripPausedIso   = "";
    activeTripNextRestAlertIso = "";
    activeTripRestSeconds = 0;
    activeTripDrivingSeconds = -1;
    activeTripSinceRestSeconds = -1;
    nvsClearActiveTrip();
    state = TRIP_ENDED;
    // WiFi pending actions are dispatched inside processAlertResponse(), which
    pendingTripEndedSeconds = total;
    pendingScreenRedraw = SCR_TRIP_ENDED;
    return true;
  }
  if (cmd == "snooze") {
    JsonVariant dv = doc["data"];
    uint32_t durMs = dv["duration_ms"] | 600000U;
    restAlertSnoozedUntil = millis() + durMs;
    Serial.printf("[DL] cmd=snooze -> snoozed for %lums\n", (unsigned long)durMs);
    return true;
  }
  if (cmd == "nav_update") {
    JsonVariant dv = doc["data"];
    loraNavInstr     = String((const char*)(dv["instr"]  | ""));
    loraNavDistM     = dv["dist"] | -1;
    loraNavType      = String((const char*)(dv["type"]   | ""));
    loraNavStreet    = String((const char*)(dv["street"] | ""));
    loraNavUpdatedAt = millis();
    if (!loraNavInstr.isEmpty()) navStepInstruction = loraNavInstr;
    navStepDistM = (loraNavDistM > 0) ? (uint32_t)loraNavDistM : 0;
    if (!loraNavType.isEmpty()) navStepType = (int8_t)loraNavType.toInt();
    if (!loraNavStreet.isEmpty()) navNextStreet = loraNavStreet;
    if (navDestination.isEmpty() && (!loraNavInstr.isEmpty() || navStepDistM > 0))
      navDestination = "Mobile Navigation";
    Serial.printf("[DL] cmd=nav_update -> %s in %dm on %s (%s)\n",
                  loraNavInstr.c_str(), loraNavDistM,
                  loraNavStreet.c_str(), loraNavType.c_str());
    if (state == TRIP_ACTIVE || state == TRIP_PAUSED) refreshNavPanel();
    return true;
  }
  if (cmd == "companion_update") {
    JsonVariant dv = doc["data"];
    bool newCompanion = dv["active"] | false;
    if (newCompanion != mobileCompanionActive) {
      mobileCompanionActive = newCompanion;
      Serial.printf("[DL] cmd=companion_update -> mobile=%s\n", mobileCompanionActive ? "true" : "false");
      if (state == TRIP_ACTIVE || state == TRIP_PAUSED) refreshCompanionBadge();
    }
    return true;
  }
  if (cmd == "threshold_update") {
    JsonVariant dv = doc["data"];
    uint32_t newMs = dv["rest_threshold_ms"] | 0;
    if (newMs > 0 && newMs != restThresholdMs) {
      restThresholdMs = newMs;
      Serial.printf("[DL] cmd=threshold_update -> restThresholdMs=%lu\n", (unsigned long)newMs);
    }
    return true;
  }
  if (cmd == "maintenance_alert") {
    JsonVariant dv = doc["data"];
    const char* msg = dv["message"] | "Maintenance required";
    Serial.printf("[DL] cmd=maintenance_alert -> %s\n", msg);
    return true;
  }
  if (cmd == "restricted_zone" || cmd == "truck_restricted_zone") {
    JsonVariant dv = doc["data"];
    const char* zn = dv["zone_name"]  | "restricted zone";
    int distM      = dv["distance_m"] | -1;
    Serial.printf("[DL] cmd=%s -> near %s (%dm)\n", cmd.c_str(), zn, distM);
    return true;
  }
  Serial.printf("[DL] cmd=%s UNKNOWN -- ACK without action\n", cmd.c_str());
  return false;
}

// Pending-action HTTP path
constexpr size_t PENDING_ACK_HISTORY = 12;
String pendingAckRecent[PENDING_ACK_HISTORY];
uint8_t pendingAckRecentIdx = 0;

bool pendingActionRecentlyHandled(const String& id) {
  for (size_t i = 0; i < PENDING_ACK_HISTORY; i++) {
    if (pendingAckRecent[i] == id) return true;
  }
  return false;
}
void rememberPendingActionHandled(const String& id) {
  pendingAckRecent[pendingAckRecentIdx] = id;
  pendingAckRecentIdx = (pendingAckRecentIdx + 1) % PENDING_ACK_HISTORY;
}

// Queue POST /device/pending-action/<id>/ack via the http worker (Core 0).
// Non-blocking; success/failure shows up in processHttpDone() as HJ_PENDING_ACK.
void queuePendingActionAck(const String& actionId, bool success) {
  if (actionId.isEmpty()) return;
  HttpJob job = {};
  job.type = HJ_PENDING_ACK;
  job.isPost = true;
  snprintf(job.path, sizeof(job.path), "/device/pending-action/%s/ack", actionId.c_str());
  snprintf(job.body, sizeof(job.body), "{\"success\":%s}", success ? "true" : "false");
  job.maxAttempts     = 2;
  job.actionTimeoutMs = 10000;
  if (uxQueueMessagesWaiting(gHttpJobQ) < 12) {
    xQueueSend(gHttpJobQ, &job, 0);
  }
}

void processIncomingLoraPacket(const String& payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload) != DeserializationError::Ok) {
    Serial.printf("[DL] parse error on payload: %.80s\n", payload.c_str());
    return;
  }
  String to = doc["to"].as<String>();
  if (to.length() > 0 && to != selectedTruckCode) {
    return;
  }
  String cmd = doc["cmd"].as<String>();
  String eid = doc["eid"].as<String>();
  if (cmd.length() == 0) return;
  bool ok = dispatchLoraDownlink(cmd, doc);
  if (eid.length() > 0) sendLoraAck(eid);
  if (!ok) Serial.printf("[DL] handler returned false for cmd=%s\n", cmd.c_str());
}

void checkLoRaIncoming() {
  if (!loraReady) return;

  while (!loraInboundQueue.empty()) {
    String pkt = loraInboundQueue.front();
    loraInboundQueue.erase(loraInboundQueue.begin());
    processIncomingLoraPacket(pkt);
  }

  int pktSize = LoRa.parsePacket();
  if (pktSize <= 0) return;
  String pkt = "";
  while (LoRa.available()) pkt += (char)LoRa.read();
  pkt.trim();
  if (pkt.startsWith("ACK:")) return;
  processIncomingLoraPacket(pkt);
}

String commEventSend(const String& path, const String& jsonBody) {
  esp_task_wdt_reset();  // channel attempts can block up to ~12s -- reset before starting
  String eventId = selectedTruckCode + "-" + String(millis());

  JsonDocument doc;
  deserializeJson(doc, jsonBody);
  doc["event_id"] = eventId;

  // Core 0 (httpWorkerTask) must never touch LoRa: its VSPI transactions would
  // TFT/touch operation on Core 1 and permanently freezing the display.
  if (loraReady && xPortGetCoreID() == 1) {
    doc["channel_used"] = "lora";
    String lBody; serializeJson(doc, lBody);
    for (int attempt = 0; attempt < LORA_MAX_RETRIES; attempt++) {
      if (loraEventSend(path, lBody, eventId)) {
        return "";  // ACK received -- gateway forwards to backend
      }
    }
    // All LoRa attempts exhausted -- fall through to cellular.
  }

  if (gsmReady) {
    doc["channel_used"] = "cellular";  // unified label: A7670E can be LTE or GSM 2G
    String gBody; serializeJson(doc, gBody);
    String resp = gsmPost(path, gBody, 1, 8000, pdMS_TO_TICKS(0));
    if (!resp.isEmpty()) {
      lastCommChannel = (gsmActiveRat == RAT_GSM_2G) ? CH_GSM_OK : CH_LTE_OK;
      return resp;
    }
    // GSM/LTE failed (or mutex busy) -- fall through to WiFi.
  }

  // Core 1 (queueTripEvent/queueEndTrip/sendTelemetry) intentionally skip the
  bool core1Ok = (xPortGetCoreID() != 1) || backendReachable;
  if (wifiReady && WiFi.status() == WL_CONNECTED && core1Ok) {
    doc["channel_used"] = "wifi";
    String wBody; serializeJson(doc, wBody);
    String resp = wifiPost(path, wBody);
    if (!resp.isEmpty()) {
      lastCommChannel = CH_WIFI_OK;
      return resp;
    }
    // WiFi unreachable -- fall through to offline.
  }

  lastCommChannel = CH_OFFLINE_BUFFERED;
  return "";
}

static inline void modemYield(uint32_t ms = 1) {
  esp_task_wdt_reset();
  vTaskDelay(pdMS_TO_TICKS(ms ? ms : 1));
}

String gsmSendCmd(const String& cmd, unsigned long timeoutMs = 1000, const char* waitFor = nullptr) {
  if (cmd.length()) { gsmSerial.println(cmd); }
  String resp = "";
  unsigned long start = millis();
  while (millis() - start < timeoutMs) {
    while (gsmSerial.available()) resp += (char)gsmSerial.read();
    if (waitFor && resp.indexOf(waitFor) >= 0) {
      // Drain remaining bytes until a newline arrives or 100ms pass (handles
      unsigned long drain = millis();
      while (millis() - drain < 100) {
        while (gsmSerial.available()) resp += (char)gsmSerial.read();
        if (resp.length() && resp[resp.length()-1] == '\n') break;
        modemYield(5);
      }
      break;
    }
    if (!waitFor && (resp.indexOf("OK") >= 0 || resp.indexOf("ERROR") >= 0 ||
        resp.indexOf("CONNECT") >= 0 || resp.indexOf("+CME") >= 0)) {
      // Drain any trailing bytes so they don't pollute the next command's response
      unsigned long drain = millis();
      while (millis() - drain < 30) {
        while (gsmSerial.available()) resp += (char)gsmSerial.read();
        modemYield(5);
      }
      break;
    }
    modemYield(10);
  }
  return resp;
}

//   +CGPADDR: 1,"10.1.2.3"   or   +CGPADDR: 1,10.1.2.3
static String gsmExtractIpv4(const String& response) {
  const int n = response.length();
  for (int i = 0; i < n; ) {
    while (i < n && !isDigit(response[i])) i++;
    int start = i;
    while (i < n && (isDigit(response[i]) || response[i] == '.')) i++;
    if (i <= start) continue;
    String candidate = response.substring(start, i);
    int d1 = candidate.indexOf('.');
    int d2 = d1 >= 0 ? candidate.indexOf('.', d1 + 1) : -1;
    int d3 = d2 >= 0 ? candidate.indexOf('.', d2 + 1) : -1;
    if (d1 <= 0 || d2 <= d1 + 1 || d3 <= d2 + 1 || d3 >= (int)candidate.length() - 1) continue;
    int a = candidate.substring(0, d1).toInt();
    int b = candidate.substring(d1 + 1, d2).toInt();
    int c = candidate.substring(d2 + 1, d3).toInt();
    int d = candidate.substring(d3 + 1).toInt();
    if (a <= 255 && b <= 255 && c <= 255 && d <= 255 && candidate != "0.0.0.0") return candidate;
  }
  return "";
}

static String gsmSuggestedApn(const String& response) {
  int firstQuote = response.indexOf('"');
  int lastQuote  = response.lastIndexOf('"');
  if (firstQuote >= 0 && lastQuote > firstQuote) {
    String apn = response.substring(firstQuote + 1, lastQuote);
    apn.trim();
    if (!apn.isEmpty()) return apn;
  }
  return String(GSM_APN);
}

GsmRat detectGsmRat() {
  String resp = gsmSendCmd("AT+CPSI?", 1500);
  int p = resp.indexOf("+CPSI:");
  if (p < 0) return RAT_UNKNOWN;
  int start = p + 6;
  while (start < (int)resp.length() && resp[start] == ' ') start++;
  int comma = resp.indexOf(',', start);
  if (comma < 0) return RAT_UNKNOWN;
  String tech = resp.substring(start, comma);
  tech.trim();
  tech.toUpperCase();
  if (tech.startsWith("LTE"))  return RAT_LTE;
  if (tech.startsWith("GSM"))  return RAT_GSM_2G;
  if (tech.startsWith("EDGE")) return RAT_GSM_2G;
  return RAT_UNKNOWN;
}

static void gsmLogDiag(const char* reason) {
  Serial.println();
  Serial.println("========== A7670E DIAGNOSTIC START ==========");
  Serial.printf("[DIAG] reason=%s t=%lums\n", reason, millis());

  String cfun = gsmSendCmd("AT+CFUN?", 1500);
  Serial.printf("[DIAG] CFUN?   : %.80s\n", cfun.c_str());
  String cpin = gsmSendCmd("AT+CPIN?", 1500);
  Serial.printf("[DIAG] CPIN?   : %.80s\n", cpin.c_str());

  String cnmp = gsmSendCmd("AT+CNMP?", 1500);
  Serial.printf("[DIAG] CNMP?   : %.80s\n", cnmp.c_str());
  String cnbp = gsmSendCmd("AT+CNBP?", 2000);
  Serial.printf("[DIAG] CNBP?   : %.180s\n", cnbp.c_str());

  String cgdcont = gsmSendCmd("AT+CGDCONT?", 1500);
  Serial.printf("[DIAG] CGDCONT?: %.180s\n", cgdcont.c_str());

  String cgatt = gsmSendCmd("AT+CGATT?", 1500);
  Serial.printf("[DIAG] CGATT?  : %.40s\n", cgatt.c_str());
  int cgattIdx = cgatt.indexOf("+CGATT:");
  if (cgattIdx >= 0) {
    int8_t newState = (cgatt.indexOf("+CGATT: 1") >= 0) ? 1 : 0;
    if (lastCgattState != -1 && lastCgattState != newState) {
      Serial.printf("[DIAG] ? CGATT transition %d -> %d\n", lastCgattState, newState);
    }
    lastCgattState = newState;
  }

  String cgact = gsmSendCmd("AT+CGACT?", 1500);
  Serial.printf("[DIAG] CGACT?  : %.80s\n", cgact.c_str());
  int cid1Idx = cgact.indexOf("+CGACT: 1,");
  if (cid1Idx >= 0) {
    int8_t newState = (cgact.charAt(cid1Idx + 10) == '1') ? 1 : 0;
    if (lastCgactCid1State != -1 && lastCgactCid1State != newState) {
      Serial.printf("[DIAG] ? CGACT[CID1] transition %d -> %d\n", lastCgactCid1State, newState);
    }
    lastCgactCid1State = newState;
  }

  String cops = gsmSendCmd("AT+COPS?", 2000);
  Serial.printf("[DIAG] COPS?   : %.80s\n", cops.c_str());

  String cpsi = gsmSendCmd("AT+CPSI?", 2000);
  Serial.printf("[DIAG] CPSI?   : %.180s\n", cpsi.c_str());

  String csq = gsmSendCmd("AT+CSQ", 1500);
  Serial.printf("[DIAG] CSQ     : %.30s\n", csq.c_str());

  // LTE-specific signal quality: RSRQ/RSRP are more useful than CSQ when present.
  String cesq = gsmSendCmd("AT+CESQ", 1500);
  Serial.printf("[DIAG] CESQ    : %.100s\n", cesq.c_str());

  String creg = gsmSendCmd("AT+CREG?", 1500);
  Serial.printf("[DIAG] CREG?   : %.40s\n", creg.c_str());

  String cgreg = gsmSendCmd("AT+CGREG?", 1500);
  Serial.printf("[DIAG] CGREG?  : %.60s\n", cgreg.c_str());

  String cereg = gsmSendCmd("AT+CEREG?", 2000);
  Serial.printf("[DIAG] CEREG?  : %.160s\n", cereg.c_str());

  String ceer = gsmSendCmd("AT+CEER", 2000);
  Serial.printf("[DIAG] CEER    : %.180s\n", ceer.c_str());

  Serial.println("=========== A7670E DIAGNOSTIC END ===========");
  Serial.println();
}

bool gsmReconnect() {
  Serial.println("[GSM] ======== reconnect attempt ========");
  gsmActiveRat = RAT_UNKNOWN;

  while (gsmSerial.available()) gsmSerial.read();

  gsmSerial.println("AT+HTTPTERM");
  modemYield(400);
  while (gsmSerial.available()) gsmSerial.read();  // discard HTTPTERM response

  // Step 1: AT handshake -- break on first OK
  Serial.printf("[GSM] [1/5] AT handshake @ %d baud\n", GSM_BAUD);
  bool alive = false;
  for (int i = 1; i <= 5; i++) {
    String r = gsmSendCmd("AT", 800);
    Serial.printf("[GSM]   try %d: %s\n", i, r.indexOf("OK") >= 0 ? "OK" : "(no resp)");
    if (r.indexOf("OK") >= 0) { alive = true; break; }
  }

  if (!alive) {
    Serial.printf("[GSM]   no response @ %d -- probing bauds...\n", GSM_BAUD);
    const long bauds[] = { 9600, 57600, 38400, 19200, 4800 };
    for (int b = 0; b < 5 && !alive; b++) {
      gsmSerial.setRxBufferSize(4096);
      gsmSerial.begin(bauds[b], SERIAL_8N1, GSM_RX_PIN, GSM_TX_PIN);
      String r = gsmSendCmd("AT", 800);
      Serial.printf("[GSM]   %ld baud: %s\n", bauds[b], r.indexOf("OK") >= 0 ? "OK" : "no resp");
      if (r.indexOf("OK") >= 0) {
        gsmSendCmd("AT+IPR=" + String(GSM_BAUD), 500);  // set baud
        gsmSendCmd("AT&W", 300);                         // save to NVM -- survives power cycle
        modemYield(200);
        gsmSerial.setRxBufferSize(4096);
        gsmSerial.begin(GSM_BAUD, SERIAL_8N1, GSM_RX_PIN, GSM_TX_PIN);
        alive = true;
      }
    }
    if (!alive) {
      Serial.println("[GSM]   FAIL -- no UART response on any baud");
      Serial.println("[GSM]   Check: A7670E TXD->GPIO34, A7670E RXD->GPIO32, PWRKEY->GPIO5");
      return false;
    }
  }

  // Step 2: Echo off + SIM check
  Serial.println("[GSM] [2/5] SIM check");
  gsmSendCmd("ATE0", 300);
  bool simReady = false;
  for (int s = 1; s <= 5 && !simReady; s++) {
    String sim = gsmSendCmd("AT+CPIN?", 2000);
    if (sim.indexOf("READY") >= 0) {
      Serial.printf("[GSM]   SIM: READY (attempt %d)\n", s);
      simReady = true;
    } else if (sim.indexOf("SIM PIN") >= 0) {
      Serial.println("[GSM]   SIM LOCKED -- remove PIN lock"); return false;
    } else {
      Serial.printf("[GSM]   SIM check %d: %.50s\n", s, sim.c_str());
      if (s < 5) modemYield(1500);
    }
  }
  if (!simReady) {
    Serial.println("[GSM]   ? SIM never reached READY -- likely loose SIM contact");
    Serial.println("[GSM]     Power off, reseat the SIM firmly, clean contacts if dull.");
    return false;
  }

  // Step 2b: Module identity + network mode + band preference
  // Diagnostic info -- helps narrow down hardware vs config issues.
  String cgmm = gsmSendCmd("AT+CGMM", 800);
  Serial.printf("[GSM]   Module: %.50s\n", cgmm.c_str());
  String cgmr = gsmSendCmd("AT+CGMR", 800);
  Serial.printf("[GSM]   Firmware: %.60s\n", cgmr.c_str());
  // IMEI -- needed for PH device-registration check (RA 11934 successor framework).
  String cgsn = gsmSendCmd("AT+CGSN", 800);
  Serial.printf("[GSM]   IMEI: %.40s\n", cgsn.c_str());
  // ICCID -- identifies the SIM card globally.
  String iccid = gsmSendCmd("AT+CICCID", 800);
  Serial.printf("[GSM]   ICCID: %.50s\n", iccid.c_str());
  // Enable extended CEREG with EMM cause code reporting -- tells us WHY a
  gsmSendCmd("AT+CEREG=4", 500);

  String cnmp = gsmSendCmd("AT+CNMP?", 1000);
  Serial.printf("[GSM]   Network mode: %.50s\n", cnmp.c_str());
  if (cnmp.indexOf("+CNMP:") >= 0 && cnmp.indexOf("+CNMP: 2") < 0) {
    Serial.println("[GSM]   Forcing CNMP=2 (AUTO -- LTE preferred, GSM fallback)");
    String modeSet = gsmSendCmd("AT+CNMP=2", 3000);
    Serial.printf("[GSM]   CNMP set: %.40s\n", modeSet.c_str());
    gsmSendCmd("AT+CFUN=0", 10000, "OK");
    modemYield(2000);
    gsmSendCmd("AT+CFUN=1", 10000, "OK");
    Serial.println("[GSM]   Waiting for radio restart to finish...");
    bool radioReady = false;
    for (int i = 0; i < 15 && !radioReady; i++) {
      modemYield(1000);
      while (gsmSerial.available()) gsmSerial.read();
      String at = gsmSendCmd("AT", 1000);
      radioReady = at.indexOf("OK") >= 0;
    }
    // Drain delayed boot/SIM/SMS URCs before issuing identity and RF queries.
    modemYield(1000);
    while (gsmSerial.available()) gsmSerial.read();
  } else if (cnmp.indexOf("+CNMP:") < 0) {
    Serial.println("[GSM]   CNMP query incomplete -- preserving current modem mode");
  }
  String cnbp = gsmSendCmd("AT+CNBP?", 1000);
  Serial.printf("[GSM]   Band pref: %.70s\n", cnbp.c_str());

  String serving = gsmSendCmd("AT+CPSI?", 1500);
  Serial.printf("[GSM]   Serving cell: %.160s\n", serving.c_str());
  String currentOperator = gsmSendCmd("AT+COPS?", 1500);
  Serial.printf("[GSM]   Current operator: %.100s\n", currentOperator.c_str());

  // Step 3: Signal
  Serial.println("[GSM] [3/5] Signal");
  String csq = gsmSendCmd("AT+CSQ", 1000);
  int csqIdx = csq.indexOf("+CSQ:");
  if (csqIdx >= 0) {
    int rssi = csq.substring(csqIdx + 6).toInt();
    const char* lvl = rssi == 99 ? "UNKNOWN" : rssi == 0 ? "NONE" :
                      rssi < 10  ? "WEAK"    : rssi < 20 ? "FAIR" : "GOOD";
    Serial.printf("[GSM]   CSQ: %d/31 (%s)\n", rssi, lvl);
  }

  Serial.println("[GSM] [4/5] Network registration (PS domain)...");
  const bool inSetup = (gsmMutex == nullptr);
  bool registered = false;
  // Cold-boot tries fewer iterations so the splash doesn't sit on "Registering"
  const int REG_MAX_ITERS = (gsmMutex == nullptr) ? 40 : 50;
  for (int i = 1; i <= REG_MAX_ITERS; i++) {
    if (inSetup) {
      char pbuf[40];
      snprintf(pbuf, sizeof(pbuf), "Registering [%d/%d]...", i, REG_MAX_ITERS);
      tft.fillRect(0, 188, SCREEN_W, 28, C_BG);
      tft.setTextColor(C_DIM);
      tft.drawCentreString(pbuf, SCREEN_W / 2, 194, 2);
    }
    // A7670E URCs from being mistaken for a missing response.
    String cereg = gsmSendCmd("AT+CEREG?", 1500);
    int    ceregComma = cereg.indexOf(",");
    char   ceregStat  = (ceregComma >= 0 && ceregComma + 1 < (int)cereg.length()) ? cereg[ceregComma + 1] : '?';

    // CS registration is diagnostic only on this LTE Cat-1 path.
    String creg = gsmSendCmd("AT+CREG?", 1200);
    int    cregComma = creg.indexOf(",");
    char   cregStat  = (cregComma >= 0 && cregComma + 1 < (int)creg.length()) ? creg[cregComma + 1] : '?';

    char cgregStat = '-';

    const char* csDesc  = cregStat =='1' ? "HOME" : cregStat =='5' ? "ROAM" :
                          cregStat =='2' ? "srch" : cregStat =='3' ? "DENY" : "?";
    const char* psDesc  = (ceregStat=='1'||cgregStat=='1') ? "HOME" :
                          (ceregStat=='5'||cgregStat=='5') ? "ROAM" :
                          (ceregStat=='2'||cgregStat=='2') ? "srch" : "?";
    Serial.printf("[GSM]   [%2d/%d] CS=%c(%s) LTE=%c GPRS=%c PS=%s\n",
                  i, REG_MAX_ITERS, cregStat, csDesc, ceregStat, cgregStat, psDesc);

    // Accept registration when EITHER LTE or GPRS PS domain is registered.
    bool lteReg  = (ceregStat == '1' || ceregStat == '5');
    bool regOk   = lteReg;
    if (regOk) { registered = true; break; }
    // Early bail when network is actively denying registration on all domains.
    if (i >= 5 && cregStat == '3' && ceregStat == '3' && cgregStat == '3') {
      Serial.println("[GSM]   DENY on all domains -- aborting registration scan");
      break;
    }
    modemYield(1000);
  }
  if (!registered) {
    Serial.println("[GSM]   FAIL -- PS domain not registered (check antenna / SIM / APN)");
    gsmLogDiag("registration_failed");
    return false;
  }

  // Step 4b: Sync ESP32 RTC from cellular network time
  gsmSendCmd("AT+CTZU=1", 300);   // enable automatic timezone/time sync on A7670E
  modemYield(200);
  String cclk = gsmSendCmd("AT+CCLK?", 2000);
  int cclkIdx = cclk.indexOf("+CCLK: \"");
  if (cclkIdx >= 0) {
    String t = cclk.substring(cclkIdx + 8);
    struct tm ti = {};
    int yr, mo, dy, hr, mn, sc, tz = 0;
    char sign = '+';
    if (sscanf(t.c_str(), "%d/%d/%d,%d:%d:%d%c%d",
               &yr, &mo, &dy, &hr, &mn, &sc, &sign, &tz) >= 6
        && mo >= 1 && mo <= 12 && dy >= 1 && dy <= 31
        && hr >= 0 && hr <= 23 && mn >= 0 && mn <= 59) {
      ti.tm_year = yr + 100;   // years since 1900
      ti.tm_mon  = mo - 1;
      ti.tm_mday = dy;
      ti.tm_hour = hr;
      ti.tm_min  = mn;
      ti.tm_sec  = sc;
      time_t localEpoch  = mktime(&ti);
      int    tzOffsetSec = (sign == '-' ? -1 : 1) * tz * 15 * 60;
      time_t utcEpoch    = localEpoch - tzOffsetSec;
      struct timeval tv  = { .tv_sec = utcEpoch, .tv_usec = 0 };
      settimeofday(&tv, nullptr);
      Serial.printf("[GSM] RTC synced from network: %04d-%02d-%02d %02d:%02d:%02d UTC\n",
                    ti.tm_year + 1900, mo, dy, hr, mn, sc);
    }
  } else {
    Serial.println("[GSM] CCLK not available -- RTC not synced");
  }

  Serial.println("[GSM] [5/5] PDP context activation");
  if (inSetup) {  // gsmMutex still null -> we are in setup(), safe to draw
    tft.fillRect(0, 188, SCREEN_W, 28, C_BG);
    tft.setTextColor(C_DIM);
    tft.drawCentreString("Activating PDP context...", SCREEN_W / 2, 194, 2);
  }

  // Diagnostic: which operator did we attach to, and is PS attached
  gsmSendCmd("AT+COPS=3,2", 500);   // set numeric format so AT+COPS? returns operator
  String cops = gsmSendCmd("AT+COPS?", 1000);
  Serial.printf("[GSM]   Operator: %.80s\n", cops.c_str());
  String cgatt = gsmSendCmd("AT+CGATT?", 1000);
  Serial.printf("[GSM]   PS attach: %.40s\n", cgatt.c_str());

  // Extended registration -- includes EMM cause code if there was a rejection.
  String ceregExt = gsmSendCmd("AT+CEREG?", 1000);
  Serial.printf("[GSM]   CEREG (extended): %.120s\n", ceregExt.c_str());

  String cgnapn = gsmSendCmd("AT+CGNAPN", 1500);
  Serial.printf("[GSM]   Network-suggested APN: %.80s\n", cgnapn.c_str());
  String selectedApn = gsmSuggestedApn(cgnapn);
  Serial.printf("[GSM]   Selected APN: %s\n", selectedApn.c_str());

  String cgrdp = gsmSendCmd("AT+CGCONTRDP", 2000);
  Serial.printf("[GSM]   Active bearer info: %.150s\n", cgrdp.c_str());
  if (cgrdp.indexOf("+CGCONTRDP: 1") >= 0 && cgrdp.indexOf("0.0.0.0") < 0) {
    Serial.println("[GSM]   Default EPS bearer already up -- using it directly");
    gsmActiveCid = 1;
    GsmRat detected = detectGsmRat();
    gsmActiveRat = (detected != RAT_UNKNOWN) ? detected : RAT_LTE;
    Serial.printf("[GSM]   RAT: %s\n", gsmActiveRat == RAT_GSM_2G ? "GSM 2G" : "LTE");
    gsmReady = true;
    return true;
  }

  // PRE-CHECK: is PDP context 1 already active from a previous session
  while (gsmSerial.available()) gsmSerial.read();
  String preCheck = gsmSendCmd("AT+CGACT?", 2000);
  Serial.printf("[GSM]   CGACT pre-check: %.80s\n", preCheck.c_str());
  if (preCheck.indexOf("+CGACT: 1,1") >= 0) {
    Serial.println("[GSM]   PDP context 1 already active -- skipping setup");
    gsmActiveCid = 1;
    GsmRat detected = detectGsmRat();
    gsmActiveRat = (detected != RAT_UNKNOWN) ? detected : RAT_LTE;
    Serial.printf("[GSM]   RAT: %s\n", gsmActiveRat == RAT_GSM_2G ? "GSM 2G" : "LTE");
    gsmReady = true;
    return true;
  }

  // Log what contexts already exist (network may have auto-configured CID 1).
  String cgdQ = gsmSendCmd("AT+CGDCONT?", 2000);
  Serial.printf("[GSM]   Existing contexts: %.150s\n", cgdQ.c_str());

  // 1, leaving neither context consistently usable.
  String cgdcont = "AT+CGDCONT=1,\"IP\",\"" + selectedApn + "\"";
  Serial.printf("[GSM]   Defining CID 1 APN: %s (PDP type IP)\n", selectedApn.c_str());
  String cgdResp = gsmSendCmd(cgdcont, 2000);
  if (cgdResp.indexOf("OK") < 0) {
    Serial.printf("[GSM]   CGDCONT failed: %.80s\n", cgdResp.c_str());
    return false;
  }

  // Optional PAP/CHAP auth (Globe needs globe/globe1234; Smart/DITO need none).
  #ifdef GSM_APN_USER
    String cgauth = "AT+CGAUTH=1,1,\"" + String(GSM_APN_USER) + "\",\"" + String(GSM_APN_PASS) + "\"";
    Serial.printf("[GSM]   Setting PAP auth for %s\n", GSM_APN_USER);
    gsmSendCmd(cgauth, 1000);
  #else
    gsmSendCmd("AT+CGAUTH=1,0", 500);
  #endif

  if (cgatt.indexOf("+CGATT: 1") < 0) {
    Serial.println("[GSM]   PS detached -- attaching with CGATT=1");
    String attach = gsmSendCmd("AT+CGATT=1", 30000, "OK");
    if (attach.indexOf("OK") < 0) {
      Serial.printf("[GSM]   CGATT failed: %.80s\n", attach.c_str());
      return false;
    }
  }

  bool active = false;
  String activeIp;
  int   activeCid = 1;

  for (int cid = 1; cid <= 2 && !active; cid++) {
    if (cid == 2) {
      String cid2 = "AT+CGDCONT=2,\"IP\",\"" + selectedApn + "\"";
      gsmSendCmd(cid2, 2000);
      #ifdef GSM_APN_USER
        gsmSendCmd("AT+CGAUTH=2,1,\"" + String(GSM_APN_USER) + "\",\"" + String(GSM_APN_PASS) + "\"", 1000);
      #else
        gsmSendCmd("AT+CGAUTH=2,0", 500);
      #endif
    }
    Serial.printf("[GSM]   --- Trying CID %d ---\n", cid);
    String actCmd = "AT+CGACT=1," + String(cid);
    String cgactResp = gsmSendCmd(actCmd, 30000, "OK");
    Serial.printf("[GSM]   CGACT=1,%d response: %.60s\n", cid, cgactResp.c_str());
    modemYield(1000);

    for (int retry = 0; retry < 3 && !active; retry++) {
      String cgactQ   = gsmSendCmd("AT+CGACT?", 2000);
      String paddrCmd = "AT+CGPADDR=" + String(cid);
      String cgpaddr  = gsmSendCmd(paddrCmd, 2000);
      Serial.printf("[GSM]   CID %d CGACT?[%d]: %.40s | CGPADDR: %.60s\n",
                    cid, retry + 1, cgactQ.c_str(), cgpaddr.c_str());
      String tag = "+CGACT: " + String(cid) + ",1";
      bool ctxActive = (cgactQ.indexOf(tag) >= 0);
      activeIp = gsmExtractIpv4(cgpaddr);
      bool hasIp = !activeIp.isEmpty();
      // Some A7670E firmware exposes the default EPS bearer through CGPADDR
      if (hasIp && (ctxActive || cid == 1)) { active = true; activeCid = cid; break; }
      if (retry < 2) modemYield(2000);
    }
  }

  if (!active && gsmMutex != nullptr) {
    Serial.println("[GSM]   CGACT path failed -- trying CFUN radio cycle");
    gsmSendCmd("AT+CFUN=0", 10000, "OK");
    modemYield(3000);
    gsmSendCmd("AT+CFUN=1", 10000, "OK");
    modemYield(8000);                       // give re-attach time to settle
    // Quick re-check CEREG so we don't try CGACT before attach.
    for (int w = 0; w < 10; w++) {
      String cereg = gsmSendCmd("AT+CEREG?", 1000);
      if (cereg.indexOf(",1") >= 0 || cereg.indexOf(",5") >= 0) break;
      modemYield(1500);
    }
    String cgactRetry = gsmSendCmd("AT+CGACT=1,1", 20000, "OK");
    Serial.printf("[GSM]   CGACT retry: %.60s\n", cgactRetry.c_str());
    modemYield(1500);
    String cgpaddr = gsmSendCmd("AT+CGPADDR=1", 2000);
    Serial.printf("[GSM]   CGPADDR after cycle: %.60s\n", cgpaddr.c_str());
    activeIp = gsmExtractIpv4(cgpaddr);
    if (activeIp.length() > 0 && activeIp != "0.0.0.0") active = true;
  }

  // Fallback 2: legacy SIMCom CSTT/CIICR data stack -- older A76xx firmware
  if (!active) {
    Serial.println("[GSM]   Trying legacy CSTT/CIICR stack");
    String cstt = "AT+CSTT=\"" + String(GSM_APN) + "\",\"\",\"\"";
    gsmSendCmd(cstt, 3000, "OK");
    String ciicr = gsmSendCmd("AT+CIICR", 30000, "OK");
    Serial.printf("[GSM]   CIICR: %.60s\n", ciicr.c_str());
    bool ciicrOk = (ciicr.indexOf("OK") >= 0) && (ciicr.indexOf("ERROR") < 0);
    if (ciicrOk) {
      String cifsr = gsmSendCmd("AT+CIFSR", 3000);
      Serial.printf("[GSM]   CIFSR: %.60s\n", cifsr.c_str());
      // Extract the FIRST token that looks like an IPv4 address (a.b.c.d).
      String candidate;
      int n = cifsr.length();
      int i = 0;
      while (i < n) {
        while (i < n && !isDigit(cifsr[i])) i++;
        int s = i;
        while (i < n && (isDigit(cifsr[i]) || cifsr[i] == '.')) i++;
        if (i > s) {
          String tok = cifsr.substring(s, i);
          // Must be a.b.c.d with each octet 0-255 and not 0.0.0.0.
          int d1 = tok.indexOf('.');
          int d2 = (d1 >= 0) ? tok.indexOf('.', d1 + 1) : -1;
          int d3 = (d2 >= 0) ? tok.indexOf('.', d2 + 1) : -1;
          if (d1 > 0 && d2 > d1 && d3 > d2 && d3 < (int)tok.length() - 1
              && tok != "0.0.0.0") {
            candidate = tok;
            break;
          }
        }
      }
      if (candidate.length() > 0) {
        activeIp = candidate;
        active = true;
      }
    }
  }

  if (!active) {
    String ceer = gsmSendCmd("AT+CEER", 1000);
    Serial.printf("[GSM]   CEER (reason): %.100s\n", ceer.c_str());
    Serial.println("[GSM]   FAIL -- PDP not active and no IP assigned");
    Serial.println("[GSM]     Most likely: flaky SIM contact, or carrier silently rejecting data session.");
    Serial.println("[GSM]     Action: reseat SIM. Verify SIM works for DATA in a phone (not just signal bars).");
    return false;
  }
  gsmActiveCid = activeCid;
  GsmRat detected = detectGsmRat();
  gsmActiveRat = (detected != RAT_UNKNOWN) ? detected : RAT_LTE;
  Serial.printf("[GSM]   ? Cellular (%s) data path up -- CID=%d IP=%s\n",
                gsmActiveRat == RAT_GSM_2G ? "2G" : "LTE",
                activeCid, activeIp.c_str());

  // SSL config is applied per-session in gsmPost()/gsmGet() after AT+HTTPINIT.

  Serial.printf("[GSM] ? READY -- PDP context %d active\n", activeCid);
  gsmReady = true;
  return true;
}

bool gsmInit() {
  Serial.println("============================================");
  Serial.println("[GSM] Starting A7670E initialization...");
  Serial.printf ("[GSM] RX=GPIO%d  TX=GPIO%d  PWRKEY=GPIO%d  baud=%d\n",
                 GSM_RX_PIN, GSM_TX_PIN, GSM_PWRKEY, GSM_BAUD);
  Serial.println("============================================");

  // Let UART settle, then probe for an already-running modem.
  modemYield(500);
  while (gsmSerial.available()) gsmSerial.read();
  String probe = gsmSendCmd("AT", 800);
  if (probe.indexOf("OK") >= 0) {
    Serial.println("[GSM] modem already running -- skipping PWRKEY pulse");
  } else {
    Serial.println("[GSM] no AT response - pulsing PWRKEY LOW for 1s");
    pinMode(GSM_PWRKEY, OUTPUT);
    digitalWrite(GSM_PWRKEY, LOW);
    delay(1000);                          // comfortably above the 50 ms minimum
    pinMode(GSM_PWRKEY, INPUT);           // release; module pulls PWRKEY up to VBAT
    Serial.println("[GSM] waiting for A7670E AT interface...");
    bool bootReady = false;
    for (int i = 0; i < 15 && !bootReady; i++) {
      modemYield(1000);
      String ready = gsmSendCmd("AT", 800);
      bootReady = ready.indexOf("OK") >= 0;
    }
    if (!bootReady) Serial.println("[GSM] A7670E still silent after PWRKEY pulse");
  }

  return gsmReconnect();
}

// PDP keepalive -- query CGACT and signal reconnect if context is dead
bool gsmEnsurePdp() {
  String tag = "+CGACT: " + String(gsmActiveCid) + ",1";
  // Flush RX before querying -- stale bytes from a previous HTTP session
  while (gsmSerial.available()) gsmSerial.read();
  String q = gsmSendCmd("AT+CGACT?", 2000);
  Serial.printf("[GSM]   CGACT status (CID %d): [%.70s]\n", gsmActiveCid, q.c_str());
  // Track CGACT[CID1] transitions for diagnostic timeline.
  int cidLook = q.indexOf("+CGACT: 1,");
  if (cidLook >= 0) {
    int8_t newState = (q.charAt(cidLook + 10) == '1') ? 1 : 0;
    if (lastCgactCid1State != -1 && lastCgactCid1State != newState) {
      Serial.printf("[DIAG] ? CGACT[CID1] transition %d -> %d (in gsmEnsurePdp)\n", lastCgactCid1State, newState);
    }
    lastCgactCid1State = newState;
  }
  if (q.indexOf(tag) >= 0) return true;

  if (q.isEmpty()) {
    Serial.println("[GSM]   CGACT check: empty (modem reboot?)");
    gsmReady = false;
    return false;
  }

  Serial.println("[GSM]   PDP context not active -- retrying in 2s");
  modemYield(2000);
  while (gsmSerial.available()) gsmSerial.read();
  q = gsmSendCmd("AT+CGACT?", 2000);
  Serial.printf("[GSM]   CGACT recheck: [%.70s]\n", q.c_str());
  if (q.indexOf(tag) >= 0) return true;

  // Context dead -- let gsmPost()/gsmGet() trigger a full gsmReconnect().
  Serial.println("[GSM]   PDP context dead -- returning to reconnect path");
  gsmLogDiag("gsmEnsurePdp_dead");
  gsmReady = false;
  return false;
}

static bool gsmBeginHttpSession(int attempt, int maxAttempts, bool& networkDown) {
  String term = gsmSendCmd("AT+HTTPTERM", 1200);
  term.trim();
  Serial.printf("[GSM]   HTTPTERM before init: %s\n",
                term.isEmpty() ? "(no response)" : term.c_str());
  modemYield(1000);
  while (gsmSerial.available()) gsmSerial.read();

  Serial.printf("[GSM]   [%d/%d] HTTPINIT\n", attempt, maxAttempts);
  String init = gsmSendCmd("AT+HTTPINIT", 2000);
  Serial.printf("[GSM]   HTTPINIT: %s\n", init.c_str());
  if (init.indexOf("OK") >= 0) {
    gsmHttpInitFailStreak = 0;
    return true;
  }

  gsmHttpInitFailStreak++;
  String cleanup = gsmSendCmd("AT+HTTPTERM", 1200);
  cleanup.trim();
  Serial.printf("[GSM]   HTTPTERM recovery: %s\n",
                cleanup.isEmpty() ? "(no response)" : cleanup.c_str());
  modemYield(1000);

  if (gsmHttpInitFailStreak >= 3) {
    Serial.println("[GSM]   HTTP engine stuck after 3 attempts -- restarting A7670E");
    String reset = gsmSendCmd("AT+CFUN=1,1", 3000);
    Serial.printf("[GSM]   CFUN restart: %s\n", reset.c_str());
    gsmHttpInitFailStreak = 0;
    gsmReady = false;
    networkDown = true;
  }
  return false;
}

// GSM HTTP -- A7670E uses HTTPINIT/HTTPPARA/HTTPDATA/HTTPACTION/HTTPREAD

// Parse body from AT+HTTPREAD response.
static String httpReadBody(int expectedLength = 1024) {
  int readLength = constrain(expectedLength, 1, 8192);
  Serial.printf("[GSM]   HTTPREAD=0,%d\n", readLength);
  gsmSerial.println("AT+HTTPREAD=0," + String(readLength));

  String r;
  unsigned long t0          = millis();
  unsigned long lastByteMs  = millis();
  const unsigned long totalTimeoutMs = 12000;
  const unsigned long quietTimeoutMs = 800;   // body fully received once stream goes quiet
  // Once we see "+HTTPREAD: <len>\n", `expectedBodyEnd` becomes the index
  int expectedBodyEnd = -1;
  while (millis() - t0 < totalTimeoutMs) {
    if (gsmSerial.available()) {
      r += (char)gsmSerial.read();
      lastByteMs = millis();
      if (expectedBodyEnd < 0) {
        int m  = r.indexOf("+HTTPREAD:");
        int nl = m >= 0 ? r.indexOf('\n', m) : -1;
        if (nl > 0) {
          int colon = r.indexOf(':', m);
          int dlen  = (colon >= 0) ? r.substring(colon + 1, nl).toInt() : 0;
          if (dlen > 0) expectedBodyEnd = nl + 1 + dlen;
        }
      }
      if (expectedBodyEnd > 0 && (int)r.length() >= expectedBodyEnd) {
        // Terminate as soon as the trailing "+HTTPREAD: 0" sentinel appears.
        int firstUrc  = r.indexOf("+HTTPREAD:");
        int secondUrc = firstUrc >= 0 ? r.indexOf("+HTTPREAD:", firstUrc + 10) : -1;
        if (secondUrc > 0) break;
      }
    } else if (r.length() > 0 && millis() - lastByteMs > quietTimeoutMs) {
      // Quiet timeout -- only honour it if we've already received the
      if (expectedBodyEnd <= 0 || (int)r.length() >= expectedBodyEnd) break;
    }
    if (r.indexOf("ERROR") >= 0 || r.indexOf("+CME ERROR") >= 0) break;
    esp_task_wdt_reset();
    vTaskDelay(1);
  }

  // Fallback for very old firmware that only supports bare AT+HTTPREAD.
  if (r.indexOf("ERROR") >= 0 || r.indexOf("+CME ERROR") >= 0) {
    Serial.println("[GSM]   ranged HTTPREAD unsupported; trying bare HTTPREAD");
    r = gsmSendCmd("AT+HTTPREAD", 8000, "OK");
  }

  Serial.printf("[GSM]   HTTPREAD raw: %.200s\n", r.c_str());
  // Honour the declared "+HTTPREAD: <len>" length verbatim -- substring/lastIndexOf
  int marker = r.indexOf("+HTTPREAD:");
  if (marker < 0) return "";
  int colon = r.indexOf(':', marker);
  int nl    = colon >= 0 ? r.indexOf('\n', colon) : -1;
  if (nl < 0) return "";
  int declaredLen = r.substring(colon + 1, nl).toInt();
  if (declaredLen <= 0) {
    Serial.printf("[GSM]   body extraction: bad declared length [%.30s]\n",
                  r.substring(marker, nl).c_str());
    return "";
  }
  int bodyStart = nl + 1;
  int available = (int)r.length() - bodyStart;
  if (available < declaredLen) {
    Serial.printf("[GSM]   body extraction: WARN declared=%d available=%d (truncated)\n",
                  declaredLen, available);
    declaredLen = available;
  }
  String b = r.substring(bodyStart, bodyStart + declaredLen);
  Serial.printf("[GSM]   body(%d declared=%d): %.150s\n",
                b.length(), declaredLen, b.c_str());
  return b;
}

// Detects modem power-cycle (10s of complete silence) and returns "" with
static String gsmWaitHttpAction(unsigned long actionTimeoutMs, bool& networkDown) {
  String r;
  unsigned long t0          = millis();
  unsigned long lastByteMsL = millis();
  while (millis() - t0 < actionTimeoutMs) {
    if (gsmSerial.available()) {
      r += (char)gsmSerial.read();
      lastByteMsL = millis();
      if (r.indexOf("+HTTPACTION") >= 0) {
        unsigned long drainT = millis();
        while (millis() - drainT < 1500) {
          while (gsmSerial.available()) {
            r += (char)gsmSerial.read();
            lastByteMsL = millis();
          }
          int action = r.indexOf("+HTTPACTION:");
          int comma1 = action >= 0 ? r.indexOf(',', action) : -1;
          int comma2 = comma1 >= 0 ? r.indexOf(',', comma1 + 1) : -1;
          int lineEnd = comma2 >= 0 ? r.indexOf('\n', comma2) : -1;
          if (comma2 >= 0 && lineEnd >= 0) break;  // complete method,status,length URC
          esp_task_wdt_reset();
          vTaskDelay(1);
        }
        break;
      }
    } else if (millis() - lastByteMsL > 10000UL) {
      // 10 s of silence -- modem may have power-cycled during TX burst.
      gsmSerial.println("AT");
      String chk;
      unsigned long probeT = millis();
      while (millis() - probeT < 2000UL) {
        if (gsmSerial.available()) chk += (char)gsmSerial.read();
        if (chk.indexOf("OK") >= 0) break;
        vTaskDelay(1);
      }
      if (chk.indexOf("OK") < 0) {
        Serial.println("[GSM]   modem silent 10s + no AT echo -- power-cycled, aborting");
        networkDown = true;
        return "";
      }
      lastByteMsL = millis(); // still alive, reset silence timer
    }
    esp_task_wdt_reset();
    vTaskDelay(1);
  }
  return r;
}

String gsmPost(const String& path, const String& body, int maxAttempts, unsigned long actionTimeoutMs, TickType_t mutexTimeout) {
  if (!gsmReady) { Serial.println("[GSM] POST skipped -- not ready"); return ""; }
  if (xSemaphoreTake(gsmMutex, mutexTimeout) != pdTRUE) {
    Serial.println("[GSM] POST mutex busy -- skipping");
    return "";
  }

  // Track 2: request timing + Mode B rate counter
  uint32_t reqId        = ++gsmHttpReqIdCounter;
  uint32_t reqStartMs   = millis();
  int      httpFinalStatus = -1;

  if (gsmPostWindowStartMs == 0 || reqStartMs - gsmPostWindowStartMs >= 60000UL) {
    if (gsmPostsInWindow >= 10) {
      Serial.printf("[DIAG] ? Mode B tripwire: %u POSTs in last 60s (>=10 = overload risk)\n", gsmPostsInWindow);
    }
    gsmPostWindowStartMs = reqStartMs;
    gsmPostsInWindow = 0;
  }
  gsmPostsInWindow++;

  String url     = String(API_BASE) + path;
  url += (url.indexOf('?') >= 0 ? "&" : "?");
  url += "a7670e=1";
  String gsmBody = body;
  const char* cellularChannel = (gsmActiveRat == RAT_GSM_2G) ? "gsm" : "lte";
  gsmBody.replace("\"comm_channel\":\"wifi\"", String("\"comm_channel\":\"") + cellularChannel + "\"");

  Serial.printf("[HTTP] start id=%u method=POST path=%s body=%d\n", reqId, path.c_str(), gsmBody.length());
  Serial.printf("[GSM] POST %s  body=%d bytes  attempts=%d\n", path.c_str(), gsmBody.length(), maxAttempts);

  bool networkDown = false;
  for (int attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!gsmEnsurePdp()) {
      Serial.println("[GSM]   PDP context unavailable -- skipping attempt");
      networkDown = true;
      break;
    }

    if (!gsmBeginHttpSession(attempt, maxAttempts, networkDown)) {
      if (networkDown) break;
      continue;
    }
    String r;
    // Re-applied each session (HTTPTERM clears session-scope settings).
    gsmSendCmd("AT+CSSLCFG=\"sslversion\",0,3", 500);        // TLS 1.2 on SIMCom A76xx
    gsmSendCmd("AT+CSSLCFG=\"authmode\",0,0", 300);          // no cert verification
    gsmSendCmd("AT+CSSLCFG=\"ignorelocaltime\",0,1", 300);   // ignore cert expiry
    gsmSendCmd("AT+CSSLCFG=\"enableSNI\",0,1", 300);

    gsmSendCmd("AT+HTTPPARA=\"CID\"," + String(gsmActiveCid), 200);
    gsmSendCmd("AT+HTTPPARA=\"URL\",\"" + url + "\"", 800);
    gsmSendCmd("AT+HTTPPARA=\"SSLCFG\",0", 200);             // bind ssl_ctx 0 to this HTTP session
    gsmSendCmd("AT+HTTPPARA=\"CONTENT\",\"application/json\"", 200);
    gsmSendCmd("AT+HTTPPARA=\"USERDATA\",\"X-Device-Key: " + String(DEVICE_API_KEY) + "\"", 200);
    gsmSendCmd("AT+HTTPPARA=\"REDIR\",1", 150);
    gsmSendCmd("AT+HTTPPARA=\"TIMEOUT\",60", 150);

    String dataCmd = "AT+HTTPDATA=" + String(gsmBody.length()) + ",15000";
    Serial.printf("[GSM]   %s\n", dataCmd.c_str());
    r = gsmSendCmd(dataCmd, 3000, "DOWNLOAD");
    Serial.printf("[GSM]   -> %s\n", r.c_str());
    if (r.indexOf("DOWNLOAD") < 0) {
      if (++gsmHttpDataFailStreak >= 3) {
        Serial.println("[GSM]   HTTPDATA wedge -- soft-resetting radio (CFUN cycle)");
        gsmSendCmd("AT+HTTPTERM", 400);
        gsmSendCmd("AT+CFUN=0", 2000);
        modemYield(1500);
        gsmSendCmd("AT+CFUN=1", 6000, "+CPIN: READY");
        modemYield(2000);
        gsmReady = false;
        gsmHttpDataFailStreak = 0;
        networkDown = true;  // exit attempt loop; outer reconnect logic re-establishes
        xSemaphoreGive(gsmMutex);
        Serial.printf("[HTTP] end id=%u status=0 dur=%lums (modem reset)\n",
                      reqId, millis() - reqStartMs);
        return "";
      }
      gsmSendCmd("AT+HTTPTERM", 400);
      modemYield(300); continue;
    }
    // Successful HTTPDATA -- reset the wedge counter
    gsmHttpDataFailStreak = 0;
    gsmSerial.print(gsmBody);
    gsmSerial.flush();          // wait until all bytes are in the UART TX hardware buffer
    gsmSendCmd("", 2000);       // wait for modem's OK confirming body receipt

    Serial.println("[GSM]   AT+HTTPACTION=1 (POST)");
    esp_task_wdt_reset();
    gsmSerial.println("AT+HTTPACTION=1");
    r = gsmWaitHttpAction(actionTimeoutMs, networkDown);
    Serial.printf("[GSM]   -> %s\n", r.c_str());
    if (networkDown) break;

    int acIdx = r.indexOf("+HTTPACTION: 1,");
    int acCode = (acIdx >= 0) ? r.substring(acIdx + 15).toInt() : 0;
    int acComma1 = acIdx >= 0 ? r.indexOf(',', acIdx) : -1;
    int acComma2 = acComma1 >= 0 ? r.indexOf(',', acComma1 + 1) : -1;
    int acLength = acComma2 >= 0 ? r.substring(acComma2 + 1).toInt() : 0;
    gsmLastStatus = acCode;
    // Annotate modem error codes so serial logs are self-explanatory
    const char* acDesc = (acCode == 605) ? " [SSL/TLS handshake failed]" :
                         (acCode == 603) ? " [DNS resolution failed]"     :
                         (acCode == 602) ? " [network open failed]"       :
                         (acCode == 601) ? " [TCP/bearer failure]"        :
                         (acCode == 0)   ? " [no response/timeout]"       : "";
    Serial.printf("[GSM]   HTTP status: %d%s\n", acCode, acDesc);
    if (acCode >= 200 && acCode < 300) {
      String resp = httpReadBody(acLength > 0 ? acLength : 1024);
      gsmSendCmd("AT+HTTPTERM", 400);
      backendReachable = true;
      httpFinalStatus = acCode;
      Serial.printf("[HTTP] end id=%u status=%d dur=%lums\n", reqId, httpFinalStatus, millis() - reqStartMs);
      xSemaphoreGive(gsmMutex);
      return resp;
    }
    if (acCode >= 400 && acCode < 600) {
      String errBody = httpReadBody(acLength > 0 ? acLength : 1024);
      Serial.printf("[GSM]   error body: %s\n", errBody.c_str());
      // Server responded -- backend IS reachable, request just failed logically
      backendReachable = true;
      gsmSendCmd("AT+HTTPTERM", 400);
      httpFinalStatus = acCode;
      Serial.printf("[HTTP] end id=%u status=%d dur=%lums\n", reqId, httpFinalStatus, millis() - reqStartMs);
      xSemaphoreGive(gsmMutex);
      return "";
    }
    if (acCode == 601 || acCode == 0) {
      Serial.println("[GSM]   TCP/bearer failure -- forcing reconnect");
      gsmLogDiag("HTTPACTION_601_or_0");
      gsmSendCmd("AT+HTTPTERM", 400);
      networkDown = true;
      httpFinalStatus = acCode;
      break;
    }
    // Bearer is intact; force reconnect only after all retries exhausted.
    if (acCode == 602) {
      gsmSendCmd("AT+HTTPTERM", 400);
      if (attempt >= maxAttempts) {
        Serial.println("[GSM]   602 on final attempt -- server unreachable, bearer intact");
        break;
      }
      Serial.printf("[GSM]   POST attempt %d failed (602) -- server cold-start? waiting 10s\n", attempt);
      modemYield(10000);
      continue;
    }
    if (acCode == 605) {
      Serial.println("[GSM]   SSL handshake failed -- will retry if attempts remain");
      gsmSendCmd("AT+HTTPTERM", 400);
      modemYield(1500);
      Serial.printf("[GSM]   POST attempt %d failed (605)\n", attempt);
      continue;
    }
    gsmSendCmd("AT+HTTPTERM", 400);
    modemYield(300);
    Serial.printf("[GSM]   POST attempt %d failed\n", attempt);
  }
  if (networkDown) { gsmReady = false; }
  backendReachable = false;
  Serial.printf("[HTTP] end id=%u status=%d dur=%lums (all attempts exhausted, networkDown=%d)\n",
                reqId, httpFinalStatus, millis() - reqStartMs, networkDown ? 1 : 0);
  xSemaphoreGive(gsmMutex);
  return "";
}

// GET via A7670E -- device_key as query param AND custom header
String gsmGet(const String& path, int maxAttempts, unsigned long actionTimeoutMs) {
  if (!gsmReady) { Serial.println("[GSM] GET skipped -- not ready"); return ""; }
  if (xSemaphoreTake(gsmMutex, pdMS_TO_TICKS(15000)) != pdTRUE) {
    Serial.println("[GSM] GET mutex timeout -- Core 0 busy, skipping");
    return "";
  }

  // Track 2: request timing
  uint32_t reqId           = ++gsmHttpReqIdCounter;
  uint32_t reqStartMs      = millis();
  int      httpFinalStatus = -1;

  String url = String(API_BASE) + path;
  url += (url.indexOf('?') >= 0 ? "&" : "?");
  url += "device_key=" + String(DEVICE_API_KEY) + "&a7670e=1";

  Serial.printf("[HTTP] start id=%u method=GET path=%s\n", reqId, path.c_str());
  Serial.printf("[GSM] GET %s  attempts=%d\n", path.c_str(), maxAttempts);

  bool networkDown = false;
  for (int attempt = 1; attempt <= maxAttempts; attempt++) {
    if (!gsmEnsurePdp()) {
      Serial.println("[GSM]   PDP context unavailable -- skipping attempt");
      networkDown = true;
      break;
    }

    if (!gsmBeginHttpSession(attempt, maxAttempts, networkDown)) {
      if (networkDown) break;
      continue;
    }
    String r;
    gsmSendCmd("AT+CSSLCFG=\"sslversion\",0,3", 500);        // TLS 1.2 on SIMCom A76xx
    gsmSendCmd("AT+CSSLCFG=\"authmode\",0,0", 300);          // no cert verification
    gsmSendCmd("AT+CSSLCFG=\"ignorelocaltime\",0,1", 300);   // ignore cert expiry
    gsmSendCmd("AT+CSSLCFG=\"enableSNI\",0,1", 300);

    gsmSendCmd("AT+HTTPPARA=\"CID\"," + String(gsmActiveCid), 200);
    gsmSendCmd("AT+HTTPPARA=\"URL\",\"" + url + "\"", 800);
    gsmSendCmd("AT+HTTPPARA=\"SSLCFG\",0", 200);             // bind ssl_ctx 0 to this HTTP session
    gsmSendCmd("AT+HTTPPARA=\"USERDATA\",\"X-Device-Key: " + String(DEVICE_API_KEY) + "\"", 200);
    gsmSendCmd("AT+HTTPPARA=\"REDIR\",1", 150);
    gsmSendCmd("AT+HTTPPARA=\"TIMEOUT\",60", 150);

    Serial.println("[GSM]   AT+HTTPACTION=0 (GET)");
    esp_task_wdt_reset();
    gsmSerial.println("AT+HTTPACTION=0");
    r = gsmWaitHttpAction(actionTimeoutMs, networkDown);
    Serial.printf("[GSM]   -> %s\n", r.c_str());
    if (networkDown) break;

    int acIdx = r.indexOf("+HTTPACTION: 0,");
    int acCode = (acIdx >= 0) ? r.substring(acIdx + 15).toInt() : 0;
    int acComma1 = acIdx >= 0 ? r.indexOf(',', acIdx) : -1;
    int acComma2 = acComma1 >= 0 ? r.indexOf(',', acComma1 + 1) : -1;
    int acLength = acComma2 >= 0 ? r.substring(acComma2 + 1).toInt() : 0;
    gsmLastStatus = acCode;
    const char* acDesc = (acCode == 605) ? " [SSL/TLS handshake failed]" :
                         (acCode == 603) ? " [DNS resolution failed]"     :
                         (acCode == 602) ? " [network open failed]"       :
                         (acCode == 601) ? " [TCP/bearer failure]"        :
                         (acCode == 0)   ? " [no response/timeout]"       : "";
    Serial.printf("[GSM]   HTTP status: %d%s\n", acCode, acDesc);
    if (acCode >= 200 && acCode < 300) {
      String resp = httpReadBody(acLength > 0 ? acLength : 1024);
      gsmSendCmd("AT+HTTPTERM", 400);
      backendReachable = true;
      httpFinalStatus = acCode;
      Serial.printf("[HTTP] end id=%u status=%d dur=%lums\n", reqId, httpFinalStatus, millis() - reqStartMs);
      xSemaphoreGive(gsmMutex);
      return resp;
    }
    if (acCode >= 400 && acCode < 600) {
      String errBody = httpReadBody(acLength > 0 ? acLength : 1024);
      Serial.printf("[GSM]   error body: %s\n", errBody.c_str());
      backendReachable = true;
      gsmSendCmd("AT+HTTPTERM", 400);
      httpFinalStatus = acCode;
      Serial.printf("[HTTP] end id=%u status=%d dur=%lums\n", reqId, httpFinalStatus, millis() - reqStartMs);
      xSemaphoreGive(gsmMutex);
      return "";
    }
    if (acCode == 601 || acCode == 0) {
      Serial.println("[GSM]   TCP/bearer failure -- forcing reconnect");
      gsmLogDiag("HTTPACTION_601_or_0_GET");
      gsmSendCmd("AT+HTTPTERM", 400);
      networkDown = true;
      httpFinalStatus = acCode;
      break;
    }
    // Force modem reconnect only after all retries exhausted.
    if (acCode == 602) {
      gsmSendCmd("AT+HTTPTERM", 400);
      if (attempt >= maxAttempts) {
        Serial.println("[GSM]   602 on final attempt -- forcing modem reconnect");
        networkDown = true;
        break;
      }
      Serial.printf("[GSM]   GET attempt %d failed (602) -- server cold-start? waiting 10s\n", attempt);
      modemYield(10000);
      continue;
    }
    if (acCode == 605) {
      Serial.println("[GSM]   SSL handshake failed -- will retry if attempts remain");
      gsmSendCmd("AT+HTTPTERM", 400);
      modemYield(1500);
      Serial.printf("[GSM]   GET attempt %d failed (605)\n", attempt);
      continue;
    }
    gsmSendCmd("AT+HTTPTERM", 400);
    modemYield(300);
    Serial.printf("[GSM]   GET attempt %d failed\n", attempt);
  }
  if (networkDown) { gsmReady = false; }
  backendReachable = false;
  Serial.printf("[HTTP] end id=%u status=%d dur=%lums (all attempts exhausted, networkDown=%d)\n",
                reqId, httpFinalStatus, millis() - reqStartMs, networkDown ? 1 : 0);
  xSemaphoreGive(gsmMutex);
  return "";
}

// HTTP WORKER TASK  -- runs on Core 0, ALL modem I/O lives here.
void httpWorkerTask(void* param) {
  HttpJob    job;
  HttpResult res;

  // Local timers -- no need for globals, only this task touches them
  unsigned long localGsmRetry      = 0;
  unsigned long localCsqPoll       = 0;
  int           localNoResp        = 0;
  int           tripStartFailCount = 0;  // consecutive reconnect cycles where trip start failed
  unsigned long lastGsmHttpCallMs  = 0;
  int           gsmReconnectFails  = 0;  // consecutive reconnect failures -> exponential backoff

  for (;;) {
    unsigned long now = millis();

    // CSQ signal poll -- modem liveness check, never blocks Core 1
    if (gsmReady && now - localCsqPoll >= CSQ_POLL_MS) {
      localCsqPoll = now;
      if (xSemaphoreTake(gsmMutex, pdMS_TO_TICKS(50)) == pdTRUE) {
        // Drain RX leftovers from the previous HTTP session before sending AT+CSQ.
        while (gsmSerial.available()) gsmSerial.read();
        String csq = gsmSendCmd("AT+CSQ", 800);
        xSemaphoreGive(gsmMutex);
        int idx = csq.indexOf("+CSQ:");
        if (idx >= 0) {
          localNoResp  = 0;
          int prev     = gsmRssi;
          gsmRssi      = csq.substring(idx + 6).toInt();
          if (gsmRssi != prev) statusBarDirty = true;
          Serial.printf("[GSM] signal: %d/31\n", gsmRssi);
        } else {
          localNoResp++;
          Serial.printf("[GSM] CSQ no response (%d/5)\n", localNoResp);
          if (localNoResp >= 5) {
            gsmReady          = false;
            backendReachable  = false;
            gsmRssi           = 0;
            localNoResp       = 0;
            localGsmRetry     = 0;   // trigger reconnect on next iteration
            gsmReconnectFails = 0;   // reset backoff -- fresh drop, not a crash loop
            statusBarDirty    = true;
            Serial.println("[GSM] worker: declared OFFLINE");
          }
        }
      }
    }

    // Reconnect -- runs entirely on Core 0, never freezes the UI
    if (!gsmReady && (int32_t)(now - localGsmRetry) >= (int32_t)GSM_RETRY_MS) {
      Serial.printf("[GSM] worker: reconnecting (attempt, fails=%d)...\n", gsmReconnectFails);
      if (gsmReconnect()) {
        localGsmRetry    = millis();  // success -- reset timer
        gsmReconnectFails = 0;        // reset backoff counter
        backendReachable = true;
        localNoResp      = 0;
        statusBarDirty   = true;
        Serial.println("[GSM] worker: back online");
        modemYield(2000);  // brief settle before NVS loads and first HTTP attempt
        nvsLoadPendingTripBody();
        nvsLoadPendingEvents();
        nvsLoadPendingEnd();
        nvsLoadPendingSnooze();
        nvsLoadLocallyEndedTripId();
        Serial.printf("[GSM] pending: tripStart=%s events=%s snooze=%s end=%s\n",
          pendingTripStartBody.isEmpty() ? "no" : "YES",
          pendingEventsDirty             ? "YES" : "no",
          pendingSnoozeId.isEmpty()      ? "no" : "YES",
          pendingEndTripId.isEmpty()     ? "no" : "YES");
        // Flush in strict order so FK constraints are never violated
        {
          bool skipStaleEnd = false;
          if (!pendingEndTripId.isEmpty() && !pendingTripStartBody.isEmpty()) {
            JsonDocument td;
            if (deserializeJson(td, pendingTripStartBody) == DeserializationError::Ok) {
              String sid = td["trip_id"].as<String>();  // body uses "trip_id", not "id"
              if (sid.length() > 8 && sid == pendingEndTripId) {
                skipStaleEnd = true;
                Serial.println("[trip] stale end matches pending start -- start first, end after");
              }
            }
          }
          if (!skipStaleEnd && !pendingEndTripId.isEmpty() && pendingEndTripId != activeTripId) {
            if (pendingTripStartBody.isEmpty() && !activeTripId.isEmpty()) {
              Serial.printf("[trip/end] clearing stale pendingEnd=%s while activeTrip=%s\n",
                            pendingEndTripId.c_str(), activeTripId.c_str());
              pendingEndTripId = "";
              pendingEndTime   = "";
              nvsSavePendingEnd("");
              nvsSavePendingEndTime("");
            } else {
              flushPendingTripEnd();
            }
          }
        }
        if (!gsmReady) { vTaskDelay(pdMS_TO_TICKS(10)); continue; }
        if (!pendingTripStartBody.isEmpty()) {
          if (pendingTripStartBody.indexOf("\"start_time\"") < 0) {
            String ts = getTimestamp();   // GPS or RTC -- now reliable after CCLK sync
            if (!ts.isEmpty()) {
              // Try to back-calculate actual start time from stored millis offset
              uint32_t storedMs;
              { Preferences p; p.begin("fleet", true);
                storedMs = p.getULong("pendTripMs", 0); p.end(); }
              if (storedMs != 0) {
                uint32_t elapsedMs = (uint32_t)millis() - storedMs;
                if (elapsedMs < 86400000UL) {
                  time_t startEpoch = time(nullptr) - (time_t)(elapsedMs / 1000);
                  struct tm ti;
                  gmtime_r(&startEpoch, &ti);
                  char tsBuf[25];
                  strftime(tsBuf, sizeof(tsBuf), "%Y-%m-%dT%H:%M:%SZ", &ti);
                  ts = String(tsBuf);
                  Serial.printf("[trip] computed start_time=%s (elapsed=%lums)\n",
                                tsBuf, (unsigned long)elapsedMs);
                } else {
                  Serial.printf("[trip] elapsed=%lums > 24h -- device rebooted, using now as start_time\n",
                                (unsigned long)elapsedMs);
                }
              }
              int brace = pendingTripStartBody.lastIndexOf('}');
              if (brace >= 0) {
                pendingTripStartBody = pendingTripStartBody.substring(0, brace)
                  + ",\"start_time\":\"" + ts + "\"}";
                nvsSavePendingTripBody(pendingTripStartBody);
                // Sync the in-memory global so nvsSaveActiveTrip below persists
                if (activeTripStartIso.isEmpty()) activeTripStartIso = ts;
                Serial.printf("[trip] injected start_time=%s into pending body\n", ts.c_str());
              }
            }
          }
          Serial.println("[GSM] syncing offline trip start...");
          String r = httpPost("/trip/start", pendingTripStartBody, 3, 15000);
          // Accept 2xx (created -- server persisted the trip even if HTTPREAD garbled
          if (!r.isEmpty()
           || gsmLastStatus == 200 || gsmLastStatus == 201
           || gsmLastStatus == 409 || gsmLastStatus == 400) {
            tripStartFailCount   = 0;
            pendingTripStartBody = "";
            nvsSavePendingTripBody("");
            { Preferences p; p.begin("fleet", false);
              p.remove("pendTripMs"); p.putString("pendTripId", ""); p.end(); }
            nvsSaveActiveTrip();   // persist so reboot during trip restores correctly
            Serial.println("[trip] offline start synced to server");
          } else {
            tripStartFailCount++;
            Serial.printf("[trip] offline start sync failed (attempt %d) -- modem recovery 3s\n",
                          tripStartFailCount);
            modemYield(3000);
            if (tripStartFailCount < 5) {
              continue;  // hard-block: trip FK doesn't exist yet, telemetry would be orphaned
            }
            // After 5 consecutive failures, allow telemetry/events through to prevent
            Serial.println("[trip] repeated start failures -- releasing telemetry block");
            tripStartFailCount = 0;
          }
        }
        if (!gsmReady) { vTaskDelay(pdMS_TO_TICKS(10)); continue; }
        if (pendingEventsDirty) flushSpiffsEventLog();
        if (!gsmReady) { vTaskDelay(pdMS_TO_TICKS(10)); continue; }
        if (telBufCount > 0) {
          Serial.printf("[GSM] flushing %d buffered telemetry record(s)%s\n",
                        telBufCount,
                        activeTripId.isEmpty() ? "" : " (during active trip)");
          flushTelemetryBuffer();
        }
        // If telemetry flush killed the bearer, bail -- the outer loop will reconnect
        if (!gsmReady) { vTaskDelay(pdMS_TO_TICKS(10)); continue; }
        if (!pendingSnoozeId.isEmpty())  queueSnoozeEvent(pendingSnoozeId);
        if (!pendingEndTripId.isEmpty()) flushPendingTripEnd();
      } else {
        // Reconnect FAILED -- exponential backoff between attempts to give the modem
        gsmReconnectFails++;
        const uint32_t backoffSteps[] = { 15000, 30000, 60000, 90000, 120000 };
        uint32_t backoffMs = backoffSteps[min(gsmReconnectFails - 1, 4)];
        // Set timer so next attempt fires in backoffMs from now.
        localGsmRetry = millis() - GSM_RETRY_MS + backoffMs;
        Serial.printf("[GSM] worker: reconnect failed (fails=%d) -- backoff %lums\n",
                      gsmReconnectFails, (unsigned long)backoffMs);
      }
      // Whether reconnect succeeded or not, yield so Core 1 can breathe
      vTaskDelay(pdMS_TO_TICKS(10));
      continue;
    }

    // Sync a trip start that was created while online (instant-start path).
    if (pendingTripStartBody.isEmpty()) {
      nvsLoadPendingTripBody();
    }

    if ((gsmReady || wifiReady) && !pendingTripStartBody.isEmpty()
        && millis() >= pendingTripStartReadyAt) {
      Serial.println("[GSM] syncing instant trip start...");
      String r = httpPost("/trip/start", pendingTripStartBody, 3, 15000);
      // Accept 2xx (created), 409 (conflict), or 400 (duplicate key) as success.
      if (!r.isEmpty()
       || gsmLastStatus == 200 || gsmLastStatus == 201
       || gsmLastStatus == 409 || gsmLastStatus == 400) {
        pendingTripStartBody = "";
        nvsSavePendingTripBody("");
        { Preferences p; p.begin("fleet", false); p.remove("pendTripId"); p.end(); }
        // Adopt server-returned fields when available (id may differ on 409, and
        if (!r.isEmpty() && gsmLastStatus != 409) {
          JsonDocument sd;
          if (deserializeJson(sd, r) == DeserializationError::Ok) {
            String sid = sd["id"].as<String>();
            if (sid.length() > 10 && sid != activeTripId) {
              activeTripId = sid;
              Serial.printf("[trip] server assigned id=%s\n", sid.c_str());
            }
            String serverStart = sd["start_time"].as<String>();
            if (serverStart.length() > 10 && activeTripStartIso.isEmpty()) {
              activeTripStartIso = serverStart;
              Serial.printf("[trip] adopted server start_time=%s\n", serverStart.c_str());
            }
          }
        }
        // Persist to the actTrip namespace so a reboot during the trip restores
        nvsSaveActiveTrip();
        Serial.println("[trip] instant start synced to server");
      } else {
        Serial.println("[trip] instant start sync failed -- will retry");
      }
    }

    // Retry pending trip/end whenever a channel is available
    if ((gsmReady || wifiReady)
     && !pendingEndTripId.isEmpty()
     && pendingTripStartBody.isEmpty()
     && pendingEndTripId != activeTripId) {
      static unsigned long lastTopLevelEndRetry = 0;
      if (millis() - lastTopLevelEndRetry > 10000UL) {
        lastTopLevelEndRetry = millis();
        Serial.printf("[trip/end] top-level retry for pendingEnd=%s\n",
                      pendingEndTripId.c_str());
        flushPendingTripEnd();
      }
    }

    // Flush offline buffer -- only when nothing urgent is waiting in the queue.
    {
      static unsigned long lastBufFlushMs = 0;
      const unsigned long bufFlushInterval = activeTripId.isEmpty() ? 1000UL : 5000UL;
      if ((gsmReady || wifiReady)
          && telBufCount > 0
          && millis() - lastBufFlushMs >= bufFlushInterval) {
        lastBufFlushMs = millis();
        flushTelemetryBuffer();
      }
    }
    // Flush pending event log -- no queue-empty guard needed.
    if ((gsmReady || wifiReady) && pendingEventsDirty) {
      flushSpiffsEventLog();
    }

    if (xQueueReceive(gHttpJobQ, &job, pdMS_TO_TICKS(100)) == pdTRUE) {
      uint32_t jobStartMs = millis();
      Serial.printf("[worker] picked type=%d %s path=%s wifi=%d gsm=%d wifiSt=%d\n",
                    (int)job.type, job.isPost ? "POST" : "GET", job.path,
                    (int)wifiReady, (int)gsmReady, (int)WiFi.status());
      // Keep telemetry conservative, but let serialized control requests start
      if (!wifiReady && gsmReady && lastGsmHttpCallMs != 0) {
        uint32_t sinceLastCall = millis() - lastGsmHttpCallMs;
        const uint32_t minGapMs = (job.type == HJ_TELEMETRY) ? 5000UL : 1000UL;
        if (sinceLastCall < minGapMs) {
          vTaskDelay(pdMS_TO_TICKS(minGapMs - sinceLastCall));
        }
      }

      int           att = job.maxAttempts     ? job.maxAttempts     : 3;
      unsigned long tms = job.actionTimeoutMs ? job.actionTimeoutMs : 30000;
      String resp = job.isPost
        ? httpPost(String(job.path), String(job.body), att, tms)
        : httpGet(String(job.path), att, tms);
      Serial.printf("[worker] done type=%d status=%d empty=%d dur=%lums\n",
                    (int)job.type, gsmLastStatus, (int)resp.isEmpty(),
                    (unsigned long)(millis() - jobStartMs));

      if (!wifiReady) lastGsmHttpCallMs = millis();  // record time for gap enforcer

      res.type       = job.type;
      res.ok         = !resp.isEmpty();
      res.httpStatus = gsmLastStatus;
      strncpy(res.resp, resp.c_str(), sizeof(res.resp) - 1);
      res.resp[sizeof(res.resp) - 1] = '\0';
      strncpy(res.body, job.body, sizeof(res.body) - 1);
      res.body[sizeof(res.body) - 1] = '\0';
      xQueueSend(gHttpDoneQ, &res, pdMS_TO_TICKS(50));
    }
    modemYield(1);
  }
}

bool sendPauseLoraOnly(const String& tripId, const String& eventTime) {
  if (tripId.isEmpty() || !loraReady || xPortGetCoreID() != 1) return false;
  String eventId = selectedTruckCode + "-P" + String(millis());
  JsonDocument doc;
  doc["trip_id"] = tripId;
  if (!eventTime.isEmpty()) doc["event_time"] = eventTime;
  doc["channel_used"] = "lora";
  String body;
  serializeJson(doc, body);
  if (loraEventSend("/trip/pause", body, eventId, false)) {
    Serial.printf("[pause] sent via LoRa eid=%s\n", eventId.c_str());
    if (pendingPauseTripId == tripId) {
      pendingPauseTripId = "";
      pendingPauseTime   = "";
    }
    return true;
  }
  Serial.printf("[pause] LoRa send failed eid=%s - will retry\n", eventId.c_str());
  return false;
}

bool sendResumeLoraOnly(const String& tripId, const String& eventTime) {
  if (tripId.isEmpty() || !loraReady || xPortGetCoreID() != 1) return false;
  String eventId = selectedTruckCode + "-R" + String(millis());
  JsonDocument doc;
  doc["trip_id"] = tripId;
  if (!eventTime.isEmpty()) doc["event_time"] = eventTime;
  doc["channel_used"] = "lora";
  String body;
  serializeJson(doc, body);
  if (loraEventSend("/trip/resume", body, eventId, false)) {
    Serial.printf("[resume] sent via LoRa eid=%s\n", eventId.c_str());
    if (pendingResumeTripId == tripId) {
      pendingResumeTripId = "";
      pendingResumeTime   = "";
    }
    return true;
  }
  Serial.printf("[resume] LoRa send failed eid=%s - will retry\n", eventId.c_str());
  return false;
}
// Enqueue a standard trip event (pause/resume).
void queueTripEvent(HttpJobType type, const char* path, const String& tripId) {
  if (tripId.isEmpty()) return;
  char evtChar = (type == HJ_PAUSE) ? 'P' : 'R';
  String evtTs = getTimestamp();  // capture now, before any network delay

  if (type == HJ_PAUSE && xPortGetCoreID() == 1 && loraReady) {
    pendingPauseTripId = tripId;
    pendingPauseTime   = evtTs;
    if (sendPauseLoraOnly(tripId, evtTs)) return;
    Serial.println("[pause] LoRa send failed -- also queuing WiFi/GSM fallback");
  }

  if (type == HJ_RESUME && xPortGetCoreID() == 1 && loraReady) {
    pendingResumeTripId = tripId;
    pendingResumeTime   = evtTs;
    if (sendResumeLoraOnly(tripId, evtTs)) return;
    Serial.println("[resume] LoRa send failed -- also queuing WiFi/GSM fallback");
  }


  if (!gsmReady && !wifiReady) {
    const char* evtType = (type == HJ_PAUSE) ? "trip_pause" : "trip_resume";
    spiffsLogEvent(evtType, tripId, evtTs);
    Serial.printf("[%s] offline -- saved to evt_log.jsonl ts=%s\n", path, evtTs.c_str());
    return;
  }
  HttpJob job;
  job.type            = type;
  job.isPost          = true;
  job.maxAttempts     = 1;      // fire-and-forget -- device already changed state locally
  job.actionTimeoutMs = 8000;   // fail fast so dashboard reflects quickly
  strlcpy(job.path, path, sizeof(job.path));
  if (evtTs.isEmpty()) {
    snprintf(job.body, sizeof(job.body), "{\"trip_id\":\"%s\"}", tripId.c_str());
  } else {
    snprintf(job.body, sizeof(job.body),
             "{\"trip_id\":\"%s\",\"event_time\":\"%s\"}", tripId.c_str(), evtTs.c_str());
  }
  if (xQueueSendToFront(gHttpJobQ, &job, pdMS_TO_TICKS(1500)) != pdTRUE) {
    const char* evtType = (type == HJ_PAUSE) ? "trip_pause" : "trip_resume";
    spiffsLogEvent(evtType, tripId, evtTs);
    Serial.printf("[queue] FULL after 1.5s -- %s saved to evt_log.jsonl ts=%s\n", path, evtTs.c_str());
  } else {
    if (type == HJ_PAUSE) {
      pendingPauseTripId = "";
      pendingPauseTime   = "";
    } else {
      pendingResumeTripId = "";
      pendingResumeTime   = "";
    }
  }
}

// Build ISO8601 UTC timestamp.
String getTimestamp() {
  // GPS time -- sub-second accuracy, no network dependency
  if (gpsFix &&
      (millis() - lastGpsFix <= GPS_FIX_TIMEOUT_MS) &&
      gps.date.isValid() && gps.time.isValid() &&
      gps.date.year() > 2000 &&
      gps.date.year() < 2036 &&
      gps.date.month() >= 1 && gps.date.month() <= 12 &&
      gps.date.day() >= 1 && gps.date.day() <= 31 &&
      gps.time.hour() <= 23 &&
      gps.time.minute() <= 59 &&
      gps.time.second() <= 59) {
    char buf[25];
    snprintf(buf, sizeof(buf), "%04d-%02d-%02dT%02d:%02d:%02dZ",
             gps.date.year(), gps.date.month(), gps.date.day(),
             gps.time.hour(), gps.time.minute(), gps.time.second());
    return String(buf);
  }
  struct tm ti;
  if (getLocalTime(&ti, 0)
      && ti.tm_year >= 124 && ti.tm_year <= 135        // 2024-2035
      && ti.tm_mon >= 0 && ti.tm_mon <= 11
      && ti.tm_mday >= 1 && ti.tm_mday <= 31) {        // day 1-31
    char buf[25];
    strftime(buf, sizeof(buf), "%Y-%m-%dT%H:%M:%SZ", &ti);
    return String(buf);
  }
  return "";   // no time source available
}

void queueEndTrip(const String& tripId, const String& endTime = "") {
  if (tripId.isEmpty()) return;
  HttpJob job;
  job.type            = HJ_END;
  job.isPost          = true;
  job.maxAttempts     = 2;      // 2 attempts -- critical event, must not silently fail
  job.actionTimeoutMs = 10000;
  strlcpy(job.path, "/trip/end", sizeof(job.path));
  if (gpsFix && !endTime.isEmpty()) {
    snprintf(job.body, sizeof(job.body),
      "{\"trip_id\":\"%s\",\"end_lat\":%.6f,\"end_lon\":%.6f,\"end_time\":\"%s\"}",
      tripId.c_str(), gpsLat, gpsLon, endTime.c_str());
  } else if (gpsFix) {
    snprintf(job.body, sizeof(job.body),
      "{\"trip_id\":\"%s\",\"end_lat\":%.6f,\"end_lon\":%.6f}",
      tripId.c_str(), gpsLat, gpsLon);
  } else if (!endTime.isEmpty()) {
    snprintf(job.body, sizeof(job.body),
      "{\"trip_id\":\"%s\",\"end_time\":\"%s\"}",
      tripId.c_str(), endTime.c_str());
  } else {
    snprintf(job.body, sizeof(job.body), "{\"trip_id\":\"%s\"}", tripId.c_str());
  }

  if (xPortGetCoreID() == 1 && loraReady) {
    String resp = commEventSend("/trip/end", String(job.body));
    if (lastCommChannel == CH_LORA_OK) {
      Serial.println("[trip/end] sent via LoRa -- skipping queue");
      if (pendingEndTripId == tripId) {
        pendingEndTripId = "";
        pendingEndTime   = "";
        nvsSavePendingEnd("");
        nvsSavePendingEndTime("");
      }
      return;
    }
  }
  // NVS already holds pendingEndTripId as a backup, but best effort here first.
  if (xQueueSend(gHttpJobQ, &job, pdMS_TO_TICKS(1000)) != pdTRUE) {
    Serial.printf("[queue] FULL after wait -- trip/end in NVS, will retry on reconnect\n");
  }
}

bool sendSnoozeLoraOnly(const String& tripId) {
  if (tripId.isEmpty() || !loraReady || xPortGetCoreID() != 1) return false;
  String eventId = selectedTruckCode + "-S" + String(millis());
  JsonDocument doc;
  doc["trip_id"] = tripId;
  doc["duration_ms"] = 600000;
  doc["channel_used"] = "lora";
  String body;
  serializeJson(doc, body);
  if (loraEventSend("/trip/snooze", body, eventId)) {
    Serial.printf("[snooze] sent via LoRa eid=%s\n", eventId.c_str());
    if (pendingSnoozeId == tripId) {
      pendingSnoozeId = "";
      nvsSavePendingSnooze("");
    }
    return true;
  }
  Serial.printf("[snooze] LoRa send failed eid=%s - will retry\n", eventId.c_str());
  return false;
}

void queueSnoozeEvent(const String& tripId) {
  if (tripId.isEmpty()) {
    Serial.println("[snooze] skipped - no active trip id");
    return;
  }
  HttpJob job;
  job.type            = HJ_SNOOZE;
  job.isPost          = true;
  job.maxAttempts     = 1;
  job.actionTimeoutMs = 7000;
  strlcpy(job.path, "/trip/snooze", sizeof(job.path));
  snprintf(job.body, sizeof(job.body), "{\"trip_id\":\"%s\",\"duration_ms\":600000}", tripId.c_str());

  // THROUGH to the worker queue so WiFi/GSM also delivers -- without this,
  if (xPortGetCoreID() == 1 && loraReady) {
    pendingSnoozeId = tripId;
    nvsSavePendingSnooze(tripId);
    if (sendSnoozeLoraOnly(tripId)) return;
    Serial.println("[snooze] LoRa send failed -- also queuing WiFi/GSM fallback");
  }

  if (xQueueSend(gHttpJobQ, &job, 0) == pdTRUE) {
    Serial.println("[snooze] queued for backend");
  } else {
    pendingSnoozeId = tripId;
    nvsSavePendingSnooze(tripId);
    spiffsLogEvent("snooze", tripId, getTimestamp());
    Serial.println("[snooze] queue full - saved to NVS + evt_log.jsonl");
  }
}
void bufferTelemetry(const String& body) {
  // Guard against SPIFFS overflow -- 32 KB headroom keeps the filesystem healthy.
  // At 300 B/record this is ~100 records of safety margin.
  size_t freeBytes = SPIFFS.totalBytes() > 0 ? (SPIFFS.totalBytes() - SPIFFS.usedBytes()) : 0;
  if (freeBytes < 32768) {
    Serial.printf("[tel] SPIFFS low (%zu B free) -- offline record dropped\n", freeBytes);
    return;
  }
  xSemaphoreTake(spiffsMutex, portMAX_DELAY);
  File f = SPIFFS.open("/tel_buf.log", FILE_APPEND);
  if (!f) { xSemaphoreGive(spiffsMutex); Serial.println("[tel] FS write FAIL -- record lost"); return; }
  f.println(body);
  f.close();
  xSemaphoreGive(spiffsMutex);
  telBufCount++;
}

bool flushTelemetryBuffer() {
  const int MAX_FLUSH_PER_CALL = 5;
  static File flushFile;
  if (!flushFile) {
    xSemaphoreTake(spiffsMutex, portMAX_DELAY);
    if (!SPIFFS.exists("/tel_flush.log")) {
      if (!SPIFFS.exists("/tel_buf.log")) {
        xSemaphoreGive(spiffsMutex);
        return true;
      }
      SPIFFS.rename("/tel_buf.log", "/tel_flush.log");
      telFlushPtr = 0;
      nvsSaveTelPtr(0);
    }
    flushFile = SPIFFS.open("/tel_flush.log", "r");
    if (flushFile && telFlushPtr > 0) flushFile.seek(telFlushPtr);
    xSemaphoreGive(spiffsMutex);
    if (!flushFile) return true;
  }

  int sentThisCall = 0;
  while (flushFile.available()) {
    // Always make forward progress: send at least one record per call before
    if (sentThisCall > 0 && (pendingEventsDirty || uxQueueMessagesWaiting(gHttpJobQ) > 0))
      return true;  // file position preserved in static handle; pointer already saved
    if (sentThisCall >= MAX_FLUSH_PER_CALL)
      return true;

    String line = flushFile.readStringUntil('\n');
    uint32_t posAfter = (uint32_t)flushFile.position();
    line.trim();
    if (line.length() < 5) {
      // Blank/corrupt line -- skip and advance pointer past it
      telFlushPtr = posAfter;
      nvsSaveTelPtr(telFlushPtr);
      continue;
    }
    line.replace("\"comm_channel\":\"wifi\"", "\"comm_channel\":\"buffered\"");
    line.replace("\"comm_channel\":\"gsm\"",  "\"comm_channel\":\"buffered\"");
    if (line.indexOf("\"sent_at\":\"2099") >= 0 ||
        line.indexOf("\"sent_at\":\"1970") >= 0 ||
        line.indexOf("T00:00:00Z\"") >= 0) {
      int sa = line.indexOf("\"sent_at\":");
      if (sa >= 0) {
        int valStart = line.indexOf('"', sa + 10);
        int valEnd   = (valStart >= 0) ? line.indexOf('"', valStart + 1) : -1;
        if (valEnd >= 0) {
          // Replace the value with null so the column stays nullable
          line = line.substring(0, sa + 10) + "null" + line.substring(valEnd + 1);
        }
      }
    }

    String r = httpPost("/telemetry", line, 1, 20000);
    if (r.isEmpty()) {
      // Network failure -- close file but pointer stays at last confirmed position.
      // Next call reopens and seeks to that position, skipping already-confirmed records.
      flushFile.close();
      nvsSaveTelPtr(telFlushPtr);
      return false;
    }

    // POST confirmed -- advance pointer past this record and persist immediately.
    telFlushPtr = posAfter;
    nvsSaveTelPtr(telFlushPtr);
    if (telBufCount > 0) telBufCount--;
    sentThisCall++;
    modemYield(50);
  }

  flushFile.close();
  xSemaphoreTake(spiffsMutex, portMAX_DELAY);
  SPIFFS.remove("/tel_flush.log");
  xSemaphoreGive(spiffsMutex);
  telFlushPtr = 0;
  nvsSaveTelPtr(0);
  telBufCount = countFileLines("/tel_buf.log");
  return true;
}


void sendTelemetry() {
  if (activeTripId.isEmpty() || selectedTruckId.isEmpty()) return;
  if (!pendingTripStartBody.isEmpty()) {
    // Advance lastTelemetryPost so the caller's `millis() - lastTelemetryPost >
    lastTelemetryPost = millis();
    Serial.println("[telemetry] deferred -- trip/start not yet synced");
    return;
  }

  bool fuelReady = (obdFuelPct >= 0.0f);
  bool gpsReady  = gpsFix;
  bool spdReady  = (obdSpeedKmh > 0.0f) || (gpsFix && gpsSpeedKmh > 0.0f);
  if (!fuelReady && !gpsReady && !spdReady) {
    lastTelemetryPost = millis();
    Serial.println("[telemetry] suppressed -- no valid sensors yet (warmup)");
    return;
  }

  lastTelemetryPost = millis();

  telSeq++;

  String sentAtStr = getTimestamp();
  const char* sentAt = sentAtStr.c_str();

  JsonDocument body;
  body["truck_id"]      = selectedTruckId;
  body["driver_id"]     = driverId;
  body["trip_id"]       = activeTripId;
  body["seq"]           = (int)telSeq;
  body["comm_channel"]  = "wifi";   // worker swaps to "gsm" if WiFi fails
  // Body trim (A7670E HTTPDATA was rejecting 696 B POSTs over TLS -- keeping
  if (state == TRIP_PAUSED) body["engine_status"] = "idle";
  // HMI-side trip clock -- lets the dashboard render the driver's actual
  unsigned long currentRestMs = pausedTotal + ((state == TRIP_PAUSED && pauseStart > 0) ? (millis() - pauseStart) : 0);
  body["hmi_driving_sec"] = (unsigned long)tripElapsedSec();
  body["hmi_rest_sec"]    = (unsigned long)(currentRestMs / 1000UL);
  // Body trim: hmi_trip_status only emitted when paused (the backend treats
  if (state == TRIP_PAUSED) body["hmi_trip_status"] = "paused";
  // Publish the HMI's own "next rest in" countdown so the dashboard and
  bool snoozeActive = (restAlertSnoozedUntil != 0 && millis() < restAlertSnoozedUntil);
  if (state == TRIP_ACTIVE && !snoozeActive && lastRestMs > 0) {
    unsigned long sinceR = currentSinceRestSec();
    unsigned long thrSec = restThresholdMs / 1000UL;
    unsigned long nextRestInSec = (sinceR < thrSec) ? (thrSec - sinceR) : 0;
    body["next_rest_in_sec"] = nextRestInSec;
  }
  nvsSaveTripClock(body["hmi_driving_sec"].as<unsigned long>(), body["hmi_rest_sec"].as<unsigned long>());
  if (sentAtStr.length()) body["sent_at"] = sentAt;
  // Model C: delta_time_sec for OBD distance estimation
  unsigned long nowMs = millis();
  if (prevTelSentMs > 0) {
    float deltaSec = (float)(nowMs - prevTelSentMs) / 1000.0f;
    if (deltaSec > 0.5f && deltaSec < 300.0f) body["delta_time_sec"] = deltaSec;
  }
  prevTelSentMs = nowMs;

  if (gpsFix) {
    body["lat"]       = (float)gpsLat;
    body["lon"]       = (float)gpsLon;
    // Body trim: gps_valid:true is implied by lat/lon presence; the false
    if (gps.hdop.isValid()) {
      body["gps_accuracy"] = (float)(gps.hdop.hdop() * 2.5f);
    }
    if (telGpsDistKm > 0.0f) {
      body["distance_gps_delta"] = telGpsDistKm;
    }
  }
  // Roll this cycle's GPS delta into the per-trip GPS integrator before
  if (gpsTripIntegratedKm >= 0.0f && telGpsDistKm > 0.0f) {
    gpsTripIntegratedKm += telGpsDistKm;
  }
  telGpsDistKm = 0.0f;  // reset accumulator regardless -- avoids double-counting on next send

  // Speed: OBD2 primary (integer km/h direct from ECU), GPS fallback
  if (obdSpeedKmh >= 0.0f) {
    body["speed"] = (int)obdSpeedKmh;
  } else if (gpsFix) {
    body["speed"] = (float)gpsSpeedKmh;
  }
  // Fuel level -- only emit when:
  if (obdFuelPct >= 0.0f && obdFuelValid) {
    body["fuel_level"] = (float)obdFuelPct;
    // Also emit the absolute litres so the dashboard can display them next
    if (fuelTankCapacityL > 1.0f) {
      float litres = (float)obdFuelPct * fuelTankCapacityL / 100.0f;
      body["fuel_level_l"] = roundf(litres * 10.0f) / 10.0f;   // 0.1 L precision
      body["tank_capacity_l"] = fuelTankCapacityL;
    }
  }
  // Odometer fallback chain (most accurate -> least):
  float publishedDeltaKm = 0.0f;
  if (obdOdometerKm >= 0.0f) {
    body["odometer_km"] = (float)obdOdometerKm;
    body["odometer_source"] = "obd2";
  } else if (obdTripIntegratedKm >= 0.0f) {
    body["odometer_km"] = (float)obdTripIntegratedKm;
    body["odometer_source"] = "speed_integrated_trip";
    static float prevObdInt = 0.0f;
    float d = obdTripIntegratedKm - prevObdInt;
    if (d > 0.0f && d < 1.0f) publishedDeltaKm = d;
    prevObdInt = obdTripIntegratedKm;
  } else if (gpsTripIntegratedKm >= 0.0f) {
    body["odometer_km"] = (float)gpsTripIntegratedKm;
    body["odometer_source"] = "gps_integrated_trip";
    static float prevGpsInt = 0.0f;
    float d = gpsTripIntegratedKm - prevGpsInt;
    if (d > 0.0f && d < 1.0f) publishedDeltaKm = d;
    prevGpsInt = gpsTripIntegratedKm;
  }
  // Per-truck lifetime accumulator -- survives reboot via NVS so the device
  if (truckLifetimeKm >= 0.0f && publishedDeltaKm > 0.0f) {
    truckLifetimeKm += publishedDeltaKm;
    if (truckLifetimeKm - truckLifetimeSavedKm >= LIFETIME_SAVE_STEP_KM) {
      nvsSaveTruckLifetimeKm(truckLifetimeKm);
    }
  }
  // Body trim:
  if (obdFuelSource && *obdFuelSource) body["fuel_source"] = obdFuelSource;
  if (obdFuelConfidence > 0)           body["fuel_confidence"] = obdFuelConfidence;

  // Extended OBD2 fields -- omitted when ECU does not respond to that PID
  if (obdRpm >= 0.0f)           body["engine_rpm"]         = (int)obdRpm;
  if (obdEngineLoadPct >= 0.0f) body["engine_load_pct"]    = (float)obdEngineLoadPct;
  if (obdThrottlePct >= 0.0f)   body["throttle_pct"]       = (float)obdThrottlePct;
  if (obdMafGps >= 0.0f)        body["maf_gps"]            = (float)obdMafGps;
  if (obdCoolantTempC > -40.1f) body["coolant_temp_c"]     = (float)obdCoolantTempC;
  if (obdRuntimeSec >= 0)       body["engine_runtime_sec"] = obdRuntimeSec;
  if (canObd2Ready) {
    body["dtc_present"] = obdDtcPresent;
    body["dtc_count"]   = (int)obdDtcCount;
  }

  // Device-side next rest alert time -- more accurate than server recalculation.
  // Only include when driving (not paused) and RTC is synced.
  if (state == TRIP_ACTIVE) {
    struct tm ti;
    if (getLocalTime(&ti, 0) && ti.tm_year > 100) {
      long remainingMs;
      if (restAlertSnoozedUntil != 0 && millis() < restAlertSnoozedUntil) {
        remainingMs = (long)(restAlertSnoozedUntil - millis());
      } else {
        remainingMs = (long)restThresholdMs - (long)(millis() - lastRestMs);
      }
      if (remainingMs > 0) {
        time_t nowEpoch  = mktime(&ti);
        time_t alertAt   = nowEpoch + (remainingMs / 1000L);
        struct tm* alertTm = gmtime(&alertAt);
        char alertBuf[25];
        strftime(alertBuf, sizeof(alertBuf), "%Y-%m-%dT%H:%M:%SZ", alertTm);
        body["next_rest_alert_at"] = alertBuf;
      }
    }
  }

  String bs; serializeJson(body, bs);

  lastTelemetryPost = millis();   // always advance -- keeps display + offline buffer on 5s cadence

  // Offline -- buffer every 5s for full-resolution SPIFFS replay on reconnect.
  if (!gsmReady && !wifiReady && !loraReady) {
    bs.replace("\"comm_channel\":\"wifi\"", "\"comm_channel\":\"buffered\"");
    bs.replace("\"comm_channel\":\"gsm\"",  "\"comm_channel\":\"buffered\"");
    bufferTelemetry(bs);
    Serial.printf("[telemetry] OFFLINE -- buffered locally (%d total)\n", telBufCount);
    return;
  }

  static uint32_t lastHttpPush = 0;
  const bool loraTelemetryAvailable = loraReady && !loraGatewayBackoffActive();
  bool movingNow = (obdSpeedKmh >= 5.0f) || (gpsFix && gpsSpeedKmh >= 5.0f);
  uint32_t pushInterval = loraTelemetryAvailable ? LORA_TELEMETRY_PUSH_MS
                        : wifiReady              ? TELEMETRY_PUSH_MS
                        :                          30000UL;
  if (movingNow && pushInterval > TELEMETRY_PUSH_MS) pushInterval = TELEMETRY_PUSH_MS;
  if (millis() - lastHttpPush < pushInterval) {
    Serial.println("[telemetry] sampled (push deferred)");
    return;
  }

  // Intelligent traffic steering: LoRa -> GSM(LTE/2G) -> WiFi -> SPIFFS

  // Dropped from compact form:
  if (loraTelemetryAvailable && xPortGetCoreID() == 1) {
    JsonDocument lDoc;
    lDoc["tid"] = activeTripId;
    lDoc["vid"] = selectedTruckId;
    lDoc["seq"] = (int)telSeq;
    // HMI clock snapshot -- short keys to stay under LoRa 255-byte MTU.
    // Gateway forwards as-is; backend can use hmi_driving_sec when present.
    lDoc["hds"] = (unsigned long)tripElapsedSec();
    lDoc["hrs"] = (unsigned long)(currentRestMs / 1000UL);
    if (!body["next_rest_in_sec"].isNull()) {
      lDoc["nrs"] = body["next_rest_in_sec"].as<unsigned long>();
    }
    if (sentAtStr.length()) lDoc["sent_at"] = sentAt;
    if (gpsFix) {
      lDoc["lat"] = (float)gpsLat;
      lDoc["lon"] = (float)gpsLon;
    }
    if (obdSpeedKmh >= 0.0f)      lDoc["spd"]  = (int)obdSpeedKmh;
    else if (gpsFix)              lDoc["spd"]  = (int)gpsSpeedKmh;
    // Match the WiFi/GSM body guard (see body["fuel_level"] above): only emit
    if (obdFuelPct >= 0.0f && obdFuelValid) lDoc["fuel"] = (float)obdFuelPct;
    String lBody;
    serializeJson(lDoc, lBody);
    String loraEventId = selectedTruckCode + "-T" + String(millis());
    Serial.printf("[telemetry] LoRa attempt -- %d bytes seq=%u\n", lBody.length(), telSeq);
    if (loraEventSend("/telemetry", lBody, loraEventId)) {
      lastHttpPush    = millis();
      lastCommChannel = CH_LORA_OK;
      lastLoraOkMs    = millis();
      Serial.printf("[telemetry] sent via LoRa (seq=%u)\n", telSeq);
      return;
    }
    // LoRa failed (no ACK) -- fall through to cellular.
  }


  HttpJob job = {};
  job.type            = HJ_TELEMETRY;
  job.isPost          = true;
  job.maxAttempts     = 2;   // 1 retry: gives Render free-tier 20s to cold-start
  job.actionTimeoutMs = 8000;
  strlcpy(job.path, "/telemetry", sizeof(job.path));
  bs.toCharArray(job.body, sizeof(job.body));
  if (telemetryJobQueued) {
    if (telemetryJobQueuedAt && millis() - telemetryJobQueuedAt > STUCK_JOB_MS) {
      Serial.printf("[telemetry] WARN: job stuck >%lums -- releasing flag\n",
                    (unsigned long)STUCK_JOB_MS);
      telemetryJobQueued   = false;
      telemetryJobQueuedAt = 0;
    } else {
      lastHttpPush = millis();
      Serial.println("[telemetry] fresh job already pending -- coalesced");
      return;
    }
  }
  if (uxQueueMessagesWaiting(gHttpJobQ) > 4 || xQueueSend(gHttpJobQ, &job, 0) != pdTRUE) {
    bs.replace("\"comm_channel\":\"wifi\"",     "\"comm_channel\":\"buffered\"");
    bs.replace("\"comm_channel\":\"gsm\"",      "\"comm_channel\":\"buffered\"");
    bufferTelemetry(bs);
    lastHttpPush = millis();
    Serial.printf("[telemetry] queue full -- buffered (%d)\n", telBufCount);
  } else {
    telemetryJobQueued   = true;
    telemetryJobQueuedAt = millis();
    lastHttpPush = millis();
    Serial.println("[telemetry] queued");
  }
}

// PROCESS HTTP RESULTS  -- called in main loop, handles worker task responses
void processHttpDone() {
  // HttpResult is about 3 KB after expanding the WiFi alerts payload buffer.
  static HttpResult res;
  while (xQueueReceive(gHttpDoneQ, &res, 0) == pdTRUE) {
    switch (res.type) {

      case HJ_HEALTH:
        break;

      case HJ_HEARTBEAT:
        heartbeatJobQueued = false;
        break;

      case HJ_TELEMETRY:
        telemetryJobQueued   = false;
        telemetryJobQueuedAt = 0;
        if (res.ok || res.httpStatus == 200 || res.httpStatus == 201) {
          Serial.printf("[telemetry] push OK -- HTTP %d\n", res.httpStatus);
        } else {
          if (res.body[0]) {
            bufferTelemetry(String(res.body));
            Serial.printf("[telemetry] async failed HTTP %d -- buffered (%d total)\n",
                          res.httpStatus, telBufCount);
          }
        }
        break;

      case HJ_SNOOZE:
        if (res.ok || res.httpStatus == 200 || res.httpStatus == 201) {
          pendingSnoozeId = "";
          nvsSavePendingSnooze("");
          Serial.printf("[snooze] logged to backend (HTTP %d)\n", res.httpStatus);
        } else {
          Serial.println("[snooze] backend log failed -- will retry on reconnect");
        }
        break;

      case HJ_PAUSE:
        if (res.ok) {
          // WiFi/GSM path delivered the pause -- stop the LoRa retry loop so it
          if (!pendingPauseTripId.isEmpty()) {
            Serial.printf("[pause] WiFi/GSM ACK -- clearing LoRa pending state\n");
            pendingPauseTripId = "";
            pendingPauseTime   = "";
          }
        } else {
          if (res.httpStatus == 0 || res.httpStatus >= 500) {
            // Network/server error -- save to SPIFFS event log for replay on reconnect
            JsonDocument evtDoc;
            if (deserializeJson(evtDoc, res.body) == DeserializationError::Ok) {
              String evTs = evtDoc["event_time"].isNull() ? "" : evtDoc["event_time"].as<String>();
              spiffsLogEvent("trip_pause", evtDoc["trip_id"].as<String>(), evTs);
            }
            Serial.println("[pause] network error -- saved to evt_log.jsonl");
          } else if (res.httpStatus == 400) {
            if (!pendingPauseTripId.isEmpty()) {
              Serial.printf("[pause] 400 (already paused) -- clearing LoRa pending state\n");
              pendingPauseTripId = "";
              pendingPauseTime   = "";
            }
          } else {
            Serial.printf("[pause] server rejected (%d) -- not retrying\n", res.httpStatus);
          }
        }
        break;

      case HJ_RESUME:
        if (res.ok) {
          if (!pendingResumeTripId.isEmpty()) {
            Serial.printf("[resume] WiFi/GSM ACK -- clearing LoRa pending state\n");
            pendingResumeTripId = "";
            pendingResumeTime   = "";
          }
        } else {
          if (res.httpStatus == 0 || res.httpStatus >= 500) {
            // Network/server error -- save to SPIFFS event log for replay on reconnect
            JsonDocument evtDoc;
            if (deserializeJson(evtDoc, res.body) == DeserializationError::Ok) {
              String evTs = evtDoc["event_time"].isNull() ? "" : evtDoc["event_time"].as<String>();
              spiffsLogEvent("trip_resume", evtDoc["trip_id"].as<String>(), evTs);
            }
            Serial.println("[resume] network error -- saved to evt_log.jsonl");
          } else if (res.httpStatus == 400) {
            if (!pendingResumeTripId.isEmpty()) {
              Serial.printf("[resume] 400 (already active) -- clearing LoRa pending state\n");
              pendingResumeTripId = "";
              pendingResumeTime   = "";
            }
          } else {
            Serial.printf("[resume] server rejected (%d) -- not retrying\n", res.httpStatus);
          }
        }
        break;

      case HJ_END: {
        // 404 is ambiguous: it means "trip not on backend." That could be
        const bool startSynced = pendingTripStartBody.isEmpty();
        bool endConfirmed = res.ok                    // 2xx -- server processed it
                         || res.httpStatus == 200
                         || res.httpStatus == 201     // same -- body garbled but server confirmed
                         || (res.httpStatus == 404 && startSynced)  // really gone, not pre-sync
                         || res.httpStatus == 409     // conflict -- already ended
                         || res.httpStatus == 400;    // bad request -- won't succeed on retry
        if (endConfirmed) {
          pendingEndTripId = "";
          pendingEndTime   = "";
          nvsSavePendingEnd("");
          nvsSavePendingEndTime("");
          locallyEndedTripId = "";
          nvsSaveLocallyEndedTripId("");
          Serial.printf("[trip/end] confirmed (HTTP %d) -- cleared NVS\n", res.httpStatus);
        } else {
          Serial.printf("[trip/end] async failed (HTTP %d) -- will retry\n", res.httpStatus);
        }
        break;
      }

      case HJ_ALERT:
        alertJobQueued   = false;
        alertJobQueuedAt = 0;
        if (res.ok && !alertOverlayActive) {
          processAlertResponse(String(res.resp));
        }
        break;

      case HJ_PENDING_ACK:
        if (res.ok || res.httpStatus == 200) {
          Serial.printf("[pending-ack] HTTP %d -- backend closed loop\n", res.httpStatus);
        } else {
          Serial.printf("[pending-ack] HTTP %d -- backend retry on next alert poll\n", res.httpStatus);
        }
        break;

      case HJ_EXT_TRIP: {
        bool changed = false;
        if (res.resp[0] == '\0' || res.httpStatus == 204) {
          if (!externalTripId.isEmpty()) {
            externalTripId = ""; externalDriverId = ""; externalDriverName = "";
            externalTripStart = ""; externalPausedAt = ""; externalRestSeconds = 0;
            externalNextRestAlert = "";
            externalChannel = "";
            changed = true;
            Serial.println("[ext-trip] no active trip on server -- banner cleared");
          }
        } else {
          JsonDocument doc;
          if (deserializeJson(doc, res.resp) == DeserializationError::Ok) {
            String newTripId = doc["trip_id"].as<String>();
            if (!newTripId.isEmpty()) {
              changed = (newTripId != externalTripId);
              externalTripId      = newTripId;
              externalDriverId    = doc["driver_id"].as<String>();
              externalDriverName  = doc["driver_name"].as<String>();
              externalTripStart   = doc["start_time"].as<String>();
              externalPausedAt    = doc["paused_at"].as<String>();
              externalNextRestAlert = doc["next_rest_alert_at"].as<String>();
              externalRestSeconds = doc["total_rest_seconds"] | 0;
              externalChannel     = doc["channel_used"].as<String>();
              activeTripStatus    = doc["trip_status"] | "active";
              Serial.printf("[ext-trip] detected trip=%s driver=%s channel=%s\n",
                externalTripId.c_str(), externalDriverName.c_str(), externalChannel.c_str());
            }
          }
        }
        if (changed && state == READY) screenReady();
        break;
      }
    }
  }
}

// SCREENS
void screenBoot() {
  drawGradientBg();
  drawSoftCard(54, 50, 372, 164, C_ACCENT, true);
  tft.fillRect(108, 66, 264, 4, C_ACCENT);
  tft.setTextColor(C_ACCENT);
  tft.drawCentreString("FleetMonitor", SCREEN_W / 2, 78, 4);
  tft.setTextColor(C_DIM);
  tft.drawCentreString("Driver Terminal  v1.0", SCREEN_W / 2, 118, 2);
  tft.fillRect(160, 140, 160, 2, C_BTN);
  tft.setTextColor(C_DIM);
  tft.drawCentreString("Initializing vehicle systems...", SCREEN_W / 2, 166, 2);
  tft.fillRoundRect(60, 230, 360, 16, 5, C_PANEL);
  tft.drawRoundRect(60, 230, 360, 16, 5, C_BTN);
  beepBoot();
  for (int i = 0; i <= 100; i += 4) {
    tft.fillRoundRect(61, 231, (358 * i) / 100, 14, 4, C_ACCENT);
    delay(5);
  }
  delay(80);
}

void screenGsmConnecting() {
  drawGradientBg();
  tft.setTextColor(C_ACCENT);
  tft.drawCentreString("Connecting Cellular", SCREEN_W / 2, 100, 4);
  tft.setTextColor(C_DIM);
  tft.drawCentreString("A7670E 4G Module", SCREEN_W / 2, 148, 2);
  tft.drawCentreString("Please wait...", SCREEN_W / 2, 180, 2);
}
void screenGsmFailed() {
  drawGradientBg();
  tft.setTextColor(TFT_RED);
  tft.drawCentreString("Cellular Unavailable", SCREEN_W / 2, 108, 4);
  tft.setTextColor(C_DIM);
  tft.drawCentreString("Offline mode -- cached data only", SCREEN_W / 2, 168, 2);
  delay(2000);
}
void screenGsmOk() {
  drawGradientBg();
  tft.setTextColor(TFT_GREEN);
  tft.drawCentreString("Cellular Connected!", SCREEN_W / 2, 108, 4);
  tft.setTextColor(C_DIM);
  tft.drawCentreString("4G data bearer active", SCREEN_W / 2, 168, 2);
  delay(900);
}

// PIN numpad
#define NP_W   108
#define NP_H    44
#define NP_GAP   7
#define NP_X    71
#define NP_Y   116

const char* NP_KEYS[] = { "1","2","3","4","5","6","7","8","9","CLR","0","OK" };

void drawNumpad() {
  for (int i = 0; i < 12; i++) {
    int c = i % 3, r = i / 3;
    int kx = NP_X + c * (NP_W + NP_GAP);
    int ky = NP_Y + r * (NP_H + NP_GAP);
    uint32_t col = C_BTN;
    if (i ==  9) col = C_PANEL;
    if (i == 11) col = 0x1940;  // dark green accent
    // Shadow
    tft.fillRoundRect(kx + 1, ky + 3, NP_W, NP_H, 10, 0x0862);
    // Key body
    tft.fillRoundRect(kx, ky, NP_W, NP_H, 10, (uint16_t)col);
    // Top highlight stripe
    tft.fillRoundRect(kx + 3, ky + 3, NP_W - 6, NP_H / 3, 8, uiLight((uint16_t)col, 28));
    // Border glow for OK key
    if (i == 11) {
      tft.drawRoundRect(kx, ky, NP_W, NP_H, 10, C_ACCENT);
      tft.drawRoundRect(kx + 1, ky + 1, NP_W - 2, NP_H - 2, 9, uiDark(C_ACCENT, 80));
    } else {
      tft.drawRoundRect(kx, ky, NP_W, NP_H, 10, C_DIV);
    }
    uint16_t txtCol = (i == 9) ? C_DIM : (i == 11 ? C_ACCENT : C_TEXT);
    tft.setTextColor(txtCol);
    int font = (i == 9 || i == 11) ? 2 : 4;
    int lh   = tft.fontHeight(font);
    tft.drawCentreString(NP_KEYS[i], kx + NP_W / 2, ky + (NP_H - lh) / 2, font);
  }
}

void drawPinDots() {
  tft.fillRoundRect(82, 76, 316, 36, 12, C_PANEL);
  tft.drawRoundRect(82, 76, 316, 36, 12, C_DIV);
  tft.setTextColor(C_DIM2);
  tft.drawCentreString("ENTER PIN", SCREEN_W / 2, 78, 1);
  const int spacing = 44;
  const int cx0     = SCREEN_W / 2 - spacing * 3 / 2;
  bool revealing = (pinRevealIdx >= 0 && millis() < pinRevealUntil);
  for (int i = 0; i < 4; i++) {
    int cx = cx0 + i * spacing;
    if (i < (int)driverPin.length()) {
      if (revealing && i == pinRevealIdx) {
        char d[2] = { driverPin[i], '\0' };
        tft.setTextColor(C_ACCENT);
        tft.drawCentreString(d, cx, 90, 4);
      } else {
        tft.fillCircle(cx, 97, 10, uiDark(C_ACCENT, 90));
        tft.fillCircle(cx, 97, 7, C_ACCENT);
        tft.fillCircle(cx, 97, 3, uiLight(C_ACCENT, 80));
      }
    } else {
      tft.drawCircle(cx, 97, 9, C_DIM2);
      tft.drawCircle(cx, 97, 7, uiDark(C_DIM2, 60));
    }
  }
}

String getTappedNumpad(int px, int py) {
  for (int i = 0; i < 12; i++) {
    int c = i % 3, r = i / 3;
    int kx = NP_X + c * (NP_W + NP_GAP), ky = NP_Y + r * (NP_H + NP_GAP);
    if (px >= kx && px <= (kx + NP_W) && py >= ky && py <= (ky + NP_H))
      return String(NP_KEYS[i]);
  }
  return "";
}

void screenLoginPin() {
  drawGradientBg();
  driverPin      = "";
  pinRevealIdx   = -1;
  pinRevealUntil = 0;

  // Slim status bar
  drawStatusBar();

  tft.fillRect(0, 28, SCREEN_W, 44, C_SURFACE);
  tft.fillRect(0, 71, SCREEN_W, 1, C_DIV);

  const int TX = 26, TY = 40;
  tft.fillRoundRect(TX, TY, 28, 16, 3, C_BTN);        // cab
  tft.fillRoundRect(TX + 28, TY + 4, 14, 12, 2, C_BTN); // trailer front
  tft.fillCircle(TX + 6,  TY + 17, 4, C_DIM2);         // wheel L
  tft.fillCircle(TX + 22, TY + 17, 4, C_DIM2);         // wheel R
  tft.fillCircle(TX + 34, TY + 17, 3, C_DIM2);         // trailer wheel

  tft.setTextColor(C_TEXT);
  tft.drawCentreString("FLEET HMI SYSTEM", SCREEN_W / 2, 38, 2);
  tft.setTextColor(C_DIM2);
  tft.drawCentreString("Driver Terminal  v1.0", SCREEN_W / 2, 54, 1);

  drawPinDots();

  // Numpad
  drawNumpad();

  // Offline notice
  if (!gsmReady && !wifiReady && cachedDriverCount > 0) {
    tft.setTextColor(C_ORANGE);
    tft.drawCentreString("OFFLINE  cached login available", SCREEN_W / 2, 306, 1);
  }
}

// WiFi Settings screen

static char   wsetSsidBuf[33] = {};
static char   wsetPassBuf[65] = {};
static int    wsetField       = 0;
static bool   wsetScanMode    = false;
static bool   wsetUseBuffers  = false;
static bool   wsetCapsLock    = true;
static String wsetScanSsids[5];
static int    wsetScanCount   = 0;

#define WSET_KEY_W   44
#define WSET_KEY_H   34
#define WSET_KEY_GAP  2
#define WSET_MARGIN  11

void wsetDrawKeyboard();  // forward declaration -- defined after screenWifiSettings

void wsetDrawField(int fieldIdx) {
  int fy = 40 + fieldIdx * 29;
  uint16_t bg  = (wsetField == fieldIdx) ? C_PANEL : C_CARD;
  uint16_t brd = (wsetField == fieldIdx) ? C_ACCENT2 : C_DIV;
  int fw = 364;
  tft.fillRoundRect(8, fy, fw, 26, 7, bg);
  tft.drawRoundRect(8, fy, fw, 26, 7, brd);
  tft.setTextColor(C_DIM);
  tft.drawString(fieldIdx == 0 ? "SSID:" : "PASS:", 14, fy + 4, 2);
  const char* val = (fieldIdx == 0) ? wsetSsidBuf : wsetPassBuf;
  tft.setTextColor(fieldIdx == 0 ? C_TEXT : C_AMBER);
  tft.drawString(val, 72, fy + 4, 2);
}

void screenWifiSettings() {
  drawGradientBg();
  drawPageHeader("Connectivity", TFT_CYAN);
  tft.fillRect(0, 28, SCREEN_W, SCREEN_H - 28, C_BG);  // clear content area -- prevent stale text bleed

  // Load current NVS values into bufs
  if (!wsetScanMode && !wsetUseBuffers) {
    strncpy(wsetSsidBuf, nvsWifiSsid.c_str(), sizeof(wsetSsidBuf)-1);
    strncpy(wsetPassBuf, nvsWifiPass.c_str(), sizeof(wsetPassBuf)-1);
  }
  wsetSsidBuf[sizeof(wsetSsidBuf)-1] = '\0';
  wsetPassBuf[sizeof(wsetPassBuf)-1] = '\0';
  wsetField = 0;

  wsetDrawField(0);
  wsetDrawField(1);

  drawSmallBtn(374, 54, 86, 40, "SCAN", C_BLUE);
  if (wsetScanMode) {
    tft.setTextColor(C_DIM);
    tft.drawString("Select network", 18, 102, 2);
    for (int i = 0; i < wsetScanCount; i++) {
      int y = 126 + i * 30;
      tft.fillRoundRect(18, y, 444, 26, 6, C_CARD);
      tft.drawRoundRect(18, y, 444, 26, 6, C_DIV);
      tft.setTextColor(TFT_WHITE);
      tft.drawString(wsetScanSsids[i].c_str(), 30, y + 6, 2);
    }
    if (wsetScanCount == 0) {
      tft.setTextColor(C_ORANGE);
      tft.drawCentreString("No networks found", SCREEN_W / 2, 154, 2);
    }
    drawSmallBtn(18, 272, 96, 34, "BACK", C_LOGOUT);
    return;
  }

  wsetDrawKeyboard();
}

// Draws only the keyboard rows + action row (no full screen repaint).
// Called from screenWifiSettings() and from CAPS tap to avoid a full redraw.
void wsetDrawKeyboard() {
  const char* rowsUp[4][11] = {
    {"1","2","3","4","5","6","7","8","9","0", nullptr},
    {"Q","W","E","R","T","Y","U","I","O","P", nullptr},
    {"A","S","D","F","G","H","J","K","L",nullptr,nullptr},
    {"Z","X","C","V","B","N","M",nullptr,nullptr,nullptr,nullptr},
  };
  const char* rowsLo[4][11] = {
    {"1","2","3","4","5","6","7","8","9","0", nullptr},
    {"q","w","e","r","t","y","u","i","o","p", nullptr},
    {"a","s","d","f","g","h","j","k","l",nullptr,nullptr},
    {"z","x","c","v","b","n","m",nullptr,nullptr,nullptr,nullptr},
  };
  const char* (*rows)[11] = wsetCapsLock ? rowsUp : rowsLo;
  int rowKeys[4] = {10, 10, 9, 7};
  int rowY[4]    = {102, 138, 174, 210};

  for (int row = 0; row < 4; row++) {
    int kw = WSET_KEY_W, kh = WSET_KEY_H, gap = WSET_KEY_GAP;
    int totalW = rowKeys[row] * kw + (rowKeys[row]-1) * gap;
    int startX = (480 - totalW) / 2;
    int y = rowY[row];
    for (int k = 0; k < rowKeys[row]; k++) {
      int x = startX + k * (kw + gap);
      tft.fillRoundRect(x, y, kw, kh, 6, C_BTN);
      tft.fillRoundRect(x + 2, y + 2, kw - 4, kh / 2, 5, uiLight(C_BTN, 30));
      tft.drawRoundRect(x, y, kw, kh, 6, C_DIV);
      tft.setTextColor(TFT_WHITE);
      tft.drawCentreString(rows[row][k], x + kw/2, y + 9, 2);
    }
    if (row == 3) {
      int bspX = startX + 7*(kw+gap);
      int bspW = 480 - WSET_MARGIN - bspX;
      tft.fillRoundRect(bspX, y, bspW, kh, 6, C_LOGOUT);
      tft.drawRoundRect(bspX, y, bspW, kh, 6, TFT_RED);
      tft.setTextColor(TFT_RED);
      tft.drawCentreString("<", bspX + bspW/2, y + 9, 2);
    }
  }

  int ay = 248, smW = 34, ah = 34, gap = WSET_KEY_GAP;
  // CAPS -- leftmost, highlighted when active
  {
    uint16_t capsBg = wsetCapsLock ? C_ACCENT2 : C_BTN;
    tft.fillRoundRect(WSET_MARGIN, ay, 50, ah, 6, capsBg);
    tft.drawRoundRect(WSET_MARGIN, ay, 50, ah, 6, wsetCapsLock ? TFT_CYAN : C_DIV);
    tft.setTextColor(TFT_WHITE);
    tft.drawCentreString("CAPS", WSET_MARGIN + 25, ay + 9, 1);
  }
  const char* symKeys[] = {"@", "-", "_", ".", "(", ")"};
  const int   symCount  = sizeof(symKeys) / sizeof(symKeys[0]);
  for (int k = 0; k < symCount; k++) {
    int sx = WSET_MARGIN + 50 + gap + k * (smW + gap);
    tft.fillRoundRect(sx, ay, smW, ah, 6, C_BTN);
    tft.drawRoundRect(sx, ay, smW, ah, 6, C_DIV);
    tft.setTextColor(TFT_WHITE);
    tft.drawCentreString(symKeys[k], sx + smW/2, ay + 9, 2);
  }
  int symEndX = WSET_MARGIN + 50 + gap + symCount * (smW + gap);
  int saveX   = 480 - WSET_MARGIN - 64;
  int backX   = saveX - gap - 64;
  int spaceW  = backX - gap - symEndX;
  tft.fillRoundRect(symEndX, ay, spaceW, ah, 6, C_BTN);
  tft.drawRoundRect(symEndX, ay, spaceW, ah, 6, C_DIV);
  tft.setTextColor(C_DIM);
  tft.drawCentreString("SPC", symEndX + spaceW/2, ay + 9, 2);
  // BACK
  tft.fillRoundRect(backX, ay, 64, ah, 5, C_LOGOUT);
  tft.drawRoundRect(backX, ay, 64, ah, 5, 0xC618);
  tft.setTextColor(TFT_WHITE);
  tft.drawCentreString("BACK", backX + 32, ay + 9, 2);
  // SAVE
  tft.fillRoundRect(saveX, ay, 64, ah, 5, C_GREEN);
  tft.drawRoundRect(saveX, ay, 64, ah, 5, TFT_GREEN);
  tft.drawCentreString("SAVE", saveX + 32, ay + 9, 2);

  // WiFi status line
  tft.setTextColor(wifiReady ? TFT_GREEN : C_DIM);
  tft.drawCentreString(wifiReady ? "? WiFi connected" : "? WiFi not connected", SCREEN_W/2, 286, 1);
}

// Append a char to the currently focused WiFi settings field
void wsetAppend(char ch) {
  char* buf   = (wsetField == 0) ? wsetSsidBuf : wsetPassBuf;
  size_t maxl = (wsetField == 0) ? 32 : 64;
  size_t len  = strlen(buf);
  if (len < maxl) { buf[len] = ch; buf[len+1] = '\0'; }
  wsetDrawField(wsetField);
}

void wsetBackspace() {
  char* buf = (wsetField == 0) ? wsetSsidBuf : wsetPassBuf;
  size_t len = strlen(buf);
  if (len > 0) { buf[len-1] = '\0'; wsetDrawField(wsetField); }
}

// Truck select
#define TS_BW  214
#define TS_BH   58
#define TS_GAP  10
#define TS_X0   21
#define TS_Y0   88

void screenTruckSelect() {
  drawGradientBg();
  drawPageHeader("Select Truck", C_ACCENT);

  if (truckCount == 0) {
    tft.setTextColor(C_ORANGE);
    tft.drawCentreString("No trucks available", SCREEN_W / 2, 180, 2);
    tft.setTextColor(C_DIM2);
    tft.drawCentreString("Check connection and refresh", SCREEN_W / 2, 202, 1);
  } else {
    if (!gsmReady && !wifiReady) {
      tft.fillRoundRect(SCREEN_W - 76, 50, 68, 16, 4, C_PANEL);
      tft.drawRoundRect(SCREEN_W - 76, 50, 68, 16, 4, C_ORANGE);
      tft.setTextColor(C_ORANGE);
      tft.drawCentreString("CACHED", SCREEN_W - 42, 53, 1);
    }
    for (int i = 0; i < truckCount && i < 6; i++) {
      int c = i % 2, r = i / 2;
      int bx = TS_X0 + c * (TS_BW + TS_GAP);
      int by = TS_Y0 + r * (TS_BH + TS_GAP);

      // Priority of status badges: maintenance beats in-use beats available.
      bool inUse        = trucks[i].active;
      bool inMaintenance = (trucks[i].status == "maintenance");
      bool blocked       = inUse || inMaintenance;

      uint16_t bgCol, brdCol, acBar, stCol;
      const char* stTxt;
      int stW;
      if (inMaintenance) {
        bgCol = C_PANEL; brdCol = C_RED; acBar = C_RED; stCol = C_RED;
        stTxt = "MAINTENANCE"; stW = 74;
      } else if (inUse) {
        bgCol = C_PANEL; brdCol = C_ORANGE; acBar = C_ORANGE; stCol = C_ORANGE;
        stTxt = "IN USE"; stW = 40;
      } else {
        bgCol = C_CARD; brdCol = C_ACCENT; acBar = C_GREEN; stCol = C_GREEN;
        stTxt = "AVAILABLE"; stW = 54;
      }

      // Shadow
      tft.fillRoundRect(bx + 2, by + 3, TS_BW, TS_BH, 10, 0x0862);
      // Card body
      tft.fillRoundRect(bx, by, TS_BW, TS_BH, 10, bgCol);
      // Left accent bar
      tft.fillRoundRect(bx + 2, by + 2, 5, TS_BH - 4, 10, acBar);
      tft.drawRoundRect(bx, by, TS_BW, TS_BH, 10, brdCol);
      if (!blocked) tft.drawRoundRect(bx + 1, by + 1, TS_BW - 2, TS_BH - 2, 9, uiDark(brdCol, 60));
      // Truck code
      tft.setTextColor(blocked ? C_DIM : C_ACCENT);
      tft.drawString(trucks[i].code.c_str(), bx + 16, by + 6, 4);
      // Plate
      tft.setTextColor(blocked ? C_DIM2 : C_DIM);
      tft.drawString(trucks[i].plate.c_str(), bx + 16, by + 40, 1);
      // Status badge
      tft.fillRoundRect(bx + TS_BW - stW - 6, by + TS_BH - 18, stW, 14, 4, uiDark(stCol, 120));
      tft.drawRoundRect(bx + TS_BW - stW - 6, by + TS_BH - 18, stW, 14, 4, stCol);
      tft.setTextColor(stCol);
      tft.drawCentreString(stTxt, bx + TS_BW - stW / 2 - 6, by + TS_BH - 15, 1);
    }
  }
  drawBackBtn("LOGOUT");
  drawSmallBtn(338, 270, 132, 44, "REFRESH", C_ACCENT);
}

// Ready
#define RDY_START_X   16
#define RDY_START_Y  188
#define RDY_START_W  448
#define RDY_START_H   64
#define RDY_BACK_X     8
#define RDY_BACK_Y   264
#define RDY_BACK_W   112
#define RDY_BACK_H    44
#define RDY_LGOUT_X  338
#define RDY_LGOUT_Y  264
#define RDY_LGOUT_W  132
#define RDY_LGOUT_H   44

void refreshCanBadge();   // forward declaration -- defined after screen functions
char     lastCanBadgeSpdBuf[16]  = {0};
char     lastCanBadgeFuelBuf[16] = {0};
uint16_t lastCanBadgeSpdCol      = 0xFFFF;
uint16_t lastCanBadgeFuelCol     = 0xFFFF;
inline void invalidateCanBadgeCache() {
  lastCanBadgeSpdBuf[0]  = '\0';
  lastCanBadgeFuelBuf[0] = '\0';
  lastCanBadgeSpdCol     = 0xFFFF;
  lastCanBadgeFuelCol    = 0xFFFF;
}

void screenReady() {
  drawGradientBg();
  drawPageHeader("Ready", TFT_GREEN);

  // Driver + Truck info card
  tft.fillRoundRect(18, 76, 444, 76, 10, C_CARD);
  tft.fillRect(18, 78, 5, 72, C_GREEN);
  tft.drawRoundRect(18, 76, 444, 76, 10, C_DIV);
  // Left: driver label + name
  tft.setTextColor(C_DIM2);
  tft.drawString("DRIVER", 32, 84, 1);
  tft.setTextColor(C_TEXT);
  tft.drawString(fitText(driverName, 20).c_str(), 32, 96, 2);
  tft.setTextColor(C_DIM2);
  tft.drawString("TRUCK", 280, 84, 1);
  tft.setTextColor(C_ACCENT);
  tft.drawString(fitText(selectedTruckCode, 8).c_str(), 280, 96, 2);
  tft.fillRoundRect(360, 80, 90, 18, 6, uiDark(C_GREEN, 120));
  tft.drawRoundRect(360, 80, 90, 18, 6, C_GREEN);
  tft.setTextColor(C_GREEN);
  tft.drawCentreString("STANDBY", 405, 84, 1);

  // GPS + CAN status row
  tft.fillRoundRect(18, 160, 168, 22, 5, C_PANEL);
  { GpsStatus gs = computeGpsStatus();
    tft.setTextColor(gpsStatusColor(gs));
    tft.drawString(gpsStatusLabel(gs), 28, 165, 1); }
  refreshCanBadge();

  // START TRIP or TAKE OVER
  if (!externalTripId.isEmpty()) {
    tft.fillRoundRect(RDY_TAKEOVER_X, RDY_TAKEOVER_Y,
                      RDY_TAKEOVER_W, RDY_TAKEOVER_H, 10, 0xC4A0);
    tft.drawRoundRect(RDY_TAKEOVER_X, RDY_TAKEOVER_Y,
                      RDY_TAKEOVER_W, RDY_TAKEOVER_H, 10, TFT_ORANGE);
    tft.setTextColor(TFT_BLACK);
    tft.drawCentreString("TRIP ACTIVE via Mobile App", SCREEN_W / 2,
                         RDY_TAKEOVER_Y + 6, 2);
    String infoLine = externalDriverName.isEmpty()
      ? ("ID: " + externalTripId.substring(0, 8) + "...")
      : ("Driver: " + externalDriverName);
    tft.setTextColor(0x2104);
    tft.drawCentreString(infoLine.c_str(), SCREEN_W / 2, RDY_TAKEOVER_Y + 24, 1);
    tft.setTextColor(TFT_BLACK);
    tft.drawCentreString("[ TAP TO TAKE OVER ON THIS DEVICE ]", SCREEN_W / 2,
                         RDY_TAKEOVER_Y + RDY_TAKEOVER_H - 16, 1);
    String chBadge = "via " + (externalChannel.isEmpty() ? String("mobile") : externalChannel);
    tft.setTextColor(0x2104);
    tft.drawString(chBadge.c_str(), RDY_TAKEOVER_X + 6, RDY_TAKEOVER_Y + RDY_TAKEOVER_H - 14, 1);
  } else {
    // Glowing START TRIP button
    tft.fillRoundRect(RDY_START_X + 2, RDY_START_Y + 3, RDY_START_W, RDY_START_H, 12, uiDark(C_GREEN, 80));
    tft.fillRoundRect(RDY_START_X, RDY_START_Y, RDY_START_W, RDY_START_H, 12, 0x03A0);
    tft.fillRoundRect(RDY_START_X + 3, RDY_START_Y + 3, RDY_START_W - 6, RDY_START_H / 2, 10, uiLight(0x03A0, 40));
    tft.drawRoundRect(RDY_START_X, RDY_START_Y, RDY_START_W, RDY_START_H, 12, C_GREEN);
    tft.drawRoundRect(RDY_START_X + 1, RDY_START_Y + 1, RDY_START_W - 2, RDY_START_H - 2, 11, uiDark(C_GREEN, 80));
    tft.setTextColor(TFT_WHITE);
    int th = tft.fontHeight(4);
    tft.drawCentreString("START TRIP", SCREEN_W / 2, RDY_START_Y + (RDY_START_H - th) / 2, 4);
    if (!isOnline) {
      tft.fillRoundRect(RDY_START_X + 4, RDY_START_Y + RDY_START_H - 18,
                        RDY_START_W - 8, 14, 4, C_ORANGE);
      tft.setTextColor(TFT_BLACK);
      tft.drawCentreString("OFFLINE  trip will sync on reconnect",
                           SCREEN_W / 2, RDY_START_Y + RDY_START_H - 16, 1);
    }
  }

  drawSmallBtn(RDY_BACK_X,  RDY_BACK_Y,  RDY_BACK_W,  RDY_BACK_H,  "< BACK",  C_LOGOUT);
  drawSmallBtn(RDY_LGOUT_X, RDY_LGOUT_Y, RDY_LGOUT_W, RDY_LGOUT_H, "LOGOUT",  C_LOGOUT);
}

// Premium Trip Active layout

#define TA_LP_X      6    // left column x
#define TA_LP_Y     42
#define TA_LP_W    132    // left column width
#define TA_LP_H    216    // left column height

#define TA_RP_X    342    // right column x
#define TA_RP_Y     42    // right column y
#define TA_RP_W    132    // right column width
#define TA_RP_H    216    // right column height
#define TA_RP_B1_Y  (TA_RP_Y + 4)    // Driving Time block top
#define TA_RP_B2_Y  (TA_RP_Y + 110)  // Next Rest block top
#define TA_RP_BH    102               // each block height
#define TA_RP_DT_Y  (TA_RP_B1_Y + 40)
#define TA_RP_NR_Y  (TA_RP_B2_Y + 40) // Next Rest value text y

// Center navigation circle
#define CIRC_CX    240    // circle center x
#define CIRC_CY    128    // circle center y
#define CIRC_RO     80    // outer radius
#define CIRC_RING    6
#define CIRC_RI     73    // inner fill radius

#define TA_NP_X    152    // nav area left edge
#define TA_NP_Y     42    // nav area top
#define TA_NP_W    176
#define TA_NP_H    216    // nav area height
#define TA_NAV_ACX CIRC_CX
#define TA_NAV_ACY (CIRC_CY - 16)
#define TA_NAV_AH   78

#define TA_TIMER_Y  66

#define TA_BTN_Y   266    // button row top y
#define TA_BTN_H    50    // button height
#define TA_REST_X    8    // REST button x
#define TA_REST_W  226    // REST button width
#define TA_END_X   246    // END TRIP button x
#define TA_END_W   226    // END TRIP button width

void drawTripPanel(int x, int y, int w, int h) {
  tft.fillRoundRect(x, y, w, h, 7, C_CARD);
  tft.drawRoundRect(x, y, w, h, 7, uiDark(C_DIV, 70));
}

void drawLineIcon(char icon, int x, int y, uint16_t col) {
  switch (icon) {
    case 'D':
      tft.fillCircle(x + 7, y + 5, 4, col);   // head -- solid
      tft.fillRoundRect(x + 3, y + 11, 9, 7, 2, col);  // body -- solid
      break;
    case 'G':
      tft.fillCircle(x + 7, y + 7, 5, col);   // pin head -- solid
      tft.fillTriangle(x + 7, y + 19, x + 2, y + 10, x + 12, y + 10, col);  // pin tail
      tft.fillCircle(x + 7, y + 7, 2, C_PANEL);  // inner hole to make it look like a pin
      break;
    case 'M':
      tft.fillRoundRect(x + 3, y + 1, 9, 18, 2, col);   // phone body -- solid
      tft.fillRect(x + 5, y + 2, 5, 1, C_PANEL);        // speaker cutout
      tft.fillCircle(x + 7, y + 16, 2, C_PANEL);        // home button cutout
      break;
    case 'V':
      tft.fillRect(x + 1, y + 7, 13, 8, col);   // truck body -- solid
      tft.fillRect(x + 8, y + 5, 5, 4, col);    // cab roof
      tft.fillCircle(x + 4,  y + 16, 2, col);   // rear wheel
      tft.fillCircle(x + 11, y + 16, 2, col);   // front wheel
      tft.fillRect(x + 1, y + 7, 13, 8, col);   // redraw body over wheel overlap
      break;
    case 'S':  // speedometer -- filled needle + solid circle ring
      tft.drawCircle(x + 7, y + 11, 6, col);
      tft.drawCircle(x + 7, y + 11, 5, col);
      tft.fillTriangle(x + 7, y + 11, x + 7, y + 5, x + 11, y + 9, col);  // filled needle
      tft.fillCircle(x + 7, y + 11, 2, col);  // center pivot
      break;
    case 'F':  // fuel -- filled droplet shape
      tft.fillTriangle(x + 7, y + 3, x + 3, y + 11, x + 11, y + 11, col);
      tft.fillCircle(x + 7, y + 13, 4, col);
      break;
    case 'N':  // network -- three solid signal bars
      tft.fillRect(x + 1, y + 14, 3, 5,  col);
      tft.fillRect(x + 5, y + 9,  3, 10, col);
      tft.fillRect(x + 9, y + 4,  3, 15, col);
      break;
    default:
      tft.drawLine(x + 2, y + 15, x + 12, y + 5, col);
      tft.drawLine(x + 12, y + 5, x + 12, y + 15, col);
      tft.drawLine(x + 5, y + 15, x + 5, y + 19, col);
      tft.drawLine(x + 9, y + 11, x + 9, y + 19, col);
      tft.drawLine(x + 13, y + 7, x + 13, y + 19, col);
      break;
  }
}

void drawInfoLine(int x, int y, int w, char icon, const char* label, const char* value, uint16_t valueCol) {
  tft.fillRoundRect(x, y, w, 24, 5, uiDark(C_PANEL, 20));
  drawLineIcon(icon, x + 5, y + 3, C_DIM2);
  tft.setTextColor(C_DIM2);
  tft.drawString(label, x + 24, y + 4, 1);
  tft.setTextColor(valueCol);
  tft.drawString(fitText(String(value), 12).c_str(), x + 24, y + 13, 1);
}

void drawMetricBlock(int x, int y, int w, const char* label, const char* value, uint16_t valueCol) {
  tft.fillRoundRect(x, y, w, 50, 7, uiDark(C_PANEL, 12));
  tft.drawRoundRect(x, y, w, 50, 7, uiDark(C_DIV, 100));
  tft.setTextColor(C_DIM2);
  tft.drawString(label, x + 10, y + 7, 1);
  tft.setTextColor(valueCol);
  tft.drawString(value, x + 10, y + 22, 4);
}

void drawMetricBlockFull(int x, int y, int w, int h, const char* label, const char* value, uint16_t valueCol) {
  tft.fillRoundRect(x, y, w, h, 9, uiDark(C_PANEL, 10));
  tft.drawRoundRect(x, y, w, h, 9, uiDark(C_DIV, 80));
  // Label centered at top
  tft.setTextColor(C_DIM);
  tft.drawCentreString(label, x + w / 2, y + 10, 2);
  // Thin accent separator line
  tft.drawFastHLine(x + 14, y + 28, w - 28, uiDark(valueCol, 160));
  // Value centered, large font
  tft.setTextColor(valueCol);
  tft.drawCentreString(value, x + w / 2, y + 40, 4);
}

const char* commStatusLabel() {
  if (wifiReady) return "WiFi Ready";
  if (loraReady && loraGatewayRecentlyOk()) return "LoRa OK";
  if (gsmReady && backendReachable) return "Cellular Online";
  if (telBufCount > 0) return "Buffering";
  return "Offline";
}

uint16_t commStatusColor() {
  if (wifiReady || (gsmReady && backendReachable) || (loraReady && loraGatewayRecentlyOk())) {
    return C_ACCENT;
  }
  if (telBufCount > 0) return C_ORANGE;
  return C_DIM2;
}

void drawRouteSummary() {
  // Route summary panel sits below the navigation circle ring.
  const int textY = CIRC_CY + CIRC_RO + 14;
  tft.fillRoundRect(CIRC_CX - 96, textY - 3, 192, 48, 6, C_BG);

  if (navDestination.isEmpty()) {
    tft.setTextColor(C_DIM2);
    tft.drawCentreString("Destination not set", CIRC_CX, textY + 4, 1);
    tft.setTextColor(C_ACCENT);
    tft.drawCentreString("Open route in app", CIRC_CX, textY + 17, 1);
    return;
  }

  if (!navStepInstruction.isEmpty()) {
    String ins = fitText(navStepInstruction, 26);
    tft.setTextColor(C_ACCENT);
    tft.drawCentreString(ins.c_str(), CIRC_CX, textY, 1);
  }

  // Line 2 -- destination name with "To:" prefix
  String dest = "To: " + fitText(navDestination, 20);
  tft.setTextColor(C_DIM2);
  tft.drawCentreString(dest.c_str(), CIRC_CX, textY + 13, 1);

  // Line 3 -- total route distance
  char dbuf[24];
  if (navDistM >= 1000) snprintf(dbuf, sizeof(dbuf), "%.1f km remaining", navDistM / 1000.0f);
  else if (navDistM > 0) snprintf(dbuf, sizeof(dbuf), "%u m remaining",   navDistM);
  else                   snprintf(dbuf, sizeof(dbuf), "-- km");
  tft.setTextColor(C_DIM2);
  tft.drawCentreString(dbuf, CIRC_CX, textY + 26, 1);
}

void refreshTimer() {
  unsigned long nowSec = tripElapsedSec();
  if (nowSec == lastTimerSec) return;
  lastTimerSec = nowSec;
  char tbuf[16];
  formatTime(nowSec, tbuf);

  if (state == TRIP_ACTIVE || state == TRIP_PAUSED) {
    const int cx = TA_RP_X + 4 + (TA_RP_W - 8) / 2;
    tft.fillRect(TA_RP_X + 6, TA_RP_DT_Y, TA_RP_W - 12, 28, uiDark(C_PANEL, 10));
    tft.setTextColor((state == TRIP_ACTIVE) ? C_WHITE : C_ACCENT);
    tft.drawCentreString(tbuf, cx, TA_RP_DT_Y, 4);
  }
}

void refreshRestCountdown() {
  long secLeft;
  if (restAlertSnoozedUntil != 0) {
    long msLeft = (long)(restAlertSnoozedUntil - millis());
    secLeft = msLeft > 0 ? (msLeft + 999) / 1000 : 0;
  } else {
    long elapsed = (long)((millis() - lastRestMs) / 1000UL);
    secLeft = (long)(restThresholdMs / 1000UL) - elapsed;
  }
  if (secLeft == lastRestCountdownSec) return;
  lastRestCountdownSec = secLeft;

  // Progress arc on the circle ring
  float arcFrac;
  uint16_t arcCol;
  if (restAlertSnoozedUntil != 0) {
    long snoozeMs = (long)(restAlertSnoozedUntil - millis());
    arcFrac = (snoozeMs > 0) ? (1.0f - (float)snoozeMs / 600000.0f) : 1.0f;
    arcCol  = C_ORANGE;
  } else if (secLeft <= 0) {
    arcFrac = 1.0f;
    arcCol  = C_RED;
  } else {
    long elapsed = (long)((millis() - lastRestMs) / 1000UL);
    arcFrac = min(1.0f, (float)elapsed / ((float)restThresholdMs / 1000.0f));
    arcCol  = (secLeft < 1800) ? C_ORANGE : C_ACCENT;
  }
  // Background ring
  drawThickArc(CIRC_CX, CIRC_CY, CIRC_RO, CIRC_RING, 0, 360, C_SURFACE);
  // Progress ring
  if (arcFrac > 0.01f) drawThickArc(CIRC_CX, CIRC_CY, CIRC_RO, CIRC_RING, 0, arcFrac * 360.0f, arcCol);

  // Rest countdown text below circle
  char buf[32];
  drawRouteSummary();

  if (state == TRIP_ACTIVE || state == TRIP_PAUSED) {
    const int cx = TA_RP_X + 4 + (TA_RP_W - 8) / 2;
    tft.fillRect(TA_RP_X + 6, TA_RP_NR_Y, TA_RP_W - 12, 28, uiDark(C_PANEL, 10));
    if (secLeft <= 0) {
      tft.setTextColor(C_RED);
      tft.drawCentreString("OVERDUE", cx, TA_RP_NR_Y, 4);
    } else {
      long h = secLeft / 3600, m = (secLeft % 3600) / 60, s = secLeft % 60;
      snprintf(buf, sizeof(buf), "%02ld:%02ld:%02ld", h, m, s);
      uint16_t col = (secLeft < 1800) ? C_ORANGE : C_ACCENT;
      tft.setTextColor(col);
      tft.drawCentreString(buf, cx, TA_RP_NR_Y, 4);
    }
  }
}

void refreshGpsStatusBadge() {
  GpsStatus gs = computeGpsStatus();
  if (state == READY) {
    tft.fillRoundRect(18, 160, 168, 22, 5, C_PANEL);
    tft.setTextColor(gpsStatusColor(gs));
    tft.drawString(gpsStatusLabel(gs), 28, 165, 1);
  } else if (state == TRIP_ACTIVE) {
    drawInfoLine(TA_LP_X + 8, TA_LP_Y + 60, TA_LP_W - 16, 'G', "GPS", gpsShortStatusLabel(gs), gpsStatusColor(gs));
  } else if (state == TRIP_PAUSED) {
    drawInfoLine(TA_LP_X + 8, TA_LP_Y + 60, TA_LP_W - 16, 'G', "GPS", gpsShortStatusLabel(gs), gpsStatusColor(gs));
  }
}

// Mobile companion status badge -- left column.
void refreshCompanionBadge() {
  if (state != TRIP_ACTIVE && state != TRIP_PAUSED) return;
  if (mobileCompanionActive) {
    drawInfoLine(TA_LP_X + 8, TA_LP_Y + 88, TA_LP_W - 16, 'M', "Mobile", "Active", C_ACCENT);
  } else {
    drawInfoLine(TA_LP_X + 8, TA_LP_Y + 88, TA_LP_W - 16, 'M', "Mobile", "Offline", C_DIM2);
  }
}

// Turn arrow -- drawn in the upper portion of the right nav panel
void drawTurnArrow(int8_t t, int cx, int cy) {
  const uint16_t col = C_ACCENT;
  const int SW = 18, HS = SW / 2;
  // Clear arrow area background
  tft.fillCircle(cx, cy, 58, C_BG);
  // Circular navigation disc -- dark inner disc + medium blue ring

  if (navDestination.isEmpty()) {
    if (!isOnline && (telBufCount > 0 || !pendingTripStartBody.isEmpty())) {
      tft.setTextColor(C_ORANGE);
      tft.drawCentreString("OFFLINE", cx, cy - 8, 2);
    } else {
      tft.setTextColor(C_DIM);
      tft.drawCentreString("Route", cx, cy - 8, 2);
      tft.drawCentreString("via app", cx, cy + 6, 1);
    }
    return;
  }
  // Destination set but no step pushed yet -- default to straight ahead
  if (navState == "arrived") {
    tft.fillCircle(cx, cy, 30, 0x0460);
    tft.setTextColor(TFT_WHITE);
    tft.drawCentreString("ARRIVE", cx, cy - 8, 2);
    return;
  }
  if (navState == "rerouting") {
    tft.setTextColor(C_ORANGE);
    tft.drawCentreString("REROUTE", cx, cy - 8, 2);
    tft.drawCentreString("...", cx, cy + 8, 2);
    return;
  }
  if (t < 0) t = 6;

  switch (t) {
    default:
    case 6: // STRAIGHT ?  -- vertical stem + upward arrowhead
      tft.fillRect(cx - HS, cy + 12, SW, 36, col);
      tft.fillTriangle(cx, cy - 40, cx - 28, cy + 14, cx + 28, cy + 14, col);
      break;
    case 1: { // TURN RIGHT -- stem up, corner, horizontal -> arrowhead
      tft.fillRect(cx - HS, cy - 10, SW, 40, col);
      tft.fillRect(cx - HS, cy - 10 - HS, 40, SW, col);
      tft.fillTriangle(cx + 48, cy - 10, cx + 32, cy - 26, cx + 32, cy + 6, col);
      break;
    }
    case 0: { // TURN LEFT -- stem up, corner, horizontal <- arrowhead
      tft.fillRect(cx - HS, cy - 10, SW, 40, col);
      tft.fillRect(cx - 32, cy - 10 - HS, 40, SW, col);
      tft.fillTriangle(cx - 48, cy - 10, cx - 32, cy - 26, cx - 32, cy + 6, col);
      break;
    }
    // Shaft end corners lie exactly on the arrowhead base -> seamless join.
    case 5:   // NE
    case 13: { // KEEP RIGHT
      tft.fillTriangle(cx-16, cy+28, cx-28, cy+16, cx-1,  cy-11, col); // shaft tri 1
      tft.fillTriangle(cx-16, cy+28, cx-1,  cy-11, cx+11, cy+1,  col); // shaft tri 2
      tft.fillTriangle(cx-9,  cy-19, cx+19, cy+9,  cx+19, cy-19, col); // arrowhead -> tip upper-right
      break;
    }
    case 4:   // NW
    case 12: { // KEEP LEFT
      tft.fillTriangle(cx+16, cy+28, cx+28, cy+16, cx+1,  cy-11, col);
      tft.fillTriangle(cx+16, cy+28, cx+1,  cy-11, cx-11, cy+1,  col);
      tft.fillTriangle(cx+9,  cy-19, cx-19, cy+9,  cx-19, cy-19, col); // tip upper-left
      break;
    }
    case 3: { // SHARP RIGHT -- short stem, tight corner, -> arrowhead
      tft.fillRect(cx - HS, cy, SW, 32, col);
      tft.fillRect(cx - HS, cy - HS, 36, SW, col);
      tft.fillTriangle(cx + 42, cy, cx + 27, cy - 16, cx + 27, cy + 16, col);
      break;
    }
    case 2: { // SHARP LEFT -- mirror
      tft.fillRect(cx - HS, cy, SW, 32, col);
      tft.fillRect(cx - HS - 20, cy - HS, 36, SW, col);
      tft.fillTriangle(cx - 42, cy, cx - 27, cy - 16, cx - 27, cy + 16, col);
      break;
    }
    case 9: // U-TURN
      tft.fillRect(cx - HS - 10, cy - 26, SW, 50, col); // left stem
      tft.fillRect(cx - HS - 10, cy - 26, 28, SW, col); // top connector
      tft.fillRect(cx + 8, cy - 26, SW, 40, col);        // right stem down
      tft.fillTriangle(cx + 8 + HS, cy + 20, cx + 8 - 8, cy + 4, cx + 8 + SW + 8, cy + 4, col);
      break;
    case 10: // GOAL -- destination reached
      tft.fillCircle(cx, cy, 28, 0x0460);
      tft.setTextColor(TFT_WHITE);
      tft.drawCentreString("DEST", cx, cy - 8, 2);
      break;
    case 11: // DEPART -- first step of route, show straight ahead
      tft.fillRect(cx - HS, cy + 12, SW, 36, col);
      tft.fillTriangle(cx, cy - 40, cx - 28, cy + 14, cx + 28, cy + 14, col);
      break;
    case 7:  // ENTER ROUNDABOUT ?->
    case 8:  // EXIT ROUNDABOUT
      tft.drawCircle(cx, cy, 20, col);
      tft.drawCircle(cx, cy, 21, col);
      tft.fillTriangle(cx + 14, cy - 22, cx + 4, cy - 12, cx + 24, cy - 12, col);
      break;
    case 20: { // SE
      tft.fillTriangle(cx-16, cy-28, cx-28, cy-16, cx-1,  cy+11, col); // shaft tri 1
      tft.fillTriangle(cx-16, cy-28, cx-1,  cy+11, cx+11, cy-1,  col); // shaft tri 2
      tft.fillTriangle(cx-9,  cy+19, cx+19, cy-9,  cx+19, cy+19, col); // tip lower-right
      break;
    }
    case 21: { // SW
      tft.fillTriangle(cx+16, cy-28, cx+28, cy-16, cx+1,  cy+11, col);
      tft.fillTriangle(cx+16, cy-28, cx+1,  cy+11, cx-11, cy-1,  col);
      tft.fillTriangle(cx+9,  cy+19, cx-19, cy-9,  cx-19, cy+19, col); // tip lower-left
      break;
    }
    case 22: // SOUTH ? -- straight down
      tft.fillRect(cx - HS, cy - 36, SW, 36, col);
      tft.fillTriangle(cx, cy + 42, cx - 28, cy - 10, cx + 28, cy - 10, col);
      break;
  }
}

// Navigation panel -- drawn INSIDE the center circle
void refreshNavPanel() {
  const int cx = CIRC_CX;
  const int arrowCY = TA_NAV_ACY;
  const int distY   = CIRC_CY + 38;

  tft.fillCircle(cx, CIRC_CY, CIRC_RI - 2, C_BG);

  drawTurnArrow(navStepType, cx, arrowCY);

  if (navDestination.isEmpty()) {
    drawRouteSummary();
    return;
  }

  // Distance to next maneuver
  if (navStepDistM > 0) {
    char dbuf[16];
    if (navStepDistM >= 1000) snprintf(dbuf, sizeof(dbuf), "%.1fkm", navStepDistM / 1000.0f);
    else                       snprintf(dbuf, sizeof(dbuf), "%um",    navStepDistM);
    tft.fillRect(cx - 62, distY - 1, 124, 18, C_BG);
    tft.setTextColor(TFT_WHITE);
    tft.drawCentreString(dbuf, cx, distY, 2);
  }

  drawRouteSummary();
}

void screenTripActive() {
  Serial.println("[STA] A");
  lastTimerSec         = 0xFFFFFFFF;
  lastRestCountdownSec = -9999;
  invalidateCanBadgeCache();
  drawGradientBg();
  Serial.println("[STA] B");
  drawStatusBar();
  Serial.println("[STA] C");
  drawTripPanel(TA_LP_X, TA_LP_Y, TA_LP_W, TA_LP_H);
  drawTripPanel(TA_RP_X, TA_RP_Y, TA_RP_W, TA_RP_H);

  // Left column: driver info + status badges
  drawLineIcon('D', TA_LP_X + 10, TA_LP_Y + 17, C_DIM2);
  tft.setTextColor(C_DIM2);
  tft.drawString("Driver", TA_LP_X + 32, TA_LP_Y + 8, 1);
  tft.setTextColor(TFT_WHITE);
  tft.drawString(fitText(driverName, 14).c_str(), TA_LP_X + 32, TA_LP_Y + 22, 2);
  drawInfoLine(TA_LP_X + 8, TA_LP_Y + 172, TA_LP_W - 16, 'N', "Network", commStatusLabel(), commStatusColor());

  Serial.println("[STA] D");
  drawMetricBlockFull(TA_RP_X + 4, TA_RP_B1_Y, TA_RP_W - 8, TA_RP_BH, "Driving Time", "--:--:--", C_WHITE);
  drawMetricBlockFull(TA_RP_X + 4, TA_RP_B2_Y, TA_RP_W - 8, TA_RP_BH, "Next Rest",    "--:--:--", C_ACCENT);

  // Center navigation circle
  Serial.println("[STA] E");
  tft.fillCircle(CIRC_CX, CIRC_CY, CIRC_RI, C_BG);
  Serial.println("[STA] F");
  drawThickArc(CIRC_CX, CIRC_CY, CIRC_RO, CIRC_RING, 0, 360, C_SURFACE);

  Serial.println("[STA] G");
  refreshNavPanel();
  Serial.println("[STA] H");
  refreshRestCountdown();
  Serial.println("[STA] I");
  refreshTimer();
  refreshGpsStatusBadge();
  refreshCanBadge();
  refreshCompanionBadge();

  // 2-button row
  Serial.println("[STA] J");
  drawBtn(TA_REST_X, TA_BTN_Y, TA_REST_W, TA_BTN_H, "REST",     C_BTN_SOFT);
  drawBtn(TA_END_X,  TA_BTN_Y, TA_END_W,  TA_BTN_H, "END TRIP", C_RED_SOFT);
  Serial.println("[STA] done");
}

// Trip Paused
void screenTripPaused() {
  lastTimerSec         = 0xFFFFFFFF;
  lastRestCountdownSec = -9999;
  invalidateCanBadgeCache();
  drawGradientBg();
  drawStatusBar();
  drawTripPanel(TA_LP_X, TA_LP_Y, TA_LP_W, TA_LP_H);
  drawTripPanel(TA_RP_X, TA_RP_Y, TA_RP_W, TA_RP_H);

  // Left stats column
  drawLineIcon('D', TA_LP_X + 10, TA_LP_Y + 17, C_DIM2);
  tft.setTextColor(C_DIM2);
  tft.drawString("Driver", TA_LP_X + 32, TA_LP_Y + 8, 1);
  tft.setTextColor(TFT_WHITE);
  tft.drawString(fitText(driverName, 14).c_str(), TA_LP_X + 32, TA_LP_Y + 22, 2);
  drawInfoLine(TA_LP_X + 8, TA_LP_Y + 172, TA_LP_W - 16, 'N', "Network", commStatusLabel(), commStatusColor());

  drawMetricBlockFull(TA_RP_X + 4, TA_RP_B1_Y, TA_RP_W - 8, TA_RP_BH, "Driving Time", "--:--:--", C_ACCENT);
  drawMetricBlockFull(TA_RP_X + 4, TA_RP_B2_Y, TA_RP_W - 8, TA_RP_BH, "Next Rest",    "--:--:--", C_ACCENT);

  // Center circle -- paused state
  tft.fillCircle(CIRC_CX, CIRC_CY, CIRC_RI, C_BG);
  // Static amber ring for paused state
  drawThickArc(CIRC_CX, CIRC_CY, CIRC_RO, CIRC_RING, 0, 360, uiDark(C_REST_SOFT, 140));
  drawThickArc(CIRC_CX, CIRC_CY, CIRC_RO, CIRC_RING, 0, 180, C_REST_SOFT);

  // Pause bars inside circle
  tft.fillRoundRect(CIRC_CX - 24, TA_NAV_ACY - 28, 16, 50, 4, C_REST_SOFT);
  tft.fillRoundRect(CIRC_CX + 8,  TA_NAV_ACY - 28, 16, 50, 4, C_REST_SOFT);
  // "ON REST" text
  tft.setTextColor(C_REST_SOFT);
  tft.drawCentreString("Driver Resting", CIRC_CX, CIRC_CY + 30, 2);
  tft.setTextColor(C_DIM2);
  tft.drawCentreString("Stay safe", CIRC_CX, CIRC_CY + 48, 1);

  refreshTimer();
  refreshRestCountdown();
  refreshGpsStatusBadge();
  refreshCanBadge();
  refreshCompanionBadge();

  // 2-button row
  drawBtn(TA_REST_X, TA_BTN_Y, TA_REST_W, TA_BTN_H, "RESUME",   C_BTN_SOFT);
  drawBtn(TA_END_X,  TA_BTN_Y, TA_END_W,  TA_BTN_H, "END TRIP", C_RED_SOFT);
}

// Trip Ended
#define TE_NEW_X   60
#define TE_NEW_Y  228
#define TE_NEW_W  260
#define TE_NEW_H   56
#define TE_LGOUT_X 334
#define TE_LGOUT_Y 236
#define TE_LGOUT_W 116
#define TE_LGOUT_H  40

void screenTripEnded(unsigned long secs) {
  char tbuf[16];   // matches refreshTimer -- guards against 3+ digit hours
  formatTime(secs, tbuf);
  drawGradientBg();
  drawPageHeader("Trip Complete", C_ACCENT);
  drawSoftCard(52, 76, 376, 142, C_GREEN, true);
  tft.setTextColor(C_DIM);
  tft.drawCentreString("TOTAL DRIVE TIME", SCREEN_W / 2, 88, 2);
  tft.setTextColor(TFT_GREEN);
  tft.drawCentreString(tbuf, SCREEN_W / 2, 110, 6);
  tft.fillRoundRect(70, 166, 340, 42, 8, C_PANEL);
  tft.drawRoundRect(70, 166, 340, 42, 8, C_DIV);
  tft.setTextColor(C_DIM);
  tft.drawString("DRIVER", 84, 174, 1);
  tft.drawString("TRUCK",  260, 174, 1);
  tft.setTextColor(TFT_WHITE);
  tft.drawString(driverName.c_str(),        84, 188, 2);
  tft.drawString(selectedTruckCode.c_str(), 260, 188, 2);
  drawBtn(TE_NEW_X,   TE_NEW_Y,   TE_NEW_W,   TE_NEW_H,   "NEW TRIP", C_BLUE);
  drawSmallBtn(TE_LGOUT_X, TE_LGOUT_Y, TE_LGOUT_W, TE_LGOUT_H, "LOGOUT", C_LOGOUT);
  beepDone();
}

void screenLoading(const char* msg) {
  drawGradientBg();
  drawStatusBar();
  tft.fillCircle(SCREEN_W / 2, 116, 22, C_PANEL);
  tft.drawCircle(SCREEN_W / 2, 116, 22, C_ACCENT);
  tft.fillCircle(SCREEN_W / 2 + 12, 104, 4, C_ACCENT2);
  tft.setTextColor(C_DIM);
  tft.drawCentreString(msg, SCREEN_W / 2, 155, 4);
}

static void spinnerTask(void*) {
  const int   cx = SCREEN_W / 2, cy = 116;
  const float r  = 15.0f;
  int frame = 0;
  while (gSpinnerActive) {
    float a  = frame * (TWO_PI / 12.0f) - HALF_PI;
    int   dx = cx + (int)(r * cosf(a));
    int   dy = cy + (int)(r * sinf(a));
    tft.fillCircle(cx, cy, 20, C_PANEL);
    tft.drawCircle(cx, cy, 20, C_ACCENT);
    tft.fillCircle(dx, dy, 4, C_ACCENT2);
    frame = (frame + 1) % 12;
    vTaskDelay(pdMS_TO_TICKS(80));
  }
  gSpinnerTask = NULL;
  vTaskDelete(NULL);
}

void screenLoadingStart(const char* msg) {
  // Always stop any running spinner before drawing -- two cores writing TFT simultaneously
  if (gSpinnerActive) {
    gSpinnerActive = false;
    vTaskDelay(pdMS_TO_TICKS(120));
  }
  drawGradientBg();
  drawStatusBar();
  tft.fillCircle(SCREEN_W / 2, 116, 20, C_PANEL);
  tft.drawCircle(SCREEN_W / 2, 116, 20, C_ACCENT);
  tft.setTextColor(C_DIM);
  tft.drawCentreString(msg, SCREEN_W / 2, 155, 4);
  // Start the spinner regardless of LoRa state -- both the spinner and LoRa
  if (!gSpinnerActive) {
    gSpinnerActive = true;
    gSpinnerTask = NULL;
    xTaskCreatePinnedToCore(spinnerTask, "spin", 2048, NULL, 1, &gSpinnerTask, 1);
  }
}

void screenLoadingStop() {
  if (gSpinnerActive) {
    gSpinnerActive = false;
    vTaskDelay(pdMS_TO_TICKS(120));  // wait for spinner task to exit cleanly
  }
}
void screenError(const char* msg) {
  screenLoadingStop();  // kill spinner before drawing so it can't overwrite the error
  tft.fillScreen(uiDark(C_ALERT, 110));
  tft.fillRoundRect(34, 76, 412, 156, 12, C_ALERT);
  tft.drawRoundRect(34, 76, 412, 156, 12, TFT_RED);
  tft.setTextColor(TFT_WHITE);
  tft.drawCentreString("Error", SCREEN_W / 2, 110, 4);
  tft.setTextColor(TFT_YELLOW);
  tft.drawCentreString(msg, SCREEN_W / 2, 168, 2);
  beepError();
  delay(2000);
}

// ALERT OVERLAY
void showAlertOverlay(const String& alertType, const String& rawMsg) {
  Serial.printf("[ALERT] type=%s msg=%s\n", alertType.c_str(), rawMsg.c_str());
  alertOverlayActive = true;

  const bool isRest = (alertType == "rest_alert");

  tft.fillRoundRect(14, 46, 452, 210, 14, C_DIV);
  tft.fillRoundRect(18, 50, 444, 202, 12, uiDark(C_ALERT, 36));
  tft.fillRect(18, 50, 444, 8, C_ALERT);
  tft.drawRoundRect(18, 50, 444, 202, 12, TFT_RED);
  tft.drawRoundRect(21, 53, 438, 196, 10, uiLight(C_ALERT, 70));
  tft.setTextColor(TFT_WHITE);
  tft.drawCentreString("!  ALERT  !", SCREEN_W / 2, 70, 4);
  tft.drawFastHLine(38, 102, 404, 0xA000);

  if (isRest) {
    tft.setTextColor(TFT_YELLOW);
    tft.drawCentreString("REST BREAK REQUIRED", SCREEN_W / 2, 116, 2);
    tft.setTextColor(C_DIM);
    tft.drawCentreString("You have been driving too long.", SCREEN_W / 2, 138, 2);
    tft.drawCentreString("Take a break or snooze for 10 min.", SCREEN_W / 2, 158, 2);
    drawSmallBtn(28, 196, 190, 38, "TAKE REST", C_GREEN);
    drawSmallBtn(262, 196, 190, 38, "SNOOZE 10 MIN", C_ORANGE);
  } else {
    tft.setTextColor(TFT_YELLOW);
    String disp = rawMsg.length() > 50 ? rawMsg.substring(0, 47) + "..." : rawMsg;
    tft.drawCentreString(disp.c_str(), SCREEN_W / 2, 140, 2);
    drawSmallBtn(168, 196, 144, 38, "ACKNOWLEDGE", C_BTN);
  }

  delay(600);

  unsigned long lastBeep = 0;
  bool beepPhase = false, resolved = false;

  while (!resolved) {
    unsigned long now = millis();
    if (now - lastBeep >= (beepPhase ? 200UL : 400UL)) {
      beepPhase = !beepPhase;
      // Use the PWM-gated helpers so rest alarm honours BUZZER_QUIET_DUTY.
      if (beepPhase) buzzerOn();
      else           buzzerOff();
      lastBeep = now;
    }
    // Touchscreen input
    if (digitalRead(TOUCH_IRQ_PIN) == LOW) {
      uint16_t _tx = 0, _ty = 0;
      getFleetTouch(&_tx, &_ty);
      int tx = (int)_tx;
      int ty = (int)_ty;
      Serial.printf("[TOUCH-ALERT] screen=(%d,%d)\n", tx, ty);
      if (isRest) {
        if (inBtn(tx, ty, 28, 196, 190, 38)) {
          // TAKE REST -- immediate local state change, async HTTP
          buzzerOff(); beepOk();
          restAlertSnoozedUntil = 0;
          resolved = true;
          if (state == TRIP_ACTIVE) {
            queueTripEvent(HJ_PAUSE, "/trip/pause", activeTripId);
            pauseStart = millis();
            state      = TRIP_PAUSED;
            alertOverlayActive = false;
            screenTripPaused();
            return;
          }
        }
        if (inBtn(tx, ty, 262, 196, 190, 38)) {
          // SNOOZE
          buzzerOff(); beepOk();
          restAlertSnoozedUntil = millis() + 600000UL;
          lastShownAlertId     = "";
          lastRestCountdownSec = -9999;
          resolved = true;
          queueSnoozeEvent(activeTripId);
        }
      } else {
        if (inBtn(tx, ty, 168, 196, 144, 38)) {
          buzzerOff(); beepOk();
          resolved = true;
        }
      }
      delay(150);
    }

    // Physical button input
    if (isRest) {
      if (digitalRead(BTN_TAKE_REST) == LOW) {
        delay(BTN_DEBOUNCE_MS);
        if (digitalRead(BTN_TAKE_REST) == LOW) {
          buzzerOff(); beepOk();
          restAlertSnoozedUntil = 0;
          resolved = true;
          Serial.println("[BTN] Take Rest pressed");
          if (state == TRIP_ACTIVE) {
            queueTripEvent(HJ_PAUSE, "/trip/pause", activeTripId);
            pauseStart = millis();
            state      = TRIP_PAUSED;
            alertOverlayActive = false;
            screenTripPaused();
            return;
          }
        }
      }
    }
    // Button 2: Snooze (active LOW) -- works for ALL alert types.
    if (!resolved && digitalRead(BTN_SNOOZE) == LOW) {
      delay(BTN_DEBOUNCE_MS);
      if (digitalRead(BTN_SNOOZE) == LOW) {
        buzzerOff(); beepOk();
        if (isRest) {
          restAlertSnoozedUntil = millis() + 600000UL;
          lastShownAlertId      = "";
          lastRestCountdownSec  = -9999;
          queueSnoozeEvent(activeTripId);
          Serial.println("[BTN] Snooze pressed (rest)");
        } else {
          Serial.println("[BTN] Snooze pressed (acknowledged alert)");
        }
        resolved = true;
      }
    }

    delay(20);
  }
  buzzerOff();
  alertOverlayActive = false;
  if      (state == TRIP_ACTIVE) screenTripActive();
  else if (state == TRIP_PAUSED) screenTripPaused();
}


bool fetchTrucks() {
  if (!gsmReady && !wifiReady) { loadTruckCache(); return truckCount > 0; }
  String resp = httpGet("/device/trucks", 1, 7000);
  if (!resp.isEmpty()) {
    JsonDocument doc;
    if (deserializeJson(doc, resp) == DeserializationError::Ok) {
      truckCount = 0;
      for (JsonObject t : doc.as<JsonArray>()) {
        if (truckCount >= 10) break;
        trucks[truckCount].id     = t["id"].as<String>();
        trucks[truckCount].code   = t["truck_code"].as<String>();
        trucks[truckCount].plate  = t["plate_number"].as<String>();
        trucks[truckCount].model  = t["model"].as<String>();
        trucks[truckCount].status = t["status"].isNull() ? String("idle") : t["status"].as<String>();
        trucks[truckCount].active = t["is_active"] | false;
        truckCount++;
      }
      if (truckCount > 0) { saveTruckCache(); return true; }
    }
  }
  // Both online paths failed -- use NVS cache
  int prev = truckCount;
  truckCount = 0;
  loadTruckCache();
  if (truckCount > 0) {
    Serial.printf("[trucks] using %d cached truck(s)\n", truckCount);
    return true;
  }
  return false;
}

bool restorePendingLocalTripForDriver() {
  if (pendingTripStartBody.isEmpty()) return false;
  JsonDocument doc;
  if (deserializeJson(doc, pendingTripStartBody) != DeserializationError::Ok) return false;
  String bodyDriver = doc["driver_id"].as<String>();
  if (bodyDriver != driverId) return false;
  String pendingId = doc["trip_id"].as<String>();
  // Driver already ended this trip locally -- do not re-activate it.
  if (!locallyEndedTripId.isEmpty() && locallyEndedTripId == pendingId) {
    Serial.printf("[login] skip restore -- trip %s was locally ended\n", pendingId.c_str());
    return false;
  }
  activeTripId = pendingId;
  selectedTruckId = doc["truck_id"].as<String>();
  // Look up truck context from cache -- pendingTripStartBody only stores truck_id.
  selectedTruckCode = "";
  selectedTruckModel = "";
  for (int i = 0; i < truckCount; i++) {
    if (trucks[i].id == selectedTruckId) {
      selectedTruckCode = trucks[i].code;
      selectedTruckModel = trucks[i].model;
      break;
    }
  }
  Serial.printf("[login] restore pending trip -- truckId=%s truckCode=%s\n",
                selectedTruckId.c_str(), selectedTruckCode.c_str());
  activeTripStatus = "active";
  activeTripStartIso = "";
  activeTripPausedIso = "";
  activeTripNextRestAlertIso = "";
  activeTripRestSeconds = 0;
  activeTripDrivingSeconds = -1;
  activeTripSinceRestSeconds = -1;
  // Pull persisted clock data from the same NVS namespace nvsSaveTripClock
  {
    Preferences p; p.begin("actTrip", true);
    String savedTid = p.getString("tid", "");
    if (savedTid == activeTripId) {
      String startIso  = p.getString("startIso",  "");
      String pausedIso = p.getString("pausedIso", "");
      String nextRest  = p.getString("nextRest",  "");
      String tStatus   = p.getString("tStatus",   "active");
      unsigned long restSec  = p.getULong("restSec",  0);
      bool hasDrive  = p.getBool("hasDrive",  false);
      unsigned long driveSec = p.getULong("driveSec", 0);
      bool hasSinceR = p.getBool("hasSinceR", false);
      unsigned long sinceRSec = p.getULong("sinceRSec", 0);
      if (!startIso.isEmpty())      activeTripStartIso        = startIso;
      if (!pausedIso.isEmpty())     activeTripPausedIso       = pausedIso;
      if (!nextRest.isEmpty())      activeTripNextRestAlertIso = nextRest;
      if (!tStatus.isEmpty())       activeTripStatus          = tStatus;
      activeTripRestSeconds         = restSec;
      if (hasDrive)  activeTripDrivingSeconds   = (long)driveSec;
      if (hasSinceR) activeTripSinceRestSeconds = (long)sinceRSec;
      Serial.printf("[login] pending-trip NVS clock loaded: drive=%lu rest=%lu sinceR=%lu\n",
                    driveSec, restSec, sinceRSec);
    }
    p.end();
  }
  loginFoundActiveTrip = !activeTripId.isEmpty() && !selectedTruckId.isEmpty();
  if (loginFoundActiveTrip)
    Serial.printf("[login] restored pending local trip=%s\n", activeTripId.c_str());
  return loginFoundActiveTrip;
}

void apiHmiLogin();  // defined after apiLogin -- forward declaration required

bool apiLogin() {
  loginFoundActiveTrip = false;
  if (!gsmReady && !wifiReady) {
    Serial.println("[login] offline -- cache-only");
    int idx = lookupCachedDriver(driverPin.c_str());
    if (idx >= 0) {
      driverId   = String(cachedDrivers[idx].id);
      driverName = String(cachedDrivers[idx].name);
      restorePendingLocalTripForDriver();
      if (!loginFoundActiveTrip) nvsRestoreActiveTrip(driverId);
      return true;
    }
    screenError("Offline & not cached");
    return false;
  }
  JsonDocument body;
  body["pin"] = driverPin;
  String bs; serializeJson(body, bs);
  String resp = httpPost("/driver/login", bs, 1, 7000);  // 1 attempt, 7s max
  if (!resp.isEmpty()) {
    JsonDocument doc;
    if (deserializeJson(doc, resp) == DeserializationError::Ok) {
      if (doc["error"].is<String>()) {
        // Wrong PIN or server error -- do NOT fall through to cache
        screenError(doc["error"].as<const char*>());
        return false;
      }
      driverId   = doc["user_id"].as<String>();
      driverName = doc["full_name"].as<String>();
      if (!doc["server_now"].isNull()) serverNowIso = doc["server_now"].as<String>();
      // Cache for future offline logins
      upsertDriverCache(driverId.c_str(), driverName.c_str(), driverPin.c_str());
      // Establish HMI session so mobile app can authenticate
      apiHmiLogin();

      if (doc["active_trip"].is<JsonObject>()) {
        JsonObject at = doc["active_trip"].as<JsonObject>();
        String tid = at["id"].as<String>();
        String tkId = at["truck_id"].as<String>();
        String tStatus = at["trip_status"] | "active";
        String tkCode = "";
        if (at["trucks"].is<JsonObject>())
          tkCode = at["trucks"]["truck_code"].as<String>();

        if (!tid.isEmpty() && !tkId.isEmpty()) {
          activeTripId      = tid;
          selectedTruckId   = tkId;
          selectedTruckCode = tkCode;
          selectedTruckModel = "";
          for (int i = 0; i < truckCount; i++) {
            if (trucks[i].id == selectedTruckId) {
              selectedTruckModel = trucks[i].model;
              if (selectedTruckCode.isEmpty()) selectedTruckCode = trucks[i].code;
              break;
            }
          }
          activeTripStatus  = tStatus;
          activeTripStartIso = at["start_time"].as<String>();
          activeTripPausedIso = at["paused_at"].as<String>();
          activeTripNextRestAlertIso = at["next_rest_alert_at"].as<String>();
          activeTripRestSeconds = at["total_rest_seconds"] | 0;
          activeTripDrivingSeconds = at["hmi_driving_sec"].isNull() ? -1 : at["hmi_driving_sec"].as<long>();
          if (!at["hmi_rest_sec"].isNull()) activeTripRestSeconds = at["hmi_rest_sec"].as<unsigned long>();
          activeTripSinceRestSeconds = -1;
          {
            Preferences p; p.begin("actTrip", true);
            String savedTid = p.getString("tid", "");
            bool hasSinceR  = p.getBool("hasSinceR", false);
            unsigned long sinceRSec = p.getULong("sinceRSec", 0);
            bool hasDrive   = p.getBool("hasDrive", false);
            unsigned long driveSec = p.getULong("driveSec", 0);
            unsigned long restSec  = p.getULong("restSec",  0);
            p.end();
            if (hasSinceR && savedTid == tid) {
              activeTripSinceRestSeconds = (long)sinceRSec;
              Serial.printf("[login] sinceRestSec=%lu loaded from NVS for matching trip\n", sinceRSec);
            }
            // Driving-time recovery: server's hmi_driving_sec can be null right
            if (hasDrive && savedTid == tid) {
              long serverDrive = activeTripDrivingSeconds;  // -1 if server null
              long nvsDrive    = (long)driveSec;
              long chosen      = (serverDrive < 0) ? nvsDrive : max(serverDrive, nvsDrive);
              if (chosen != activeTripDrivingSeconds) {
                Serial.printf("[login] driveSec server=%ld NVS=%lu -> using %ld\n",
                              serverDrive, driveSec, chosen);
                activeTripDrivingSeconds = chosen;
              }
              // Same logic for rest seconds -- kept consistent so total driving
              if (restSec > activeTripRestSeconds) {
                Serial.printf("[login] restSec server=%lu NVS=%lu -> using NVS\n",
                              activeTripRestSeconds, restSec);
                activeTripRestSeconds = restSec;
              }
            }
          }
          loginFoundActiveTrip = true;
          nvsSaveActiveTrip();  // persist so offline reboot can resume without network
          // Restore nav destination immediately -- avoids 15s wait for first alert poll
          String loginDest = at["assigned_destination"].isNull() ? "" : at["assigned_destination"].as<String>();
          if (!loginDest.isEmpty()) {
            navDestination = loginDest;
            navDistM = at["route_dist_m"] | 0;
            navDurS  = at["route_dur_s"]  | 0;
            // Destination coordinates for offline arrival detection
            if (!at["dest_lat"].isNull() && !at["dest_lon"].isNull()) {
              navDestLat   = at["dest_lat"].as<double>();
              navDestLon   = at["dest_lon"].as<double>();
              navDestValid = (navDestLat != 0.0 || navDestLon != 0.0);
            }
            Serial.printf("[login] nav restored: dest=\"%s\" dist=%um dur=%us\n",
                          navDestination.c_str(), navDistM, navDurS);
          }
          Serial.printf("[login] active trip found: trip=%s truck=%s channel=mobile/ext\n",
                        tid.c_str(), tkCode.c_str());
        }
      } else {
        // Server confirmed no active trip -- any stored pendingEndTripId is stale
        if (!pendingEndTripId.isEmpty()) {
          Serial.printf("[login] server has no active trip -- clearing stale pendingEndTripId=%s\n",
                        pendingEndTripId.c_str());
          pendingEndTripId = "";
          pendingEndTime   = "";
          nvsSavePendingEnd("");
          nvsSavePendingEndTime("");
        }
      }
      return true;
    }
  }

  // Network failed -- fall through to NVS driver cache
  Serial.println("[login] online attempt failed -- trying cache");
  int idx = lookupCachedDriver(driverPin.c_str());
  if (idx >= 0) {
    driverId   = String(cachedDrivers[idx].id);
    driverName = String(cachedDrivers[idx].name);
    restorePendingLocalTripForDriver();
    if (!loginFoundActiveTrip) nvsRestoreActiveTrip(driverId);
    Serial.printf("[login] offline login from cache: %s\n", driverName.c_str());
    return true;
  }

  // No match anywhere
  screenError(!gsmReady ? "Offline & not cached" : "Login failed");
  return false;
}

void fetchRestThreshold() {}   // threshold arrives via /device/alerts polling

// Called immediately after a successful online PIN login.
void apiHmiLogin() {
  if (deviceId.isEmpty()) return;
  JsonDocument body;
  body["driver_id"] = driverId;
  if (selectedTruckId.isEmpty()) body["truck_id"] = nullptr;
  else                           body["truck_id"] = selectedTruckId;
  body["device_id"] = deviceId;
  String bs; serializeJson(body, bs);

  String resp = (wifiReady && WiFi.status() == WL_CONNECTED)
    ? wifiPost("/device/hmi-login", bs, 8000)
    : httpPost("/device/hmi-login", bs, 1, 8000);

  if (!resp.isEmpty()) {
    JsonDocument doc;
    if (deserializeJson(doc, resp) == DeserializationError::Ok && doc["session_id"].is<String>()) {
      hmiSessionId = doc["session_id"].as<String>();
      nvsSaveHmiSession();
      Serial.printf("[hmi] session established id=%s\n", hmiSessionId.c_str());
    }
  }
}

void queueHmiHeartbeat() {
  if (hmiSessionId.isEmpty() || heartbeatJobQueued) return;
  HttpJob job = {};
  job.type            = HJ_HEARTBEAT;
  job.isPost          = true;
  job.maxAttempts     = 2;      // one retry so a single cold-start 602 doesn't kill the heartbeat
  job.actionTimeoutMs = 6000;
  strlcpy(job.path, "/device/hmi-heartbeat", sizeof(job.path));
  if (activeTripId.isEmpty()) {
    snprintf(job.body, sizeof(job.body),
             "{\"session_id\":\"%s\",\"active_trip_id\":null}", hmiSessionId.c_str());
  } else {
    snprintf(job.body, sizeof(job.body),
             "{\"session_id\":\"%s\",\"active_trip_id\":\"%s\"}", hmiSessionId.c_str(), activeTripId.c_str());
  }
  if (xQueueSend(gHttpJobQ, &job, 0) == pdTRUE) {
    heartbeatJobQueued = true;
  }
}

void queueExternalTripCheck() {
  if (selectedTruckId.isEmpty()) return;
  HttpJob job = {};
  job.type            = HJ_EXT_TRIP;
  job.isPost          = false;
  job.maxAttempts     = 1;
  job.actionTimeoutMs = 5000;
  snprintf(job.path, sizeof(job.path), "/device/trip/active/%s", selectedTruckId.c_str());
  job.body[0] = '\0';
  xQueueSend(gHttpJobQ, &job, 0);  // fire-and-forget -- next 8 s cycle retries if queue is full
}

bool apiStartTrip() {
  // If offline, we proceed with this local ID and sync later.
  // Generate a UUID v4-formatted string that PostgreSQL will accept
  char localId[37];
  uint32_t a = esp_random(), b = esp_random(), c = esp_random(), d = esp_random();
  snprintf(localId, sizeof(localId), "%08x-%04x-%04x-%04x-%08x%04x",
           a, b >> 16, b & 0xFFFF, c >> 16, d, c & 0xFFFF);

  JsonDocument body;
  body["truck_id"]   = selectedTruckId;
  body["driver_id"]  = driverId;
  body["trip_id"]    = localId;   // propose ID; backend will use it if provided
  String ts = getTimestamp();
  if (!ts.isEmpty()) body["start_time"] = ts;  // capture true start time for offline sync
  if (gpsFix) {
    body["start_lat"] = (float)gpsLat;
    body["start_lon"] = (float)gpsLon;
  }
  String bs; serializeJson(body, bs);

  // Clear any external trip banner -- device is starting its own trip now
  externalTripId = "";
  externalDriverName = "";
  externalTripStart = "";
  externalPausedAt = "";
  externalNextRestAlert = "";
  externalRestSeconds = 0;

  obdFuelMode01     = true;
  obdFuelPct        = -1.0f;
  obdFuelChecked    = false;
  obdFuelValid      = false;
  obdFuelSource     = "none";
  obdFuelConfidence = "low";

  // "trip is active, start accumulating"; pollObd2() integrates speed x dt
  obdTripIntegratedKm = 0.0f;
  // Same arm for the GPS-haversine integrator -- third-tier fallback used
  gpsTripIntegratedKm = 0.0f;
  if (!selectedTruckId.isEmpty()) {
    nvsLoadTruckLifetimeKm(selectedTruckId);
  }

  activeTripId          = String(localId);
  activeTripStartIso    = ts;
  activeTripPausedIso   = "";
  activeTripNextRestAlertIso = "";
  activeTripRestSeconds = 0;
  activeTripDrivingSeconds = -1;
  activeTripSinceRestSeconds = -1;
  pendingTripStartBody    = bs;
  pendingTripStartReadyAt = millis() + 2000;  // wait for screenTripActive() TFT redraw to finish before POSTing
  nvsSavePendingTripBody(bs);
  { Preferences p; p.begin("fleet", false);
    p.putString("pendTripId", activeTripId);
    p.putULong("pendTripMs", (uint32_t)millis()); p.end(); }
  Serial.printf("[trip] instant start -- local ID: %s  ts=%s  (will sync in background)\n",
                activeTripId.c_str(), ts.c_str());
  return true;
}

// Retry a buffered offline trip-end
void flushPendingTripEnd() {
  if (pendingEndTripId.isEmpty()) return;

  static String   lastFlushedId = "";
  static int      http0Streak   = 0;
  if (lastFlushedId != pendingEndTripId) { lastFlushedId = pendingEndTripId; http0Streak = 0; }

  if (http0Streak >= 3) {
    Serial.printf("[trip/end] abandoned after 3 HTTP-0 failures -- clearing stale pendingEnd=%s\n",
                  pendingEndTripId.c_str());
    pendingEndTripId = "";
    pendingEndTime   = "";
    nvsSavePendingEnd("");
    nvsSavePendingEndTime("");
    http0Streak      = 0;
    lastFlushedId    = "";
    return;
  }

  JsonDocument body;
  body["trip_id"] = pendingEndTripId;
  if (!pendingEndTime.isEmpty()) body["end_time"] = pendingEndTime;
  String bs; serializeJson(body, bs);
  String resp = commEventSend("/trip/end", bs);
  lastEndRetry = millis();
  bool confirmed = !resp.isEmpty()
               || lastCommChannel == CH_LORA_OK
               || (gsmLastStatus >= 200 && gsmLastStatus < 300)   // 2xx success
               || (gsmLastStatus >= 400 && gsmLastStatus < 600);  // 4xx/5xx server response
  if (confirmed) {
    if (resp.isEmpty()) Serial.printf("[trip/end] server replied %d -- treating as confirmed\n", gsmLastStatus);
    Serial.printf("[trip/end] retry synced trip=%s\n", pendingEndTripId.c_str());
    pendingEndTripId = "";
    pendingEndTime   = "";
    nvsSavePendingEnd("");
    nvsSavePendingEndTime("");
    http0Streak   = 0;
    lastFlushedId = "";
  } else {
    http0Streak++;
    Serial.printf("[trip/end] retry failed (http0Streak=%d/3) -- will try again\n", http0Streak);
  }
}

void processAlertResponse(const String& resp) {
  if (resp.isEmpty()) {
    Serial.println("[alerts] response empty");
    return;
  }
  JsonDocument doc;
  DeserializationError perr = deserializeJson(doc, resp);
  if (perr != DeserializationError::Ok) {
    Serial.printf("[alerts] parse error: %s\n", perr.c_str());
    return;
  }
  uint32_t restMs   = doc["rest_threshold_ms"]   | 0;
  size_t   nPending = doc["pending_actions"].is<JsonArray>()
                    ? doc["pending_actions"].as<JsonArray>().size() : 0;
  bool     forced   = doc["force_ended"].as<bool>();
  const char* dest  = doc["nav_destination"].isNull() ? "" : doc["nav_destination"].as<const char*>();
  const char* ts    = doc["trip_status"].isNull() ? "" : doc["trip_status"].as<const char*>();
  Serial.printf("[alerts] rx force_ended=%d rest_ms=%lu pending=%u trip_status=%s nav_dest=%.30s\n",
                (int)forced, (unsigned long)restMs, (unsigned)nPending, ts, dest);

  // Refresh cached truck identity if the backend reports a different
  if (!doc["truck_code"].isNull()) {
    const char* newCode  = doc["truck_code"].as<const char*>();
    const char* newModel = doc["truck_model"].isNull() ? "" : doc["truck_model"].as<const char*>();
    if (newCode && *newCode && selectedTruckCode != newCode) {
      Serial.printf("[trip] truck rename detected -- '%s' -> '%s'; refreshing NVS\n",
                    selectedTruckCode.c_str(), newCode);
      selectedTruckCode = newCode;
      if (newModel && *newModel) selectedTruckModel = newModel;
      Preferences p; p.begin("fleet", false);
      p.putString("trkCode",  selectedTruckCode);
      if (newModel && *newModel) p.putString("trkModel", selectedTruckModel);
      p.end();
      if      (state == TRIP_ACTIVE) screenTripActive();
      else if (state == TRIP_PAUSED) screenTripPaused();
    }
  }

  if (doc["force_ended"].as<bool>()) {
    // HJ_ALERT result arriving after the driver already ended the trip locally.
    if ((state != TRIP_ACTIVE && state != TRIP_PAUSED) || activeTripId.isEmpty()) {
      Serial.println("[trip] force_ended ignored -- device not in an active trip");
      return;
    }
    // Admin ended the trip
    Serial.println("[trip] FORCE ENDED by admin");
    pendingTripEndedSeconds = tripElapsedSec();
    activeTripId = ""; pendingEndTripId = "";
    activeTripStartIso = ""; activeTripPausedIso = ""; activeTripRestSeconds = 0; activeTripDrivingSeconds = -1; activeTripSinceRestSeconds = -1;
    activeTripNextRestAlertIso = "";
    nvsSavePendingEnd(""); lastShownAlertId = "";
    localRestAlertPending = false; restAlertSnoozedUntil = 0;
    navDestination = ""; navDistM = 0; navDurS = 0;
    navStepInstruction = ""; navStepDistM = 0; navStepType = -1;
    navState = "navigating"; navGpsSource = ""; navCurrentStepIdx = -1; navNextStreet = "";
    navDestLat = 0.0; navDestLon = 0.0; navDestValid = false;
    arrivalBeepArmed = true;
    nvsClearActiveTrip();
    activeTripStatus = "ended";
    state = TRIP_ENDED;
    // Defer the TFT work until this JSON handler has returned.
    pendingScreenRedraw = SCR_TRIP_ENDED;
    return;
  }

  unsigned long fetchedMs = doc["rest_threshold_ms"].as<unsigned long>();
  if (fetchedMs > 0 && fetchedMs != restThresholdMs) {
    restThresholdMs = fetchedMs;
    Serial.printf("[alerts] rest threshold updated: %lu ms\n", restThresholdMs);
  }

  float fetchedOvspd = doc["overspeed_kmh"].as<float>();
  if (fetchedOvspd > 0 && fetchedOvspd != overspeedThresholdKmh) {
    overspeedThresholdKmh = fetchedOvspd;
    nvsSaveOverspeedKmh(overspeedThresholdKmh);
    Serial.printf("[alerts] overspeed threshold updated: %.1f km/h\n", overspeedThresholdKmh);
  }

  float fetchedTankL = doc["tank_capacity_l"].as<float>();
  if (fetchedTankL > 1.0f && fabsf(fetchedTankL - fuelTankCapacityL) > 0.05f) {
    Serial.printf("[alerts] fuel tank capacity updated: %.1f L -> %.1f L\n",
                  fuelTankCapacityL, fetchedTankL);
    fuelTankCapacityL = fetchedTankL;
    Preferences p; p.begin("fleet", false);
    p.putFloat("tankCapL", fuelTankCapacityL);
    p.end();
  }

  if (!doc["server_now"].isNull()) serverNowIso = doc["server_now"].as<String>();
  if (!doc["next_rest_alert_at"].isNull()) {
    activeTripNextRestAlertIso = doc["next_rest_alert_at"].as<String>();
  }

  // Capture destination coordinates for local arrival detection
  if (!doc["nav_dest_lat"].isNull() && !doc["nav_dest_lon"].isNull()) {
    double newDestLat = doc["nav_dest_lat"].as<double>();
    double newDestLon = doc["nav_dest_lon"].as<double>();
    if (newDestLat != 0.0 || newDestLon != 0.0) {
      navDestLat   = newDestLat;
      navDestLon   = newDestLon;
      navDestValid = true;
    }
  } else if (doc["nav_destination"].isNull() || doc["nav_destination"].as<String>().isEmpty()) {
    // No destination assigned -- clear so stale coords don't trigger false arrival
    navDestValid = false;
  }

  // Update navigation -- redraw panel when route or current step changes
  String newNav = doc["nav_destination"].isNull() ? "" : doc["nav_destination"].as<String>();
  String newInstr = doc["nav_step_instruction"].isNull() ? "" : doc["nav_step_instruction"].as<String>();
  uint32_t newStepDist = doc["nav_step_dist_m"].isNull() ? 0 : doc["nav_step_dist_m"].as<uint32_t>();
  int8_t   newStepType = doc["nav_step_type"].isNull()   ? -1 : (int8_t)doc["nav_step_type"].as<int>();
  String newNavState = doc["nav_state"].isNull() ? "navigating" : doc["nav_state"].as<String>();
  String newGpsSource = doc["nav_gps_source"].isNull() ? "" : doc["nav_gps_source"].as<String>();
  int32_t newStepIdx = doc["nav_current_step_index"].isNull() ? -1 : doc["nav_current_step_index"].as<int32_t>();
  String newNextStreet = doc["nav_next_street"].isNull() ? "" : doc["nav_next_street"].as<String>();
  bool navChanged = (newNav != navDestination) || (newInstr != navStepInstruction)
                 || (newStepDist != navStepDistM) || (newStepType != navStepType)
                 || (newNavState != navState) || (newStepIdx != navCurrentStepIdx)
                 || (newNextStreet != navNextStreet) || (newGpsSource != navGpsSource);
  if (navChanged) {
    navDestination      = newNav;
    navDistM            = doc["nav_dist_m"].isNull()  ? 0 : doc["nav_dist_m"].as<uint32_t>();
    navDurS             = doc["nav_dur_s"].isNull()   ? 0 : doc["nav_dur_s"].as<uint32_t>();
    navStepInstruction  = newInstr;
    navStepDistM        = newStepDist;
    navStepType         = newStepType;
    navState            = newNavState;
    navGpsSource        = newGpsSource;
    navCurrentStepIdx   = newStepIdx;
    navNextStreet       = newNextStreet;
    Serial.printf("[nav] state=%s step=%d idx=%ld dist=%um src=%s instr=\"%s\" dest=\"%s\"\n",
                  navState.c_str(), navStepType, (long)navCurrentStepIdx, navStepDistM,
                  navGpsSource.c_str(), navStepInstruction.c_str(), navDestination.c_str());
    if (state == TRIP_ACTIVE || state == TRIP_PAUSED) refreshNavPanel();
    if (navState == "arrived" && arrivalBeepArmed) {
      beepDone();
      arrivalBeepArmed = false;
    } else if (navState != "arrived") {
      arrivalBeepArmed = true;
    }
  }

  // Update companion mode -- redraw badge only when state changes
  bool newCompanion = doc["mobile_companion_active"].as<bool>();
  if (newCompanion != mobileCompanionActive) {
    mobileCompanionActive = newCompanion;
    Serial.printf("[companion] mobile_companion_active=%s\n", mobileCompanionActive ? "true" : "false");
    refreshCompanionBadge();
  }

  JsonArray pendingArr = doc["pending_actions"].as<JsonArray>();
  for (JsonObject act : pendingArr) {
    String id     = act["id"].as<String>();
    String action = act["action"].as<String>();
    String status = act["status"].as<String>();
    if (id.isEmpty() || action.isEmpty()) continue;
    if (status != "pending" && status != "sent") continue;
    if (pendingActionRecentlyHandled(id)) {
      // Already dispatched locally -- but if the action is STILL showing in the
      Serial.printf("[alerts] re-acking pending action id=%.8s action=%s (backend still shows '%s')\n",
                    id.c_str(), action.c_str(), status.c_str());
      queuePendingActionAck(id, true);
      continue;
    }
    // Wrap the action so dispatchLoraDownlink can read its "data" field uniformly.
    JsonDocument wrap;
    wrap["data"] = act["data"];
    bool ok = dispatchLoraDownlink(action, wrap);
    Serial.printf("[alerts] dispatched pending action id=%.8s action=%s ok=%d\n",
                  id.c_str(), action.c_str(), (int)ok);
    // For state-changing actions (rest/resume/end_trip), open the HMI priority
    if (ok && (action == "rest" || action == "resume" || action == "end_trip")) {
      lastLocalActionMs = millis();
    }
    queuePendingActionAck(id, ok);
    rememberPendingActionHandled(id);
  }

  // Remote pause/resume sync
  if (!doc["trip_status"].isNull()) {
    bool withinPriorityWindow = (millis() - lastLocalActionMs < HMI_PRIORITY_MS);
    if (withinPriorityWindow) {
      Serial.printf("[sync] HMI priority window active (%lums ago) -- ignoring remote trip_status\n",
        millis() - lastLocalActionMs);
    } else {
      String serverStatus = doc["trip_status"].as<String>();
      if (serverStatus == "paused" && state == TRIP_ACTIVE) {
        activeTripStatus = "paused";
        String pAt = doc["paused_at"].isNull() ? "" : doc["paused_at"].as<String>();
        if (!pAt.isEmpty()) {
          time_t pausedEpoch = parseIsoUtc(pAt);
          time_t nowEpoch    = time(nullptr);
          if (pausedEpoch > 0 && nowEpoch > pausedEpoch) {
            unsigned long offMs = (unsigned long)(nowEpoch - pausedEpoch) * 1000UL;
            pauseStart = (millis() > offMs) ? millis() - offMs : millis();
          } else {
            pauseStart = millis();
          }
        } else {
          pauseStart = millis();
        }
        Serial.println("[sync] remote pause detected -- HMI -> TRIP_PAUSED");
        state = TRIP_PAUSED;
        screenTripPaused();
      } else if (serverStatus == "active" && state == TRIP_PAUSED) {
        activeTripStatus = "active";
        if (pauseStart > 0) { pausedTotal += millis() - pauseStart; pauseStart = 0; }
        // Reset rest alarm so it doesn't fire immediately after remote resume
        lastRestMs = millis();
        restAlertSnoozedUntil = 0;
        localRestAlertPending = false;
        Serial.println("[sync] remote resume detected -- HMI -> TRIP_ACTIVE");
        state = TRIP_ACTIVE;
        screenTripActive();
      }
    }
  }

  if (restAlertSnoozedUntil != 0 && millis() >= restAlertSnoozedUntil) {
    Serial.println("[ALERT] snooze expired -- re-enabling rest_alert");
    restAlertSnoozedUntil = 0;
  }

  JsonArray arr = doc["alerts"].as<JsonArray>();
  for (JsonObject a : arr) {
    String id    = a["id"].as<String>();
    String atype = a["alert_type"].as<String>();
    String ts    = a["timestamp"].as<String>();
    if (lastShownAlertTs.length() && ts.length() && ts <= lastShownAlertTs) continue;
    if (id.length() && id == lastShownAlertId) continue;
    if (atype == "rest_alert") {
      Serial.println("[ALERT] rest_alert from backend ignored -- HMI uses local timer");
      continue;
    }
    lastShownAlertId = id;
    if (ts.length()) {
      lastShownAlertTs = ts;
      nvsSaveLastAlertTs(ts);
    }
    String msg = a["message"].as<String>();
    int mi = msg.indexOf(" [meta:");
    if (mi >= 0) msg = msg.substring(0, mi);
    showAlertOverlay(atype, msg);
    break;
  }
}

// HELPERS
void doLogout() {
  if (!hmiSessionId.isEmpty() && (isOnline || (wifiReady && WiFi.status() == WL_CONNECTED))) {
    HttpJob job = {};
    job.type            = HJ_HEARTBEAT;  // reuse type -- result is ignored either way
    job.isPost          = true;
    job.maxAttempts     = 1;
    job.actionTimeoutMs = 5000;
    strlcpy(job.path, "/device/hmi-logout", sizeof(job.path));
    snprintf(job.body, sizeof(job.body), "{\"session_id\":\"%s\"}", hmiSessionId.c_str());
    xQueueSend(gHttpJobQ, &job, pdMS_TO_TICKS(200));
  }
  nvsClearHmiSession();

  driverId = ""; driverName = ""; driverPin = "";
  selectedTruckId = ""; selectedTruckCode = ""; selectedTruckModel = ""; activeTripId = "";
  activeTripStartIso = ""; activeTripPausedIso = ""; activeTripRestSeconds = 0; activeTripDrivingSeconds = -1; activeTripSinceRestSeconds = -1;
  activeTripNextRestAlertIso = "";
  lastShownAlertId = "";
  state = LOGIN_PIN;
  screenLoginPin();
  beepOk();
}

void goToTruckSelect() {
  selectedTruckId = ""; selectedTruckCode = ""; selectedTruckModel = "";
  externalTripId = ""; externalDriverName = ""; externalTripStart = ""; externalChannel = "";
  externalNextRestAlert = "";
  if (!pendingEndTripId.isEmpty() && isOnline) queueEndTrip(pendingEndTripId, pendingEndTime);
  fetchTrucks();
  state = TRUCK_SELECT; screenTruckSelect();
  beepOk();
}

// CAN / MCP2515

// Initialize MCP2515 over shared VSPI bus (SPI already started by TFT_eSPI).
uint8_t mcp2515ReadRegisterRaw(uint8_t reg) {
  digitalWrite(CAN_CS_PIN, LOW);
  canSpi.beginTransaction(SPISettings(500000, MSBFIRST, SPI_MODE0));
  canSpi.transfer(0x03);  // MCP2515 READ instruction
  canSpi.transfer(reg);
  uint8_t value = canSpi.transfer(0x00);
  canSpi.endTransaction();
  digitalWrite(CAN_CS_PIN, HIGH);
  return value;
}

void mcp2515ResetRaw() {
  digitalWrite(CAN_CS_PIN, LOW);
  canSpi.beginTransaction(SPISettings(500000, MSBFIRST, SPI_MODE0));
  canSpi.transfer(0xC0);  // MCP2515 RESET instruction
  canSpi.endTransaction();
  digitalWrite(CAN_CS_PIN, HIGH);
  delay(10);
}

bool probeMcp2515Spi() {
  pinMode(CAN_CS_PIN, OUTPUT);
  digitalWrite(CAN_CS_PIN, HIGH);

  // Step 1: check dedicated CAN MISO (GPIO2) with CS deasserted
  pinMode(CAN_HSPI_MISO, INPUT);
  delay(5);
  int misoIdle = digitalRead(CAN_HSPI_MISO);
  Serial.printf("[CAN] CAN MISO (GPIO%d) idle = %s\n",
                CAN_HSPI_MISO, misoIdle ? "HIGH -- OK" : "LOW (no power or short?)");
  Serial.printf("[CAN] HSPI bus: SCK=GPIO%d  MISO=GPIO%d  MOSI=GPIO%d  CS=GPIO%d\n",
                CAN_HSPI_SCK, CAN_HSPI_MISO, CAN_HSPI_MOSI, CAN_CS_PIN);

  // Step 2: hardware reset
  mcp2515ResetRaw();
  delay(5);  // give chip time to complete reset

  // Step 3: read CANSTAT at 3 different speeds
  // CANSTAT (0x0E) after reset must be 0x80 (configuration mode).
  uint32_t speeds[] = { 500000, 250000, 125000 };
  uint8_t canstat = 0x00;
  for (int si = 0; si < 3; si++) {
    digitalWrite(CAN_CS_PIN, LOW);
    canSpi.beginTransaction(SPISettings(speeds[si], MSBFIRST, SPI_MODE0));
    canSpi.transfer(0x03);    // READ instruction
    canSpi.transfer(0x0E);    // CANSTAT register
    canstat = canSpi.transfer(0x00);
    canSpi.endTransaction();
    digitalWrite(CAN_CS_PIN, HIGH);
    Serial.printf("[CAN] CANSTAT @%ukHz = 0x%02X\n", (unsigned)(speeds[si]/1000), canstat);
    if (canstat != 0x00 && canstat != 0xFF) break;
  }

  // Step 4: read supporting registers for diagnosis
  uint8_t canctrl = mcp2515ReadRegisterRaw(0x0F);  // CANCTRL
  uint8_t txb0    = mcp2515ReadRegisterRaw(0x30);
  uint8_t opmode  = canstat & 0xE0;
  Serial.printf("[CAN] CANSTAT=0x%02X CANCTRL=0x%02X TXB0CTRL=0x%02X OPMODE=0x%02X\n",
                canstat, canctrl, txb0, opmode);

  // Step 5: interpret result
  if (canstat == 0x00) {
    Serial.println("[CAN] FAIL -- CANSTAT=0x00 (MISO stuck LOW). Check:");
    Serial.println("[CAN]   * MCP2515 VCC: module needs 5V (not 3.3V) on VCC pin");
    Serial.println("[CAN]   * MCP2515 GND: confirmed common ground with ESP32");
    Serial.printf("[CAN]   * CS wiring: GPIO%d -> MCP2515 CS\n", CAN_CS_PIN);
    Serial.println("[CAN]   * TFT MISO: if ILI9341 SDO is wired to GPIO19, remove it");
    Serial.println("[CAN]   * SPI bus: SCK=GPIO18  MOSI=GPIO23  MISO=GPIO19");
    return false;
  }
  if (canstat == 0xFF) {
    Serial.println("[CAN] FAIL -- CANSTAT=0xFF (MISO floating). Check:");
    Serial.println("[CAN]   * MISO wire (GPIO19) is connected to MCP2515 SO pin");
    Serial.println("[CAN]   * MCP2515 has power (VCC + GND)");
    return false;
  }
  if (opmode != 0x80) {
    Serial.printf("[CAN] WARN -- expected OPMODE=0x80 (config), got 0x%02X; check crystal (8 or 16 MHz)\n", opmode);
  } else {
    Serial.println("[CAN] SPI probe OK -- MCP2515 in config mode");
  }
  return true;
}

bool initCan() {
  pinMode(CAN_INT_PIN, INPUT);
  if (!probeMcp2515Spi()) return false;

  MCP2515::ERROR err = mcp2515can.reset();
  if (err != MCP2515::ERROR_OK) {
    Serial.printf("[CAN] reset FAIL err=%d\n", (int)err);
    return false;
  }

  err = mcp2515can.setBitrate(CAN_500KBPS, MCP_8MHZ);
  if (err != MCP2515::ERROR_OK) {
    err = mcp2515can.setBitrate(CAN_500KBPS, MCP_16MHZ);
    if (err != MCP2515::ERROR_OK) {
      Serial.printf("[CAN] setBitrate FAIL err=%d -- check CS=GPIO%d, MOSI/MISO/SCK\n",
                    (int)err, CAN_CS_PIN);
      return false;
    }
    canCrystalMhz = 16;
    Serial.println("[CAN] MCP2515 detected with 16 MHz crystal");
  } else {
    canCrystalMhz = 8;
  }

  err = mcp2515can.setLoopbackMode();
  if (err != MCP2515::ERROR_OK) {
    Serial.printf("[CAN] setLoopbackMode FAIL err=%d\n", (int)err);
    return false;
  }

  Serial.println("[CAN] MCP2515 OK -- loopback mode active (no vehicle needed)");
  return true;
}

bool canSelfTest() {
  struct can_frame tx;
  tx.can_id  = 0x7DF;   // OBD2 functional broadcast address -- meaningful for later
  tx.can_dlc = 4;
  tx.data[0] = 0xCA;
  tx.data[1] = 0xFE;
  tx.data[2] = (canTxCount >> 8) & 0xFF;
  tx.data[3] =  canTxCount       & 0xFF;

  if (mcp2515can.sendMessage(&tx) != MCP2515::ERROR_OK) {
    Serial.println("[CAN] self-test TX failed");
    return false;
  }
  canTxCount++;

  // Poll RX buffer up to 5 ms -- loopback copies frame almost immediately
  struct can_frame rx;
  unsigned long t0 = millis();
  while (millis() - t0 < 5) {
    if (mcp2515can.readMessage(&rx) == MCP2515::ERROR_OK) {
      canRxCount++;
      Serial.printf("[CAN] self-test PASS  tx=%lu rx=%lu  ID=0x%03X  %02X %02X %02X %02X\n",
                    canTxCount, canRxCount,
                    rx.can_id, rx.data[0], rx.data[1], rx.data[2], rx.data[3]);
      return true;
    }
  }
  Serial.printf("[CAN] self-test RX timeout  tx=%lu (frame sent but not received back)\n",
                canTxCount);
  return false;
}


bool obdProbePid2FPhysical(uint8_t& outRaw) {
  Serial.println("[FUEL] Physical-address PID 0x2F scan -- BCM/Meter/Body ECUs");
  for (uint16_t reqId = 0x7E1; reqId <= 0x7E7; reqId++) {
    struct can_frame req = {};
    req.can_id  = reqId;
    req.can_dlc = 8;
    req.data[0] = 0x02;
    req.data[1] = 0x01;   // Mode 01
    req.data[2] = 0x2F;   // fuel level input
    memset(&req.data[3], 0x55, 5);
    if (mcp2515can.sendMessage(&req) != MCP2515::ERROR_OK) continue;

    uint16_t expectResp = reqId + 8;   // 0x7E1->0x7E9, 0x7E2->0x7EA, etc.
    struct can_frame resp;
    unsigned long t0 = millis();
    while (millis() - t0 < 250) {
      if (mcp2515can.readMessage(MCP2515::RXB0, &resp) != MCP2515::ERROR_OK) {
        vTaskDelay(1);
        continue;
      }
      if (resp.can_id != expectResp || resp.can_dlc < 4) continue;
      if (resp.data[1] == 0x7F) {
        Serial.printf("[FUEL]   0x%03X -> NRC 0x%02X\n", reqId, resp.data[3]);
        break;
      }
      if (resp.data[1] == 0x41 && resp.data[2] == 0x2F) {
        outRaw = resp.data[3];
        Serial.printf("[FUEL]   0x%03X -> PID 0x2F raw=0x%02X (%.1f%%) -- FOUND\n",
                      reqId, outRaw, outRaw * 100.0f / 255.0f);
        return true;
      }
    }
    Serial.printf("[FUEL]   0x%03X -> no response\n", reqId);
  }
  return false;
}

bool obdRequest(uint8_t pid, uint8_t* outBuf, uint8_t& outLen,
                uint32_t timeoutMs = OBD_TIMEOUT_MS) {
  struct can_frame req;
  req.can_id  = 0x7DF;  // OBD2 functional broadcast -- all ECUs listen here
  req.can_dlc = 8;
  req.data[0] = 0x02;   // PCI: 2 payload bytes follow
  req.data[1] = 0x01;
  req.data[2] = pid;
  memset(&req.data[3], 0x55, 5);  // ISO 15765-2 padding

  if (mcp2515can.sendMessage(&req) != MCP2515::ERROR_OK) {
    Serial.printf("[OBD2] TX failed  PID=0x%02X\n", pid);
    return false;
  }

  struct can_frame resp;
  unsigned long t0 = millis();
  while (millis() - t0 < timeoutMs) {
    if (mcp2515can.readMessage(MCP2515::RXB0, &resp) != MCP2515::ERROR_OK) {
      vTaskDelay(1);  // yield so FreeRTOS scheduler can run; ECU replies in <20ms anyway
      continue;
    }

    if (resp.can_id < 0x7E8 || resp.can_id > 0x7EF) continue;
    if (resp.can_dlc < 3) continue;
    if (resp.data[1] == 0x7F) {
      // Negative response -- ECU explicitly rejecting this PID
      Serial.printf("[OBD2] PID 0x%02X negative response NRC=0x%02X\n", pid, resp.data[3]);
      return false;
    }
    if (resp.data[1] != 0x41 || resp.data[2] != pid) continue;  // not our response

    outLen = (resp.data[0] > 2) ? (resp.data[0] - 2) : 0;
    if (outLen > 4) outLen = 4;
    memcpy(outBuf, &resp.data[3], outLen);
    return true;
  }
  return false;  // timeout -- ECU did not respond
}

// Send a Mode 22 (SAE J2190 enhanced data) request.
bool obdRequestMode22(uint16_t pid, uint8_t* outBuf, uint8_t& outLen,
                      uint32_t timeoutMs = 600) {
  struct can_frame req;
  req.can_id  = 0x7DF;
  req.can_dlc = 8;
  req.data[0] = 0x03;
  req.data[1] = 0x22;
  req.data[2] = (pid >> 8) & 0xFF;
  req.data[3] =  pid       & 0xFF;
  memset(&req.data[4], 0x55, 4);
  if (mcp2515can.sendMessage(&req) != MCP2515::ERROR_OK) return false;
  struct can_frame resp;
  unsigned long t0 = millis();
  while (millis() - t0 < timeoutMs) {
    if (mcp2515can.readMessage(MCP2515::RXB0, &resp) != MCP2515::ERROR_OK) { vTaskDelay(1); continue; }
    if (resp.can_id < 0x7E8 || resp.can_id > 0x7EF || resp.can_dlc < 4) continue;
    if (resp.data[1] == 0x7F) {
      Serial.printf("[OBD2] Mode22 0x%04X  NRC=0x%02X\n", pid, resp.data[3]);
      return false;
    }
    uint16_t rPid = ((uint16_t)resp.data[2] << 8) | resp.data[3];
    if (resp.data[1] != 0x62 || rPid != pid) continue;
    outLen = (resp.data[0] > 3) ? (resp.data[0] - 3) : 0;
    if (outLen > 4) outLen = 4;
    memcpy(outBuf, &resp.data[4], outLen);
    return true;
  }
  return false;
}

// Send a Mode 22 request to Toyota's BCM at physical address 0x700.
bool obdRequestMode22BCM(uint16_t did, uint8_t* outBuf, uint8_t& outLen,
                         uint32_t timeoutMs = 600) {
  struct can_frame req;
  req.can_id  = 0x700;  // Toyota BCM physical address
  req.can_dlc = 8;
  req.data[0] = 0x03;
  req.data[1] = 0x22;
  req.data[2] = (did >> 8) & 0xFF;
  req.data[3] =  did       & 0xFF;
  memset(&req.data[4], 0x55, 4);
  if (mcp2515can.sendMessage(&req) != MCP2515::ERROR_OK) return false;
  struct can_frame resp;
  unsigned long t0 = millis();
  while (millis() - t0 < timeoutMs) {
    // BCM response (0x708) is hardware-routed to RXB1 via RXF4.
    // Non-BCM broadcast frames (0x640, 0x3F9) also land in RXB1 -- skip them.
    if (mcp2515can.readMessage(MCP2515::RXB1, &resp) != MCP2515::ERROR_OK) { vTaskDelay(1); continue; }
    if (resp.can_id != 0x708 || resp.can_dlc < 4) continue;
    if (resp.data[1] == 0x7F) {
      Serial.printf("[OBD2] BCM Mode22 0x%04X NRC=0x%02X\n", did, resp.data[3]);
      return false;
    }
    uint16_t rDid = ((uint16_t)resp.data[2] << 8) | resp.data[3];
    if (resp.data[1] != 0x62 || rDid != did) continue;
    outLen = (resp.data[0] > 3) ? (resp.data[0] - 3) : 0;
    if (outLen > 4) outLen = 4;
    memcpy(outBuf, &resp.data[4], outLen);
    return true;
  }
  return false;
}

// Toyota combination-meter request used by the context-selected Fortuner
bool obdRequestToyotaMeter(uint8_t service, uint16_t identifier,
                           uint8_t* outBuf, uint8_t& outLen,
                           uint32_t timeoutMs = 600) {
  const bool twoByteId = service == 0x22;
  struct can_frame req = {};
  req.can_id  = 0x7C0;
  req.can_dlc = 8;
  req.data[0] = twoByteId ? 0x03 : 0x02;
  req.data[1] = service;
  if (twoByteId) {
    req.data[2] = (identifier >> 8) & 0xFF;
    req.data[3] = identifier & 0xFF;
    memset(&req.data[4], 0x55, 4);
  } else {
    req.data[2] = identifier & 0xFF;
    memset(&req.data[3], 0x55, 5);
  }
  if (mcp2515can.sendMessage(&req) != MCP2515::ERROR_OK) return false;

  struct can_frame resp;
  const uint8_t positiveService = service + 0x40;
  unsigned long t0 = millis();
  while (millis() - t0 < timeoutMs) {
    if (mcp2515can.readMessage(MCP2515::RXB1, &resp) != MCP2515::ERROR_OK) {
      vTaskDelay(1);
      continue;
    }
    if (resp.can_id != 0x7C8 || resp.can_dlc < (twoByteId ? 5 : 4)) continue;
    if (resp.data[1] == 0x7F) return false;
    if (resp.data[1] != positiveService) continue;
    if (twoByteId) {
      uint16_t responseId = ((uint16_t)resp.data[2] << 8) | resp.data[3];
      if (responseId != identifier) continue;
      outLen = (resp.data[0] > 3) ? resp.data[0] - 3 : 0;
      if (outLen > 4) outLen = 4;
      memcpy(outBuf, &resp.data[4], outLen);
    } else {
      if (resp.data[2] != (identifier & 0xFF)) continue;
      outLen = (resp.data[0] > 2) ? resp.data[0] - 2 : 0;
      if (outLen > 4) outLen = 4;
      memcpy(outBuf, &resp.data[3], outLen);
    }
    return outLen > 0;
  }
  return false;
}

void restoreObdCan500() {
  CAN_CLOCK xtal = (canCrystalMhz == 16) ? MCP_16MHZ : MCP_8MHZ;
  mcp2515can.reset();
  // Use the bitrate that succeeded in tryObd2Mode() -- critical on Hino/heavy-
  mcp2515can.setBitrate(canObd2ActiveBitrate, xtal);
  mcp2515can.setFilterMask(MCP2515::MASK0, false, 0x7F8);
  mcp2515can.setFilter(MCP2515::RXF0, false, 0x7E8);
  mcp2515can.setFilter(MCP2515::RXF1, false, 0x7E8);
  mcp2515can.setFilterMask(MCP2515::MASK1, false, 0x7FF);
  mcp2515can.setFilter(MCP2515::RXF2, false, 0x640);
  mcp2515can.setFilter(MCP2515::RXF3, false, 0x3F9);
  mcp2515can.setFilter(MCP2515::RXF4, false, 0x708);
  mcp2515can.setFilter(MCP2515::RXF5, false, 0x7C8);
  mcp2515can.setNormalMode();
}

// Passively sample J1939 fuel level from any of the standard broadcast PGNs.
bool probeJ1939FuelAtRate(CAN_SPEED bitrate, uint32_t durationMs, float& fuelPct) {
  CAN_CLOCK xtal = (canCrystalMhz == 16) ? MCP_16MHZ : MCP_8MHZ;
  if (mcp2515can.reset() != MCP2515::ERROR_OK ||
      mcp2515can.setBitrate(bitrate, xtal) != MCP2515::ERROR_OK) return false;

  // Wide-open filters: accept every extended frame.
  mcp2515can.setFilterMask(MCP2515::MASK0, true, 0x00000000);
  mcp2515can.setFilterMask(MCP2515::MASK1, true, 0x00000000);
  for (uint8_t i = 0; i < 6; i++) {
    mcp2515can.setFilter((MCP2515::RXF)i, true, 0x00000000);
  }

  // ECUs never broadcast fuel PGNs on their own schedule -- they only reply
  bool canTransmit = (mcp2515can.setNormalMode() == MCP2515::ERROR_OK);
  if (!canTransmit) {
    Serial.println("[J1939] normal mode unavailable -- falling back to passive listen");
    if (mcp2515can.setListenOnlyMode() != MCP2515::ERROR_OK) return false;
  }

  auto sendReqTo = [&](uint32_t requestedPgn, uint8_t da) {
    if (!canTransmit) return;
    struct can_frame req = {};
    req.can_id  = (0x18EA0000UL | ((uint32_t)da << 8) | 0xF9UL) | CAN_EFF_FLAG;
    req.can_dlc = 3;
    req.data[0] =  requestedPgn        & 0xFF;
    req.data[1] = (requestedPgn >>  8) & 0xFF;
    req.data[2] = (requestedPgn >> 16) & 0xFF;
    mcp2515can.sendMessage(&req);
    vTaskDelay(pdMS_TO_TICKS(2));   // pace the burst -- heavy-duty buses are sensitive
  };

  // Broadcast + every fuel-relevant destination address in SAE J1939-71:
  const uint8_t targetDAs[] = { 0xFF, 0x17, 0x21, 0x28, 0x2F, 0x00, 0x03 };
  for (uint8_t da : targetDAs) {
    sendReqTo(0x00FEFCUL, da);
    sendReqTo(0x00FEB3UL, da);
  }

  struct can_frame frame;
  unsigned long started = millis();
  unsigned long lastReReq = started;
  while (millis() - started < durationMs) {
    esp_task_wdt_reset();

    if (canTransmit && millis() - lastReReq > 250) {
      for (uint8_t da : targetDAs) {
        sendReqTo(0x00FEFCUL, da);
        sendReqTo(0x00FEB3UL, da);
      }
      lastReReq = millis();
    }

    if (mcp2515can.readMessage(&frame) != MCP2515::ERROR_OK) {
      vTaskDelay(1);
      continue;
    }
    if (!(frame.can_id & CAN_EFF_FLAG) || frame.can_dlc < 2) continue;
    uint32_t id = frame.can_id & CAN_EFF_MASK;
    uint32_t pgn = (id >> 8) & 0x3FFFFUL;
    if (pgn == 0xFEFCUL) {
      if (frame.data[1] != 0xFF) {
        fuelPct = constrain(frame.data[1] * 0.4f, 0.0f, 100.0f);
        Serial.printf("[J1939] SPN 96 fuel_level_1 (PGN 65276): %.1f%%\n", fuelPct);
        return true;
      }
      if (frame.can_dlc >= 7 && frame.data[6] != 0xFF) {
        fuelPct = constrain(frame.data[6] * 0.4f, 0.0f, 100.0f);
        Serial.printf("[J1939] SPN 38 fuel_level_2 (PGN 65276): %.1f%%\n", fuelPct);
        return true;
      }
    }
    if (pgn == 0xFEB3UL && frame.can_dlc >= 6 && frame.data[5] != 0xFF) {
      fuelPct = constrain(frame.data[5] * 0.4f, 0.0f, 100.0f);
      Serial.printf("[J1939] SPN 1638 fuel_level_2 (PGN 65203): %.1f%%\n", fuelPct);
      return true;
    }
  }
  return false;
}

bool probeHinoJ1939Fuel(float& fuelPct) {
  static uint8_t preferredRate = 0;
  Serial.println("[FUEL] Hino profile -- J1939 active request PGN 65276+65203 at 500/250 kbps");
  bool found = false;
  if (preferredRate == 2) {
    found = probeJ1939FuelAtRate(CAN_250KBPS, 750, fuelPct);
    if (!found) {
      found = probeJ1939FuelAtRate(CAN_500KBPS, 350, fuelPct);
      if (found) preferredRate = 1;
    }
  } else {
    found = probeJ1939FuelAtRate(CAN_500KBPS, 350, fuelPct);
    if (found) preferredRate = 1;
    if (!found) {
      found = probeJ1939FuelAtRate(CAN_250KBPS, 750, fuelPct);
      if (found) preferredRate = 2;
    }
  }
  restoreObdCan500();
  return found;
}

void logSupportedPids() {
  uint8_t data[4]; uint8_t len;
  // Probe all six banks (0x00..0xA0) so the dump covers PID 0xA6 (universal
  const uint8_t groups[] = {0x00, 0x20, 0x40, 0x60, 0x80, 0xA0};
  bool fuel2FFound = false;
  Serial.println("[OBD2] ?? Supported PIDs ??????????????????????????????????");
  for (uint8_t g : groups) {
    if (!obdRequest(g, data, len, 200) || len < 4) {  // 200ms -- healthy ECUs reply in <20ms
      Serial.printf("[OBD2]   group 0x%02X: no response\n", g);
      break;
    }
    uint32_t bits = ((uint32_t)data[0] << 24) | ((uint32_t)data[1] << 16) |
                    ((uint32_t)data[2] <<  8) |  data[3];
    Serial.printf("[OBD2]   PIDs 0x%02X-0x%02X  bitmap=0x%08lX\n",
                  g + 1, g + 0x20, (unsigned long)bits);
    for (int i = 0; i < 32; i++) {
      if (bits & (1UL << (31 - i))) {
        uint8_t p = g + i + 1;
        if (p == 0x2F) fuel2FFound = true;
        const char* note = "";
        if (p == 0x0D) note = "  <- speed (in use)";
        if (p == 0x2F) note = "  <- fuel tank level %";
        if (p == 0x5E) note = "  <- fuel rate (L/h)";
        if (p == 0x46) note = "  <- ambient air temp";
        if (p == 0xA6) note = "  <- odometer (km)";
        Serial.printf("[OBD2]     PID 0x%02X%s\n", p, note);
      }
    }
    if (!(bits & 1)) break;
  }
  Serial.println("[OBD2] ??????????????????????????????????????????????????");
  obdFuelMode01 = fuel2FFound;
  if (!fuel2FFound) {
    Serial.println("[OBD2] PID 0x2F not in ECU bitmap -- skipping Mode 01, going straight to Mode 22");
  }
}

// Passive CAN sniffer -- disables RX filter, enters listen-only mode, captures
void canPassiveSniffer(uint32_t durationMs) {
  Serial.println("[SNIFFER] Opening RX filter -- listening to all CAN frames...");
  mcp2515can.setFilterMask(MCP2515::MASK0, false, 0x00000000);
  mcp2515can.setFilter(MCP2515::RXF0,      false, 0x00000000);
  mcp2515can.setFilter(MCP2515::RXF1,      false, 0x00000000);
  mcp2515can.setFilterMask(MCP2515::MASK1, false, 0x00000000);
  mcp2515can.setFilter(MCP2515::RXF2,      false, 0x00000000);
  mcp2515can.setFilter(MCP2515::RXF3,      false, 0x00000000);
  mcp2515can.setFilter(MCP2515::RXF4,      false, 0x00000000);
  mcp2515can.setFilter(MCP2515::RXF5,      false, 0x00000000);
  mcp2515can.setListenOnlyMode();  // passive -- no ACK injection

  struct { uint32_t id; uint8_t dlc; uint8_t data[8]; } seen[64];
  uint8_t seenCount = 0;

  unsigned long t0 = millis();
  struct can_frame f;
  while (millis() - t0 < durationMs) {
    esp_task_wdt_reset();  // feed watchdog -- sniffer can block > 5 s
    if (mcp2515can.readMessage(&f) != MCP2515::ERROR_OK) continue;
    bool found = false;
    for (uint8_t i = 0; i < seenCount; i++) {
      if (seen[i].id == f.can_id) { found = true; break; }
    }
    if (!found && seenCount < 64) {
      seen[seenCount].id  = f.can_id;
      seen[seenCount].dlc = f.can_dlc;
      memcpy(seen[seenCount].data, f.data, f.can_dlc);
      seenCount++;
    }
  }

  Serial.printf("[SNIFFER] %u unique CAN IDs seen in %lu ms:\n",
                (unsigned)seenCount, (unsigned long)durationMs);
  for (uint8_t i = 0; i < seenCount; i++) {
    Serial.printf("[SNIFFER]   0x%03lX  dlc=%u  data=",
                  (unsigned long)seen[i].id, (unsigned)seen[i].dlc);
    for (uint8_t b = 0; b < seen[i].dlc; b++)
      Serial.printf("%02X ", seen[i].data[b]);
    Serial.println();
  }
  Serial.println("[SNIFFER] Restoring OBD2 normal mode...");

  CAN_CLOCK xtal = (canCrystalMhz == 16) ? MCP_16MHZ : MCP_8MHZ;
  mcp2515can.reset();
  mcp2515can.setBitrate(canObd2ActiveBitrate, xtal);
  mcp2515can.setFilterMask(MCP2515::MASK0, false, 0x7F8);
  mcp2515can.setFilter(MCP2515::RXF0,      false, 0x7E8);
  mcp2515can.setFilter(MCP2515::RXF1,      false, 0x7E8);
  mcp2515can.setFilterMask(MCP2515::MASK1, false, 0x7FF);
  mcp2515can.setFilter(MCP2515::RXF2,      false, 0x640);
  mcp2515can.setFilter(MCP2515::RXF3,      false, 0x3F9);
  mcp2515can.setFilter(MCP2515::RXF4,      false, 0x640);
  mcp2515can.setFilter(MCP2515::RXF5,      false, 0x7C8);
  mcp2515can.setNormalMode();
}

void hinoFuelDiscoveryTask(void* ) {
  canDiscoveryBusy = true;
  Serial.println("[DISCOVERY] Hino fuel PGN sniff -- 500 kbps then 250 kbps");
  CAN_CLOCK xtal = (canCrystalMhz == 16) ? MCP_16MHZ : MCP_8MHZ;
  const CAN_SPEED rates[] = { CAN_500KBPS, CAN_250KBPS };
  const char*     labels[] = { "500 kbps", "250 kbps" };
  const uint32_t  perRateMs = 4000;
  struct SeenEntry { uint32_t rawId; uint8_t dlc; uint8_t data[8]; };

  for (uint8_t r = 0; r < 2; r++) {
    Serial.printf("[DISCOVERY] --- pass %u: %s ---\n", r + 1, labels[r]);
    if (mcp2515can.reset() != MCP2515::ERROR_OK) {
      Serial.println("[DISCOVERY] reset() failed -- aborting pass");
      continue;
    }
    if (mcp2515can.setBitrate(rates[r], xtal) != MCP2515::ERROR_OK) {
      Serial.println("[DISCOVERY] setBitrate() failed -- aborting pass");
      continue;
    }
    mcp2515can.setFilterMask(MCP2515::MASK0, true, 0x00000000);
    mcp2515can.setFilterMask(MCP2515::MASK1, true, 0x00000000);
    for (uint8_t i = 0; i < 6; i++) {
      mcp2515can.setFilter((MCP2515::RXF)i, true, 0x00000000);
    }
    if (mcp2515can.setListenOnlyMode() != MCP2515::ERROR_OK) {
      Serial.println("[DISCOVERY] setListenOnlyMode() failed -- aborting pass");
      continue;
    }

    SeenEntry seen[48];
    uint8_t   seenCount  = 0;
    uint32_t  frameCount = 0;
    uint32_t  t0         = millis();
    struct can_frame f;
    while (millis() - t0 < perRateMs) {
      // Drain as many buffered frames as possible per wake, then yield.
      while (mcp2515can.readMessage(&f) == MCP2515::ERROR_OK) {
        frameCount++;
        bool dup = false;
        for (uint8_t i = 0; i < seenCount; i++) {
          if (seen[i].rawId == f.can_id) { dup = true; break; }
        }
        if (!dup && seenCount < 48) {
          seen[seenCount].rawId = f.can_id;
          seen[seenCount].dlc   = f.can_dlc;
          memcpy(seen[seenCount].data, f.data, f.can_dlc);
          seenCount++;
        }
      }
      vTaskDelay(pdMS_TO_TICKS(2));  // yield -- keeps UI responsive
    }

    Serial.printf("[DISCOVERY] %s: %lu frames, %u unique IDs\n",
                  labels[r], (unsigned long)frameCount, (unsigned)seenCount);
    if (frameCount == 0) {
      Serial.printf("[DISCOVERY]   (no traffic at %s -- wrong bitrate or bus idle)\n", labels[r]);
    }
    for (uint8_t i = 0; i < seenCount; i++) {
      bool     ext = (seen[i].rawId & CAN_EFF_FLAG) != 0;
      uint32_t id  = seen[i].rawId & (ext ? CAN_EFF_MASK : 0x7FFUL);
      uint32_t pgn = ext ? ((id >> 8) & 0x3FFFFUL) : 0;
      Serial.printf("[DISCOVERY]   %s 0x%08lX pgn=0x%05lX dlc=%u data=",
                    ext ? "EXT" : "STD",
                    (unsigned long)id, (unsigned long)pgn, seen[i].dlc);
      for (uint8_t b = 0; b < seen[i].dlc; b++) {
        Serial.printf("%02X ", seen[i].data[b]);
      }
      if (ext && pgn == 0xFEFCUL) Serial.print(" <- PGN 65276 Dash Display (SPN 96)");
      if (ext && pgn == 0xFEB3UL) Serial.print(" <- PGN 65203 Fuel Info 2 (SPN 1638)");
      Serial.println();
    }
    esp_task_wdt_reset();
  }

  Serial.println("[DISCOVERY] complete -- restoring OBD2 normal mode");
  restoreObdCan500();
  canDiscoveryBusy = false;
  vTaskDelete(NULL);
}

bool tryObd2Mode() {
  Serial.println("[OBD2] Switching to normal mode -- probing vehicle CAN bus...");
  Serial.printf("[OBD2]   crystal=%uMHz  CS=GPIO%d  CANSTAT=0x%02X\n",
                (unsigned)canCrystalMhz, CAN_CS_PIN,
                mcp2515ReadRegisterRaw(0x0E));

  // Re-enter config mode via reset so we can set RX filters
  MCP2515::ERROR resetErr = mcp2515can.reset();
  Serial.printf("[OBD2]   reset=%d (0=OK)\n", (int)resetErr);
  CAN_CLOCK  xtal = (canCrystalMhz == 16) ? MCP_16MHZ : MCP_8MHZ;

  // Try 500 kbps first (Toyota / most passenger vehicles), then 250 kbps
  const CAN_SPEED rates[]    = { CAN_500KBPS, CAN_250KBPS };
  const uint16_t  rateKbps[] = { 500,          250          };
  for (int r = 0; r < 2; r++) {
    CAN_SPEED bps = rates[r];
    Serial.printf("[OBD2] === Attempting handshake at %u kbps ===\n",
                  (unsigned)rateKbps[r]);

    MCP2515::ERROR bitrateErr = mcp2515can.setBitrate(bps, xtal);
    Serial.printf("[OBD2]   setBitrate(%ukbps,%uMHz)=%d (0=OK)\n",
                  (unsigned)rateKbps[r], (unsigned)canCrystalMhz, (int)bitrateErr);
    if (bitrateErr != MCP2515::ERROR_OK) {
      Serial.println("[OBD2] setBitrate failed -- trying next rate");
      mcp2515can.reset();
      continue;
    }

    mcp2515can.setFilterMask(MCP2515::MASK0, false, 0x7F8);
    mcp2515can.setFilter(MCP2515::RXF0, false, 0x7E8);
    mcp2515can.setFilter(MCP2515::RXF1, false, 0x7E8);
    // Exact-match mask so only these specific IDs are accepted.
    mcp2515can.setFilterMask(MCP2515::MASK1, false, 0x7FF);
    mcp2515can.setFilter(MCP2515::RXF2, false, 0x640);
    mcp2515can.setFilter(MCP2515::RXF3, false, 0x3F9);
    mcp2515can.setFilter(MCP2515::RXF4, false, 0x708);  // Toyota BCM response to physical 0x700 requests
    mcp2515can.setFilter(MCP2515::RXF5, false, 0x7C8);  // Toyota combination meter

    MCP2515::ERROR normErr = mcp2515can.setNormalMode();
    Serial.printf("[OBD2]   setNormalMode=%d (0=OK)  CANSTAT=0x%02X\n",
                  (int)normErr, mcp2515ReadRegisterRaw(0x0E));
    if (normErr != MCP2515::ERROR_OK) {
      Serial.println("[OBD2] setNormalMode failed -- trying next rate");
      mcp2515can.reset();
      continue;
    }

    Serial.println("[OBD2]   Probing PID 0x0D (up to 3 attempts, 600ms each)...");
    uint8_t buf[4]; uint8_t len = 0;
    bool probeOk = false;
    for (int attempt = 1; attempt <= 3; attempt++) {
      if (obdRequest(0x0D, buf, len, 600)) {
        obdSpeedKmh = buf[0];
        canObd2ActiveBitrate = bps;   // remember rate so restoreObdCan500 uses it
        Serial.printf("[OBD2] ECU alive at %u kbps (attempt %d) -- initial speed: %.0f km/h\n",
                      (unsigned)rateKbps[r], attempt, obdSpeedKmh);
        logSupportedPids();
        probeOk = true;
        break;
      }
      if (attempt < 3) {
        Serial.printf("[OBD2]   Attempt %d failed -- clearing TX buffers, retrying\n", attempt);
        mcp2515can.reset();
        mcp2515can.setBitrate(bps, xtal);
        mcp2515can.setFilterMask(MCP2515::MASK0, false, 0x7F8);
        mcp2515can.setFilter(MCP2515::RXF0, false, 0x7E8);
        mcp2515can.setFilter(MCP2515::RXF1, false, 0x7E8);
        mcp2515can.setFilterMask(MCP2515::MASK1, false, 0x7FF);
        mcp2515can.setFilter(MCP2515::RXF2, false, 0x640);
        mcp2515can.setFilter(MCP2515::RXF3, false, 0x3F9);
        mcp2515can.setFilter(MCP2515::RXF4, false, 0x708);
        mcp2515can.setFilter(MCP2515::RXF5, false, 0x7C8);
        mcp2515can.setNormalMode();
        vTaskDelay(pdMS_TO_TICKS(150));   // give the bus a moment to settle
      }
    }
    if (probeOk) return true;

    Serial.printf("[OBD2] No ECU response at %u kbps -- trying next rate\n",
                  (unsigned)rateKbps[r]);
    mcp2515can.reset();
  }

  Serial.println("[OBD2] No ECU response at 500 or 250 kbps -- check:");
  Serial.println("[OBD2]   1. Ignition is ON (not just ACC)");
  Serial.println("[OBD2]   2. OBD2 pigtail is seated in OBD2 port");
  Serial.println("[OBD2]   3. CAN H/L wires correct (not swapped)");
  Serial.println("[OBD2]   4. 120-ohm termination (measure H-L = ~60 ohm bus)");
  Serial.printf("[OBD2]   CANSTAT after probe=0x%02X\n", mcp2515ReadRegisterRaw(0x0E));
  Serial.println("[OBD2] Falling back to loopback mode (bench test)");
  mcp2515can.reset();
  mcp2515can.setBitrate(CAN_500KBPS, xtal);
  mcp2515can.setLoopbackMode();
  canLoopbackOk = false;  // force re-test on next CAN_POLL_MS tick
  return false;
}

// Called every OBD_POLL_MS from loop() when canObd2Ready is true.
void pollObd2() {
  if (canDiscoveryBusy) return;

  uint8_t buf[4]; uint8_t len = 0;
  static uint8_t speedMiss = 0;  // consecutive speed misses

  // Speed (PID 0x0D): universally supported, always attempt
  if (obdRequest(0x0D, buf, len)) {
    float newSpeed = (float)buf[0];
    speedMiss = 0;
    if (fabsf(newSpeed - obdSpeedKmh) >= 2.0f) {
      Serial.printf("[OBD2] speed %.0f->%.0f km/h\n", obdSpeedKmh, newSpeed);
    }
    obdSpeedKmh = newSpeed;

    // Trip-distance fallback: integrate speed x dt while a trip is active.
    {
      static uint32_t lastIntegrateMs = 0;
      uint32_t nowMs = millis();
      if (obdTripIntegratedKm >= 0.0f && lastIntegrateMs != 0 && obdSpeedKmh >= 0.0f) {
        float dt_h = (nowMs - lastIntegrateMs) / 3600000.0f;
        if (dt_h > 0.0f && dt_h < 0.5f) {   // ignore millis() rollovers / huge gaps
          obdTripIntegratedKm += obdSpeedKmh * dt_h;
        }
      }
      lastIntegrateMs = nowMs;
    }
  } else {
    speedMiss++;
    uint8_t cs = mcp2515ReadRegisterRaw(0x0E);
    Serial.printf("[OBD2] speed: no ECU response (miss #%u)  CANSTAT=0x%02X\n",
                  (unsigned)speedMiss, cs);
    // After 5 consecutive misses assume vehicle disconnected -- revert to loopback
    if (speedMiss >= 5) {
      speedMiss = 0;
      canObd2Ready  = false;
      obdSpeedKmh   = -1.0f;
      obdOdometerKm = -1.0f;
      obdFuelPct    = -1.0f;
      obdFuelChecked = false;
      obdFuelMode01  = true;  // re-run bitmap check on reconnect
      canDiscoveryDone = false; // allow a fresh discovery sweep on next connect
      // Odometer DID scan state lives inside pollObd2() as function-statics -- they
      canLoopbackOk  = false;
      CAN_CLOCK xtal = (canCrystalMhz == 16) ? MCP_16MHZ : MCP_8MHZ;
      mcp2515can.reset();
      mcp2515can.setBitrate(CAN_500KBPS, xtal);
      mcp2515can.setLoopbackMode();
      Serial.println("[OBD2] 5 consecutive misses -- assumed disconnected, reverting to loopback");
      refreshCanBadge();
    }
    return;
  }

  // Extended PIDs -- polled every 10 s to avoid CAN bus flooding
  static uint8_t extPidCycle = 0;
  if (++extPidCycle >= 10) {
    extPidCycle = 0;
    uint8_t buf2[4]; uint8_t len2 = 0;

    // RPM (PID 0x0C): 2 bytes, (A*256+B)/4
    if (obdRequest(0x0C, buf2, len2) && len2 >= 2)
      obdRpm = (buf2[0] * 256.0f + buf2[1]) / 4.0f;

    // Engine load (PID 0x04): 1 byte, A*100/255
    if (obdRequest(0x04, buf2, len2) && len2 >= 1)
      obdEngineLoadPct = buf2[0] * 100.0f / 255.0f;

    // Throttle position (PID 0x11): 1 byte, A*100/255
    if (obdRequest(0x11, buf2, len2) && len2 >= 1)
      obdThrottlePct = buf2[0] * 100.0f / 255.0f;

    // MAF air flow rate (PID 0x10): 2 bytes, (A*256+B)/100 g/s
    if (obdRequest(0x10, buf2, len2) && len2 >= 2)
      obdMafGps = (buf2[0] * 256.0f + buf2[1]) / 100.0f;

    // Coolant temperature (PID 0x05): 1 byte, A-40  degC
    if (obdRequest(0x05, buf2, len2) && len2 >= 1)
      obdCoolantTempC = (float)buf2[0] - 40.0f;

    // Engine run time since start (PID 0x1F): 2 bytes, A*256+B seconds
    if (obdRequest(0x1F, buf2, len2) && len2 >= 2)
      obdRuntimeSec = buf2[0] * 256 + buf2[1];

    // Odometer:
    static int8_t   activeOdoDid    = -1;
    static uint8_t  lockedOdoMode   = 0x22; // 0x21 or 0x22
    static uint16_t lockedOdoDid    = 0;    // the DID itself, captured once locked
    struct OdoCandidate { uint8_t mode; uint16_t did; float scale; const char* note; };
    static const OdoCandidate ODO_DIDS[] = {
      { 0x21, 0xCB, 10.0f, "Toyota combo meter lifetime odometer (4B / 0.1km)" },
      { 0x21, 0x88, 10.0f, "Toyota combo meter trip A meter (4B / 0.1km)"     },
      { 0x21, 0x8A, 10.0f, "Toyota combo meter trip B meter (4B / 0.1km)"     },
      { 0x21, 0xA6, 10.0f, "Toyota combo meter redirected 0xA6 (4B / 0.1km)"  },
      { 0x22, 0xDB0F, 10.0f, "Hilux/Fortuner gen 2 diesel (4B / 0.1km)"   },
      { 0x22, 0xDB12, 10.0f, "Lexus / some Hilux variants (4B / 0.1km)"   },
      { 0x22, 0xDB14, 10.0f, "Toyota AE family (4B / 0.1km)"              },
      { 0x22, 0x0208,  1.0f, "Toyota TIS catalog odometer (4B / 1km)"     },
      { 0x22, 0xA001, 10.0f, "Lexus IS/GS lifetime (4B / 0.1km)"          },
      { 0x22, 0xCC04, 10.0f, "Toyota hybrid lifetime (4B / 0.1km)"        },
      { 0x22, 0x1A88,  1.0f, "Lexus odometer 1A88 (4B / 1km)"             },
    };
    const size_t N_ODO_DIDS = sizeof(ODO_DIDS) / sizeof(ODO_DIDS[0]);

    bool odoOk = false;
    float odoScale = 10.0f;

    if (obdRequest(0xA6, buf2, len2) && len2 >= 4) {
      odoOk = true;   // universal PID -- always 0.1 km units
    } else if (activeOdoDid >= 0) {
      // Already locked onto a Toyota DID -- fast path
      uint8_t buf3[8]; uint8_t len3 = 0;
      if (obdRequestToyotaMeter(lockedOdoMode, lockedOdoDid, buf3, len3) && len3 >= 4) {
        buf2[0] = buf3[0]; buf2[1] = buf3[1];
        buf2[2] = buf3[2]; buf2[3] = buf3[3];
        odoOk = true;
        odoScale = ODO_DIDS[activeOdoDid].scale;
      }
    } else if (activeOdoDid == -1) {
      Serial.println("[OBD2] Odometer scan -- probing Toyota combo-meter (Mode 21) + UDS (Mode 22) DIDs (one-shot)");
      for (size_t i = 0; i < N_ODO_DIDS; i++) {
        uint8_t buf3[8]; uint8_t len3 = 0;
        bool got = obdRequestToyotaMeter(ODO_DIDS[i].mode, ODO_DIDS[i].did, buf3, len3);
        if (!got || len3 < 4) {
          Serial.printf("[OBD2]   Mode%02X DID 0x%04X: no response\n",
                        ODO_DIDS[i].mode, ODO_DIDS[i].did);
          continue;
        }
        uint32_t raw = ((uint32_t)buf3[0] << 24) | ((uint32_t)buf3[1] << 16) |
                       ((uint32_t)buf3[2] <<  8) |  (uint32_t)buf3[3];
        float km = raw / ODO_DIDS[i].scale;
        Serial.printf("[OBD2]   Mode%02X DID 0x%04X: len=%u raw=%02X %02X %02X %02X -> %.1f km (%s)\n",
                      ODO_DIDS[i].mode, ODO_DIDS[i].did, len3,
                      buf3[0], buf3[1], buf3[2], buf3[3], km, ODO_DIDS[i].note);
        // Plausibility: lifetime odometer between 100 and 5,000,000 km, OR
        bool plausible_lifetime = (km > 100.0f && km < 5000000.0f);
        bool plausible_trip     = (km > 0.1f   && km < 1000.0f);
        if (!odoOk && (plausible_lifetime || plausible_trip)) {
          buf2[0] = buf3[0]; buf2[1] = buf3[1];
          buf2[2] = buf3[2]; buf2[3] = buf3[3];
          odoOk     = true;
          odoScale  = ODO_DIDS[i].scale;
          activeOdoDid  = (int8_t)i;
          lockedOdoMode = ODO_DIDS[i].mode;
          lockedOdoDid  = ODO_DIDS[i].did;
          Serial.printf("[OBD2]   * locked Mode%02X DID 0x%04X -> %.1f km\n",
                        lockedOdoMode, lockedOdoDid, km);
        }
      }
      if (!odoOk) {
        activeOdoDid = -2;
        Serial.println("[OBD2] Odometer scan exhausted across Mode 21 + Mode 22 candidates.");
        Serial.println("[OBD2]   Falling back to OBD2 speed-integrated trip distance.");
        Serial.println("[OBD2]   For lifetime odometer, run canPassiveSniffer() to capture broadcast frames.");
      }
    }

    if (odoOk) {
      uint32_t rawOdo = ((uint32_t)buf2[0] << 24) |
                        ((uint32_t)buf2[1] << 16) |
                        ((uint32_t)buf2[2] << 8)  |
                        (uint32_t)buf2[3];
      obdOdometerKm = rawOdo / odoScale;
    }

    if (obdRequest(0x01, buf2, len2) && len2 >= 1) {
      obdDtcPresent = (buf2[0] & 0x80) != 0;
      obdDtcCount   = buf2[0] & 0x7F;
    }
  }

  // Fuel level

  // Mode 22 DID table -- extend here for other OEM vehicles as needed.
  static const uint16_t FUEL_DIDS[]    = { 0x1F2F, 0x0D0F, 0x2F08, 0x4C38, 0x2F09,
                                            0xF42F, 0xF45E, 0x110A, 0x1103 };
  static const bool     FUEL_BCM[]     = {   true,  false,  false,  false,  false,
                                             false,  false,  false,  false };
  static const uint8_t  FUEL_DID_N     = sizeof(FUEL_DIDS) / sizeof(FUEL_DIDS[0]);
  static const uint8_t  FUEL_EMPTY_RAW[] = {   0,   0,   0,   0,   0,
                                                0,   0,   0,   0 };
  static const uint8_t  FUEL_FULL_RAW[]  = { 255, 255, 255, 255, 255,
                                              255, 255, 255, 255 };

  static uint8_t  fuelFailCycles  = 0;
  static int8_t   activeFuelDid   = -1;
  static uint8_t  activeToyotaFuelCmd = 0;
  static String   fuelProfileTruckId = "";
  static uint32_t mode22ScanAfter = 0;    // rate-limit Mode 22 re-scan after repeated failures
  static uint32_t j1939ProbeAfter = 0;    // Hino passive probe cadence
  static uint32_t pathARetryAfter = 0;    // periodic Mode 01 retry while in Path B
  // Hino MAF-derived fuel state -- activated only after every direct fuel
  static bool     hinoMafActive       = false;
  static float    hinoMafBurnedL      = 0.0f;
  static uint32_t hinoMafLastPollMs   = 0;
  static uint8_t  hinoDirectFailStreak = 0;
  const  float    HINO_TANK_L         = 400.0f;   // Hino 700 series standard tank
  // Starting fuel percentage the driver reads off the physical dashboard
  const  float    HINO_START_PCT      = 45.0f;    // observed dashboard reading
  // Toyota PID 21/29 is the unsmoothed sender voltage -- slosh + ADC
  static const uint8_t FUEL_WIN = 31;   // widened from 15 -> 31 (~45 s memory at
  static float    fuelSampleBuf[FUEL_WIN] = {0};
  static uint8_t  fuelSampleCount  = 0;
  static uint8_t  fuelSampleIdx    = 0;
  static float    fuelLitersFilt   = NAN;
  static float    fuelPublishedPct = NAN;   // last value emitted to UI / telemetry
  static uint32_t fuelLastMovingMs = 0;     // last time obdSpeedKmh > 1 -- gates refuel up-snap
  // Post-refuel quiescence: once a refuel anchor fires, freeze the published
  static uint32_t refuelAnchoredAtMs = 0;
  static const uint32_t REFUEL_QUIESCENCE_MS = 300000UL;   // 5 min
  static uint32_t lastBurnTickMs = 0;
  static const uint32_t BURN_TICK_MS = 60000UL;  // one burn step per minute
  static const float   BURN_STEP_MAX = 2.0f;     // max % drop per tick
  // Toyota CAN ECUs occasionally NACK a Mode 21 read under traffic and
  static uint8_t  fortunerMissCount = 0;
  static const uint8_t FORTUNER_MISS_THRESHOLD = 5;
  if (obdSpeedKmh > 1.0f) fuelLastMovingMs = millis();
  // Soft reset: restart the median window but KEEP the published anchor
  auto resetFuelFilter = [&]() {
    fuelSampleCount = 0;
    fuelSampleIdx   = 0;
  };
  auto resetFuelFilterHard = [&]() {
    resetFuelFilter();
    fuelLitersFilt   = NAN;
    fuelPublishedPct = NAN;
  };
  String modelLower = selectedTruckModel;
  modelLower.toLowerCase();
  const bool fortunerProfile = modelLower.indexOf("fortuner") >= 0;
  const bool hinoProfile = modelLower.indexOf("hino") >= 0;
  if (fuelProfileTruckId != selectedTruckId) {
    fuelProfileTruckId = selectedTruckId;
    activeFuelDid = -1;
    activeToyotaFuelCmd = 0;
    mode22ScanAfter = 0;
    j1939ProbeAfter = 0;
    hinoMafActive        = false;
    hinoMafBurnedL       = 0.0f;
    hinoMafLastPollMs    = 0;
    hinoDirectFailStreak = 0;
    resetFuelFilterHard();   // new truck -- start fresh, no carry-over anchor
  }

  if (obdFuelMode01) {
    // Path A: Mode 01 PID 0x2F
    if (obdRequest(0x2F, buf, len, OBD_TIMEOUT_MS)) {
      obdFuelPct        = buf[0] * 100.0f / 255.0f;
      obdFuelChecked    = true;
      fuelFailCycles    = 0;
      obdFuelValid      = true;
      obdFuelSource     = "mode01";
      obdFuelConfidence = "high";
      Serial.printf("[FUEL] Mode01/0x2F: raw=0x%02X -> %.1f%%\n", buf[0], obdFuelPct);
    } else {
      fuelFailCycles++;
      Serial.printf("[FUEL] Mode01/0x2F: no response (fail #%u)\n", (unsigned)fuelFailCycles);
      if (fuelFailCycles >= 10) {
        obdFuelMode01   = false;
        fuelFailCycles    = 0;
        pathARetryAfter   = millis() + 60000UL;
        activeFuelDid     = -1;
        activeToyotaFuelCmd = 0;
        mode22ScanAfter   = 0;   // trigger immediate Mode 22 discovery
        obdFuelValid      = false;
        obdFuelSource     = "none";
        obdFuelConfidence = "low";
        resetFuelFilter();
        Serial.println("[FUEL] 10 Mode01 failures -- switching to Mode22 backup");
      }
    }
  } else {
    // Path B: Mode 22 backup

    if (millis() >= pathARetryAfter) {
      if (obdRequest(0x2F, buf, len, OBD_TIMEOUT_MS)) {
        obdFuelMode01     = true;
        fuelFailCycles    = 0;
        activeFuelDid     = -1;
        activeToyotaFuelCmd = 0;
        obdFuelPct        = buf[0] * 100.0f / 255.0f;
        obdFuelChecked    = true;
        obdFuelValid      = true;
        obdFuelSource     = "mode01";
        obdFuelConfidence = "high";
        Serial.printf("[FUEL] Mode01/0x2F restored: %.1f%% -- back on Path A\n", obdFuelPct);
        goto fuel_done;   // skip Mode 22 read this cycle
      }
      pathARetryAfter = millis() + 60000UL;
    }

    // Hino medium/heavy trucks commonly expose tank level through J1939 even
    if (hinoProfile && millis() >= j1939ProbeAfter) {
      float j1939FuelPct = -1.0f;
      if (probeHinoJ1939Fuel(j1939FuelPct)) {
        obdFuelPct = j1939FuelPct;
        obdFuelChecked = true;
        obdFuelValid = true;
        obdFuelSource = "hino_j1939_spn96";
        obdFuelConfidence = "high";
        j1939ProbeAfter = millis() + 10000UL;
        hinoMafActive = false;   // real direct fuel found -- abandon MAF fallback
        Serial.printf("[FUEL] Hino J1939 SPN96: %.1f%%\n", obdFuelPct);
        goto fuel_done;
      }
      j1939ProbeAfter = millis() + 30000UL;
      Serial.println("[FUEL] Hino J1939 fuel not observed -- retaining manufacturer fallback");

      // One-shot: kick a passive 500k+250k discovery sweep so the serial log
      if (!canDiscoveryDone && !canDiscoveryBusy) {
        canDiscoveryDone = true;
        BaseType_t ok = xTaskCreatePinnedToCore(
          hinoFuelDiscoveryTask, "canDisc", 4096, NULL, 1, NULL, 1);
        if (ok != pdPASS) {
          canDiscoveryDone = false;  // allow retry on next probe cycle
          Serial.println("[DISCOVERY] task spawn failed -- will retry next probe");
        } else {
          Serial.println("[DISCOVERY] task spawned -- passive sniff in background");
        }
      }

      // Hino AI research: fuel level is managed by the Meter/BCM cluster, not
      uint8_t rawFuel = 0;
      if (obdProbePid2FPhysical(rawFuel)) {
        obdFuelPct = rawFuel * 100.0f / 255.0f;
        obdFuelChecked = true;
        obdFuelValid = true;
        obdFuelSource = "hino_bcm_pid2f";
        obdFuelConfidence = "high";
        j1939ProbeAfter = millis() + 10000UL;
        hinoMafActive = false;   // real direct fuel found -- abandon MAF fallback
        Serial.printf("[FUEL] Hino BCM PID 0x2F: %.1f%%\n", obdFuelPct);
        goto fuel_done;
      }

      hinoDirectFailStreak++;
      if (!hinoMafActive && hinoDirectFailStreak >= 2) {
        hinoMafActive     = true;
        hinoMafBurnedL    = HINO_TANK_L * (1.0f - HINO_START_PCT / 100.0f);
        hinoMafLastPollMs = millis();
        Serial.println("[FUEL] Hino: direct fuel paths exhausted -- activating MAF-derived fuel");
        Serial.printf("[FUEL]   start=%.1f%% of %.0f L tank (pre-burned=%.1f L); PID 0x10 (MAF) -> J1979 diesel stoichiometry\n",
                      HINO_START_PCT, HINO_TANK_L, hinoMafBurnedL);
      }
    }

    if (hinoProfile && hinoMafActive) {
      uint8_t mafBuf[4]; uint8_t mafLen = 0;
      if (obdRequest(0x10, mafBuf, mafLen) && mafLen >= 2) {
        float maf_g_s = (256.0f * mafBuf[0] + mafBuf[1]) / 100.0f;
        if (maf_g_s >= 0.0f && maf_g_s <= 200.0f) {   // truck ceiling ~150 g/s
          uint32_t now = millis();
          if (hinoMafLastPollMs == 0) hinoMafLastPollMs = now;
          float dt_s = (now - hinoMafLastPollMs) / 1000.0f;
          hinoMafLastPollMs = now;
          if (dt_s > 0.0f && dt_s < 10.0f) {
            hinoMafBurnedL += (maf_g_s / 12064.0f) * dt_s;
          }
          float pct = 100.0f - (hinoMafBurnedL / HINO_TANK_L * 100.0f);
          if (pct < 0.0f)   pct = 0.0f;
          if (pct > 100.0f) pct = 100.0f;
          obdFuelPct        = pct;
          obdFuelChecked    = true;
          obdFuelValid      = true;
          obdFuelSource     = "hino_maf_computed";
          obdFuelConfidence = "medium";
          static uint32_t lastMafLogMs = 0;
          if (now - lastMafLogMs >= 5000) {   // rate-limit console spam
            Serial.printf("[FUEL] Hino MAF-derived: MAF=%.2f g/s  burned=%.3f L  tank=%.1f%%\n",
                          maf_g_s, hinoMafBurnedL, pct);
            lastMafLogMs = now;
          }
          goto fuel_done;
        }
        Serial.printf("[FUEL] Hino MAF out of range (%.1f g/s) -- ignored\n", maf_g_s);
      }
    }

    if (!hinoProfile) {
      if (activeToyotaFuelCmd == 0 && activeFuelDid < 0 && millis() >= mode22ScanAfter) {
        Serial.printf("[FUEL] Toyota meter probe -- configured model='%s'%s\n",
                      selectedTruckModel.c_str(), fortunerProfile ? " (Fortuner profile)" : " (auto-detect)");
        if (obdRequestToyotaMeter(0x21, 0x29, buf, len) && len >= 1) {
          activeToyotaFuelCmd = 1;
        } else if (obdRequestToyotaMeter(0x22, 0x1022, buf, len) && len >= 2) {
          activeToyotaFuelCmd = 2;
        } else {
          if (isnan(fuelPublishedPct)) {
            obdFuelPct = -1.0f;
            obdFuelValid = false;
            obdFuelSource = "none";
            obdFuelConfidence = "low";
          } else {
            obdFuelValid = false;   // mark stale, but keep the displayed pct
          }
          mode22ScanAfter = fortunerProfile ? millis() + 30000UL : 0;
          Serial.println("[FUEL] Toyota meter did not answer");
        }
      }

      if (activeToyotaFuelCmd != 0) {
        bool ok = activeToyotaFuelCmd == 1
            ? obdRequestToyotaMeter(0x21, 0x29, buf, len)
            : obdRequestToyotaMeter(0x22, 0x1022, buf, len);
        const bool responseComplete = ok &&
            ((activeToyotaFuelCmd == 1 && len >= 1) ||
             (activeToyotaFuelCmd == 2 && len >= 2));
        if (responseComplete) {
          fortunerMissCount = 0;   // a single good read resets the streak
          // Philippine second-generation Fortuner variants use an 80 L tank.
          float liters = activeToyotaFuelCmd == 1
              ? buf[0] * 0.5f
              : (((uint16_t)buf[0] << 8) | buf[1]) / 100.0f;

          // Stationary-only sampling: skip every reading taken while the truck
          const bool isStationary  = (obdSpeedKmh >= 0.0f && obdSpeedKmh <= 1.0f);
          const bool filterSeeded  = (fuelSampleCount >= FUEL_WIN);

          // Persistent-outlier recovery: if the live readings keep clustering
          static uint8_t persistentOutlierCount = 0;
          static float   lastOutlierValue       = NAN;

          if (filterSeeded && !isStationary) {
            // Don't even count this as a "miss" -- the sender is responding,
          } else if (!isnan(fuelLitersFilt) && fabsf(liters - fuelLitersFilt) > 6.0f) {
            // Outlier rejection at the median input -- an 80 L tank can't move
            Serial.printf("[FUEL] outlier raw rejected: raw=%.2fL filt=%.2fL d=%.2fL\n",
                          liters, fuelLitersFilt, liters - fuelLitersFilt);
            // Track whether outliers cluster around a stable new value -- if so,
            if (!isnan(lastOutlierValue) && fabsf(liters - lastOutlierValue) < 4.0f) {
              persistentOutlierCount++;
            } else {
              persistentOutlierCount = 1;
            }
            lastOutlierValue = liters;
            if (persistentOutlierCount >= 8) {
              Serial.printf("[FUEL] persistent outliers clustering near %.2fL -- "
                            "wiping stale filter (was filt=%.2fL)\n",
                            liters, fuelLitersFilt);
              // Hard reset the filter so the next reading re-seeds the pipeline.
              fuelLitersFilt = NAN;
              fuelSampleCount = 0;
              fuelSampleIdx = 0;
              persistentOutlierCount = 0;
              lastOutlierValue = NAN;
              fuelSampleBuf[fuelSampleIdx] = liters;
              fuelSampleIdx = (fuelSampleIdx + 1) % FUEL_WIN;
              fuelSampleCount++;
            }
          } else {
            fuelSampleBuf[fuelSampleIdx] = liters;
            fuelSampleIdx = (fuelSampleIdx + 1) % FUEL_WIN;
            if (fuelSampleCount < FUEL_WIN) fuelSampleCount++;
            persistentOutlierCount = 0;   // a good read clears the streak
            lastOutlierValue = NAN;
          }
          float sorted[FUEL_WIN];
          for (uint8_t i = 0; i < fuelSampleCount; i++) sorted[i] = fuelSampleBuf[i];
          for (uint8_t i = 1; i < fuelSampleCount; i++) {
            float v = sorted[i]; int j = (int)i - 1;
            while (j >= 0 && sorted[j] > v) { sorted[j + 1] = sorted[j]; j--; }
            sorted[j + 1] = v;
          }
          float medianL = sorted[fuelSampleCount / 2];
          // EMA gate: only feed the EMA once the median window is full
          if (fuelSampleCount >= FUEL_WIN) {
            if (isnan(fuelLitersFilt)) fuelLitersFilt = medianL;
            else                       fuelLitersFilt = fuelLitersFilt * 0.96f + medianL * 0.04f;
          } else if (isnan(fuelLitersFilt)) {
            // First-ever cold start with no anchor -- seed the EMA from the
            fuelLitersFilt = medianL;
          }

          // Per-vehicle tank capacity replaces the previous hardcoded 80 L
          float tankL = (fuelTankCapacityL > 1.0f) ? fuelTankCapacityL : 80.0f;
          float smoothedPct = constrain(fuelLitersFilt * 100.0f / tankL, 0.0f, 100.0f);
          // Publish strategy -- accurate AND visually stable:
          bool published = false;
          const char* reasonTag = "warming up";
          if (fuelSampleCount < FUEL_WIN && !isnan(fuelPublishedPct)) {
            obdFuelPct = fuelPublishedPct;
            obdFuelValid = true;        // anchor is trustworthy until the
            obdFuelSource = activeToyotaFuelCmd == 1
                ? (fortunerProfile ? "toyota_fortuner_2129" : "toyota_meter_2129")
                : (fortunerProfile ? "toyota_fortuner_221022" : "toyota_meter_221022");
          }
          if (fuelSampleCount >= FUEL_WIN) {
            const uint32_t lastDisturbMs = max((uint32_t)fuelLastMovingMs,
                                               (uint32_t)obdReconnectAtMs);
            const bool stationaryLongEnough =
              lastDisturbMs == 0 ||
              (millis() - lastDisturbMs) >= 60000UL;

            static uint32_t refuelCandidateSinceMs = 0;
            const bool aboveRefuelStep =
              !isnan(fuelPublishedPct) && (smoothedPct >= fuelPublishedPct + 10.0f);
            if (aboveRefuelStep) {
              if (refuelCandidateSinceMs == 0) refuelCandidateSinceMs = millis();
            } else {
              refuelCandidateSinceMs = 0;
            }
            const bool refuelPersistent =
              refuelCandidateSinceMs != 0 &&
              (millis() - refuelCandidateSinceMs) >= 90000UL;

            // Post-refuel quiescence: freeze anchor entirely for 5 min after
            const bool inRefuelQuiescence =
              refuelAnchoredAtMs != 0 &&
              (millis() - refuelAnchoredAtMs) < REFUEL_QUIESCENCE_MS;

            if (isnan(fuelPublishedPct)) {
              fuelPublishedPct = floorf(smoothedPct);
              reasonTag = "anchor";
            } else if (inRefuelQuiescence) {
              reasonTag = "quiescent";
            } else if (smoothedPct <= fuelPublishedPct - (
                          // While driving, tank slosh keeps the sender voltage
                          (fuelLastMovingMs != 0 && (millis() - fuelLastMovingMs) < 5000UL)
                            ? 0.5f : 1.5f)) {
              if (lastBurnTickMs == 0 || (millis() - lastBurnTickMs) >= BURN_TICK_MS) {
                float step  = fuelPublishedPct - smoothedPct;
                float clamp = (step > BURN_STEP_MAX) ? BURN_STEP_MAX : step;
                fuelPublishedPct = floorf(fuelPublishedPct - clamp);
                lastBurnTickMs   = millis();
                reasonTag = "burn";
              } else {
                reasonTag = "burn_pending";
              }
            } else if (refuelPersistent && stationaryLongEnough) {
              fuelPublishedPct = floorf(smoothedPct);
              reasonTag = "refuel";
              refuelCandidateSinceMs = 0;
              refuelAnchoredAtMs = millis();   // start quiescence window
              lastBurnTickMs = 0;              // reset burn cadence too
            } else if (aboveRefuelStep) {
              reasonTag = "refuel_pending";
            } else {
              reasonTag = "hold";
            }
            obdFuelPct = fuelPublishedPct;
            obdFuelChecked = true;
            obdFuelValid = true;
            obdFuelSource = activeToyotaFuelCmd == 1
                ? (fortunerProfile ? "toyota_fortuner_2129" : "toyota_meter_2129")
                : (fortunerProfile ? "toyota_fortuner_221022" : "toyota_meter_221022");
            obdFuelConfidence = "medium";
            published = true;
          }
          static uint32_t lastFuelLogMs = 0;
          bool isHold = (strcmp(reasonTag, "hold") == 0);
          if (!isHold || millis() - lastFuelLogMs >= 10000) {
            lastFuelLogMs = millis();
            Serial.printf("[FUEL] Fortuner meter: raw=%.2fL med=%.2fL filt=%.2fL -> smoothed=%.1f%% published=%s (n=%u/%u, %s, %s)\n",
                          liters, medianL, fuelLitersFilt, smoothedPct,
                          published
                            ? (String((int)fuelPublishedPct) + "%").c_str()
                            : "--",
                          fuelSampleCount, FUEL_WIN, reasonTag,
                          activeToyotaFuelCmd == 1
                            ? (fortunerProfile ? "toyota_fortuner_2129" : "toyota_meter_2129")
                            : (fortunerProfile ? "toyota_fortuner_221022" : "toyota_meter_221022"));
          }
        } else {
          fortunerMissCount++;
          if (fortunerMissCount >= FORTUNER_MISS_THRESHOLD) {
            Serial.printf("[FUEL] Fortuner meter response lost (%u misses) -- re-scanning\n",
                          (unsigned)fortunerMissCount);
            fortunerMissCount   = 0;
            activeToyotaFuelCmd = 0;
            mode22ScanAfter     = 0;
            resetFuelFilter();
            obdFuelValid = false;
          } else {
            Serial.printf("[FUEL] Fortuner meter miss %u/%u -- holding window\n",
                          (unsigned)fortunerMissCount, (unsigned)FORTUNER_MISS_THRESHOLD);
            // Anchor still valid? Keep displaying it; just mark this sample
            obdFuelValid = false;
          }
        }
      }
    }
    if (activeToyotaFuelCmd == 0 && !fortunerProfile) {
    if (activeFuelDid < 0 && millis() >= mode22ScanAfter) {
      Serial.println("[FUEL] Mode22 scan -- probing manufacturer fuel DIDs...");
      for (uint8_t i = 0; i < FUEL_DID_N; i++) {
        uint16_t did = FUEL_DIDS[i];
        bool ok = FUEL_BCM[i]
            ? obdRequestMode22BCM(did, buf, len)
            : obdRequestMode22(did, buf, len);
        if (ok && len >= 1) {
          activeFuelDid = (int8_t)i;
          Serial.printf("[FUEL] Mode22 DID 0x%04X FOUND via %s  len=%u  bytes:",
                        did, FUEL_BCM[i] ? "BCM(0x700)" : "ECU(0x7DF)", len);
          for (uint8_t b = 0; b < len; b++) Serial.printf(" 0x%02X", buf[b]);
          Serial.printf("  -> %.1f%%\n", buf[0] * 100.0f / 255.0f);
          break;
        }
        Serial.printf("[FUEL] Mode22 DID 0x%04X (%s) -- no response\n",
                      did, FUEL_BCM[i] ? "BCM" : "ECU");
      }
      if (activeFuelDid < 0) {
        Serial.println("[FUEL] No Mode22 DID responded -- fuel N/A");
        mode22ScanAfter = millis() + 30000UL;  // retry scan in 30 s
      }
    }

    // Step 2: read from the active Mode 22 DID every poll cycle.
    if (activeFuelDid >= 0) {
      uint16_t did      = FUEL_DIDS[activeFuelDid];
      uint8_t  emptyRaw = FUEL_EMPTY_RAW[activeFuelDid];
      uint8_t  fullRaw  = FUEL_FULL_RAW[activeFuelDid];
      bool ok = FUEL_BCM[activeFuelDid]
          ? obdRequestMode22BCM(did, buf, len)
          : obdRequestMode22(did, buf, len);
      if (ok && len >= 1) {
        float pct = (fullRaw > emptyRaw)
          ? constrain((buf[0] - emptyRaw) * 100.0f / (fullRaw - emptyRaw), 0.0f, 100.0f)
          : buf[0] * 100.0f / 255.0f;
        const char* conf = (did == 0x1F2F) ? "high" : ((fullRaw > emptyRaw) ? "medium" : "low");
        if (fabsf(pct - obdFuelPct) >= 0.5f) {
          Serial.printf("[FUEL] Mode22 DID 0x%04X: raw=0x%02X -> %.1f%%\n", did, buf[0], pct);
          obdFuelPct        = pct;
          obdFuelChecked    = true;
          obdFuelValid      = true;
          obdFuelSource     = "mode22";
          obdFuelConfidence = conf;
        }
      } else {
        Serial.printf("[FUEL] Mode22 DID 0x%04X lost -- re-scanning\n", did);
        activeFuelDid  = -1;
        mode22ScanAfter = 0;
      }
    }
    }
  }
  fuel_done:
  static uint32_t lastFuelSummaryMs = 0;
  if (millis() - lastFuelSummaryMs >= 10000) {
    lastFuelSummaryMs = millis();
    Serial.printf("[FUEL] speed=%.0f km/h  fuel=%.1f%%  src=%s profile=%s\n",
                  obdSpeedKmh, obdFuelPct, obdFuelSource,
                  hinoProfile ? "hino_j1939" :
                  (activeToyotaFuelCmd != 0 ? "toyota_meter" :
                  (fortunerProfile ? "toyota_fortuner" : "universal")));
  }
}

void refreshCanBadge() {
  char buf[48];
  uint32_t col;
  if (!canReady) {
    snprintf(buf, sizeof(buf), "CAN: FAIL -- check CS=GPIO14 wiring");
    col = TFT_RED;
  } else if (canObd2Ready) {
    // OBD2 mode -- show live speed and fuel
    if (obdSpeedKmh >= 0 && obdFuelPct >= 0) {
      snprintf(buf, sizeof(buf), "OBD2  %.0f km/h  fuel %.0f%%",
               obdSpeedKmh, obdFuelPct);
    } else if (obdSpeedKmh >= 0) {
      snprintf(buf, sizeof(buf), "OBD2  %.0f km/h  fuel N/A", obdSpeedKmh);
    } else {
      snprintf(buf, sizeof(buf), "OBD2 polling...");
    }
    col = TFT_GREEN;
  } else if (!canLoopbackOk) {
    snprintf(buf, sizeof(buf), "CAN: INIT...");
    col = C_ORANGE;
  } else {
    snprintf(buf, sizeof(buf), "CAN: Self-test OK");
    col = C_ACCENT;
  }

  if (state == READY) {
    tft.fillRoundRect(200, 162, 260, 24, 5, C_PANEL);
    tft.setTextColor(col);
    tft.drawString(buf, 208, 167, 1);
  } else if (state == TRIP_ACTIVE || state == TRIP_PAUSED) {
    // Always show Speed and Fuel rows -- dim when OBD2 not yet active.
    char spd[16], fuel[16];
    uint16_t spdCol, fuelCol;
    if (canObd2Ready) {
      snprintf(spd, sizeof(spd), obdSpeedKmh >= 0 ? "%.0f km/h" : "--", obdSpeedKmh);
      spdCol = TFT_GREEN;
      if (obdFuelPct >= 0) {
        // Show "<n>% (<l.l> L)" so the driver and any verification observer
        float litres = (fuelTankCapacityL > 1.0f)
                        ? (obdFuelPct * fuelTankCapacityL / 100.0f)
                        : -1.0f;
        if (litres >= 0.0f) {
          snprintf(fuel, sizeof(fuel), "%.0f%% (%.1fL)", obdFuelPct, litres);
        } else {
          snprintf(fuel, sizeof(fuel), "%.0f%%", obdFuelPct);
        }
        fuelCol = C_ACCENT;
      } else if (!obdFuelChecked) {
        snprintf(fuel, sizeof(fuel), "Loading");
        fuelCol = C_DIM2;
      } else {
        snprintf(fuel, sizeof(fuel), "--");
        fuelCol = C_ACCENT;
      }
    } else {
      snprintf(spd,  sizeof(spd),  "--");
      snprintf(fuel, sizeof(fuel), "--");
      spdCol  = C_DIM2;
      fuelCol = C_DIM2;
    }
    // No-change guard: TRIP_ACTIVE/PAUSED, refreshCanBadge fires on every
    if (strcmp(spd, lastCanBadgeSpdBuf) != 0 || spdCol != lastCanBadgeSpdCol) {
      drawInfoLine(TA_LP_X + 8, TA_LP_Y + 116, TA_LP_W - 16, 'S', "Speed", spd, spdCol);
      strlcpy(lastCanBadgeSpdBuf, spd, sizeof(lastCanBadgeSpdBuf));
      lastCanBadgeSpdCol = spdCol;
    }
    if (strcmp(fuel, lastCanBadgeFuelBuf) != 0 || fuelCol != lastCanBadgeFuelCol) {
      drawInfoLine(TA_LP_X + 8, TA_LP_Y + 144, TA_LP_W - 16, 'F', "Fuel", fuel, fuelCol);
      strlcpy(lastCanBadgeFuelBuf, fuel, sizeof(lastCanBadgeFuelBuf));
      lastCanBadgeFuelCol = fuelCol;
    }
  }
}

// SETUP
void setup() {
  // Silence Arduino-ESP32's HAL error channel.
  esp_log_level_set("ARDUHAL", ESP_LOG_NONE);

  ledcSetup(BUZZER_LEDC_CHANNEL, BUZZER_LEDC_FREQ, BUZZER_LEDC_RES);
  ledcAttachPin(BUZZER, BUZZER_LEDC_CHANNEL);
  ledcWrite(BUZZER_LEDC_CHANNEL, BUZZER_SILENT_DUTY);
  pinMode(BTN_TAKE_REST, INPUT_PULLUP);
  pinMode(BTN_SNOOZE,    INPUT);
  pinMode(TOUCH_IRQ_PIN, INPUT_PULLUP);
  pinMode(TOUCH_CS_PIN, OUTPUT);
  pinMode(CAN_CS_PIN, OUTPUT);
  pinMode(LORA_NSS_PIN, OUTPUT);
  pinMode(GSM_PWRKEY,    INPUT);          // released; never drive module's VBAT-domain PWRKEY HIGH
  digitalWrite(TOUCH_CS_PIN, HIGH);
  digitalWrite(CAN_CS_PIN, HIGH);
  digitalWrite(LORA_NSS_PIN, HIGH);
  Serial.begin(115200);
  Serial.println("[boot] FleetMonitor HMI starting (offline-first + GPS)");

  // Force ESP32 RTC to UTC so getLocalTime() always returns UTC timestamps
  setenv("TZ", "UTC0", 1);
  tzset();

  // GY-NEO-8M GPS on UART2
  gpsSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
  Serial.printf("[GPS] UART2 started -- RX=%d TX=%d baud=%d\n", GPS_RX_PIN, GPS_TX_PIN, GPS_BAUD);

  tft.init();
  tft.setRotation(1);

  // Re-init SPI for touch readback
  digitalWrite(TFT_CS,       HIGH);
  digitalWrite(LORA_NSS_PIN, HIGH);
  digitalWrite(CAN_CS_PIN,   HIGH);
  digitalWrite(TOUCH_CS_PIN, HIGH);
  SPI.begin(TFT_SCLK, TFT_MISO, TFT_MOSI, TOUCH_CS_PIN);
  delay(20);   // let the bus settle after the re-config

  {
    extern uint16_t readXpt2046Channel(uint8_t);
    uint16_t probeX = readXpt2046Channel(0xD0);
    uint16_t probeY = readXpt2046Channel(0x90);
    Serial.printf("[touch] post-init probe  X=%u Y=%u  (press the screen now to see live values)\n",
                  probeX, probeY);
  }

  // Touch calibration

  bool touchCalOk = false;
  size_t loadedSz = 0;
  { Preferences p; bool b = p.begin("fleet", true);
    loadedSz = p.getBytes("touchAffineCal", &touchCal, sizeof(touchCal));
    touchCalOk = (loadedSz == sizeof(touchCal));
    Serial.printf("[touch-cal] NVS load: begin=%s read=%u/%u -> %s\n",
                  b ? "OK" : "FAIL",
                  (unsigned)loadedSz, (unsigned)sizeof(touchCal),
                  touchCalOk ? "USING SAVED CAL" : "NEED CALIBRATION");
    p.end(); }
  if (!touchCalOk) {
    touchCalOk = calibrateFleetTouch();
  }
  if (!touchCalOk) {
    tft.fillScreen(TFT_BLACK);
    tft.setTextColor(TFT_RED, TFT_BLACK);
    tft.drawCentreString("Touch Cal Failed", SCREEN_W / 2, 118, 4);
    tft.setTextColor(TFT_WHITE, TFT_BLACK);
    tft.drawCentreString("Restart to retry calibration", SCREEN_W / 2, 172, 2);
    Serial.println("[touch] calibration failed");
    delay(2000);
  }
  Serial.printf("[touch] affine: x=%.6f*rx + %.6f*ry + %.2f, y=%.6f*rx + %.6f*ry + %.2f\n",
                touchCal.ax, touchCal.bx, touchCal.cx, touchCal.ay, touchCal.by, touchCal.cy);

  screenBoot();
  state = WIFI_CONNECT;

  drawGradientBg();
  tft.setTextColor(C_ACCENT);
  tft.drawCentreString("Connecting Cellular", SCREEN_W / 2, 100, 4);
  tft.setTextColor(C_DIM);
  tft.drawCentreString("A7670E Cellular", SCREEN_W / 2, 148, 2);
  tft.drawCentreString("Please wait -- offline mode if no signal", SCREEN_W / 2, 180, 2);

  gsmSerial.setRxBufferSize(4096);
  gsmSerial.begin(GSM_BAUD, SERIAL_8N1, GSM_RX_PIN, GSM_TX_PIN);
  Serial.printf("[GSM] UART1 started -- RX=%d TX=%d rxBuf=4096\n", GSM_RX_PIN, GSM_TX_PIN);
  bool gsmOk = gsmInit();

  drawGradientBg();
  if (gsmOk) {
    Serial.println("[GSM] online -- skipping WiFi");
    tft.setTextColor(TFT_GREEN);
    tft.drawCentreString("Cellular Connected!", SCREEN_W / 2, 108, 4);
    tft.setTextColor(C_DIM);
    tft.drawCentreString("A7670E registered on network", SCREEN_W / 2, 168, 2);
    isOnline = true;
    backendReachable = true;
    delay(400);
  } else {
    Serial.println("[GSM] failed -- offline mode");
    tft.setTextColor(TFT_RED);
    tft.drawCentreString("Cellular Failed", SCREEN_W / 2, 108, 4);
    tft.setTextColor(C_DIM);
    tft.drawCentreString("Check SIM, antenna, and power cap", SCREEN_W / 2, 168, 2);
    isOnline = false;
    delay(1000);
  }

  if (!SPIFFS.begin(true)) {
    Serial.println("[FS] SPIFFS mount failed -- telemetry buffering disabled");
  } else {
    telBufCount = countFileLines("/tel_buf.log");
    Serial.printf("[FS] SPIFFS mounted -- %d buffered records\n", telBufCount);
  }

  // MCP2515 CAN controller bring-up
  canSpi.begin(CAN_HSPI_SCK, CAN_HSPI_MISO, CAN_HSPI_MOSI, CAN_CS_PIN);
  Serial.printf("[CAN] HSPI started: SCK=%d MISO=%d MOSI=%d CS=%d\n",
                CAN_HSPI_SCK, CAN_HSPI_MISO, CAN_HSPI_MOSI, CAN_CS_PIN);

  drawGradientBg();
  tft.setTextColor(C_ACCENT);
  tft.drawCentreString("CAN Controller", SCREEN_W / 2, 100, 4);
  tft.setTextColor(C_DIM);
  tft.drawCentreString("Initializing MCP2515...", SCREEN_W / 2, 148, 2);
  tft.drawCentreString("SCK=GPIO12  MISO=GPIO2  MOSI=GPIO15  CS=GPIO14", SCREEN_W / 2, 176, 2);

  canReady = initCan();

  drawGradientBg();
  if (canReady) {
    canLoopbackOk = canSelfTest();
    if (canLoopbackOk) {
      tft.setTextColor(TFT_GREEN);
      tft.drawCentreString("CAN Ready!", SCREEN_W / 2, 100, 4);
      tft.setTextColor(C_DIM);
      tft.drawCentreString("MCP2515 loopback passed", SCREEN_W / 2, 148, 2);
      tft.drawCentreString("(OBD2 vehicle connection: not yet)", SCREEN_W / 2, 176, 2);
    } else {
      tft.setTextColor(C_ORANGE);
      tft.drawCentreString("CAN Init OK", SCREEN_W / 2, 100, 4);
      tft.setTextColor(C_DIM);
      tft.drawCentreString("Loopback RX timeout -- check crystal", SCREEN_W / 2, 148, 2);
      tft.drawCentreString("(try module with 16 MHz crystal)", SCREEN_W / 2, 176, 2);
    }
  } else {
    tft.setTextColor(TFT_RED);
    tft.drawCentreString("CAN FAIL", SCREEN_W / 2, 100, 4);
    tft.setTextColor(C_DIM);
    tft.drawCentreString("MCP2515 not responding", SCREEN_W / 2, 148, 2);
    tft.drawCentreString("Check: CS=GPIO14  SCK=18  MOSI=23  MISO=19", SCREEN_W / 2, 176, 2);
  }
  delay(1200);

  // OBD2 mode detection -- switch from loopback to normal if vehicle is connected
  if (canReady) {
    drawGradientBg();
    tft.setTextColor(C_ACCENT);
    tft.drawCentreString("OBD2 Init", SCREEN_W / 2, 100, 4);
    tft.setTextColor(C_DIM);
    tft.drawCentreString("Probing vehicle CAN bus...", SCREEN_W / 2, 148, 2);
    tft.drawCentreString("(ignition must be ON)", SCREEN_W / 2, 176, 2);

    canObd2Ready = tryObd2Mode();
    if (canObd2Ready) obdReconnectAtMs = millis();   // arm fuel up-snap holdoff

    drawGradientBg();
    if (canObd2Ready) {
      tft.setTextColor(TFT_GREEN);
      tft.drawCentreString("OBD2 Ready!", SCREEN_W / 2, 100, 4);
      tft.setTextColor(C_DIM);
      tft.drawCentreString("Vehicle ECU detected", SCREEN_W / 2, 148, 2);
      tft.drawCentreString("Reading speed + fuel level", SCREEN_W / 2, 176, 2);
    } else {
      tft.setTextColor(C_ORANGE);
      tft.drawCentreString("OBD2: No vehicle", SCREEN_W / 2, 100, 4);
      tft.setTextColor(C_DIM);
      tft.drawCentreString("MCP2515 in loopback (bench test mode)", SCREEN_W / 2, 148, 2);
      tft.drawCentreString("Plug OBD2 pigtail + ignition ON to activate", SCREEN_W / 2, 176, 2);
    }
    delay(1000);
  }

  drawGradientBg();
  tft.setTextColor(C_ACCENT);
  tft.drawCentreString("LoRa Radio", SCREEN_W / 2, 100, 4);
  tft.setTextColor(C_DIM);
  tft.drawCentreString("Initializing LORA-02 SX1278...", SCREEN_W / 2, 148, 2);
  tft.drawCentreString("NSS=GPIO13  DIO0=GPIO36  f=433.0MHz", SCREEN_W / 2, 176, 2);

  LoRa.setPins(LORA_NSS_PIN, LORA_RST_PIN, LORA_DIO0_PIN);
  if (LoRa.begin(LORA_FREQUENCY)) {
    LoRa.setSpreadingFactor(LORA_SF);
    LoRa.setSignalBandwidth(LORA_BW);
    LoRa.setTxPower(LORA_TX_POWER);
    LoRa.setSyncWord(0x12);
    loraReady = true;
    drawGradientBg();
    tft.setTextColor(TFT_GREEN);
    tft.drawCentreString("LoRa Ready!", SCREEN_W / 2, 100, 4);
    tft.setTextColor(C_DIM);
    tft.drawCentreString("433.0 MHz / SF7 / BW125kHz", SCREEN_W / 2, 148, 2);
    tft.drawCentreString("Primary: LoRa | Fallback: Cellular", SCREEN_W / 2, 176, 2);
    Serial.println("[LoRa] LORA-02 SX1278 initialized OK -- 433.0 MHz");
  } else {
    loraReady = false;
    drawGradientBg();
    tft.setTextColor(C_ORANGE);
    tft.drawCentreString("LoRa Not Found", SCREEN_W / 2, 100, 4);
    tft.setTextColor(C_DIM);
    tft.drawCentreString("Module absent or wiring issue", SCREEN_W / 2, 148, 2);
    tft.drawCentreString("Cellular will be used as primary", SCREEN_W / 2, 176, 2);
    Serial.println("[LoRa] LORA-02 SX1278 not found -- falling back to GSM-only mode");
  }
  delay(1200);

  // Restore NVS state
  nvsLoadPendingEnd();
  nvsLoadPendingSnooze();
  nvsLoadPendingTripBody();
  nvsLoadPendingEvents();
  nvsLoadLocallyEndedTripId();
  nvsLoadOverspeedKmh();
  nvsLoadFuelTankCapacity();
  nvsLoadLastAlertTs();
  nvsLoadHmiSession();
  loadDriverCache();
  loadTruckCache();
  nvsLoadWifi();
  initDeviceId();

  if (!nvsWifiSsid.isEmpty()) {
    drawGradientBg();
    tft.setTextColor(C_ACCENT);
    tft.drawCentreString("Connecting via WiFi", SCREEN_W / 2, 100, 4);
    tft.setTextColor(C_DIM);
    tft.drawCentreString(nvsWifiSsid.c_str(), SCREEN_W / 2, 148, 2);
    tft.drawCentreString("Please wait...", SCREEN_W / 2, 180, 2);
    bool wfOk = tryWifiConnect();
    drawGradientBg();
    if (wfOk) {
      tft.setTextColor(TFT_GREEN);
      tft.drawCentreString("WiFi Connected!", SCREEN_W / 2, 108, 4);
      tft.setTextColor(C_DIM);
      String ipStr = "IP: " + WiFi.localIP().toString();
      tft.drawCentreString(ipStr.c_str(), SCREEN_W / 2, 168, 2);
      isOnline = true; backendReachable = true;
      delay(400);
    } else {
      tft.setTextColor(C_ORANGE);
      tft.drawCentreString("WiFi Failed", SCREEN_W / 2, 108, 4);
      tft.setTextColor(C_DIM);
      tft.drawCentreString("Falling back to Cellular...", SCREEN_W / 2, 168, 2);
      delay(600);
    }
  }

  // Create async HTTP queues and GSM UART mutex
  gHttpJobQ  = xQueueCreate(16, sizeof(HttpJob));
  gHttpDoneQ = xQueueCreate(16, sizeof(HttpResult));
  gsmMutex    = xSemaphoreCreateMutex();
  spiffsMutex = xSemaphoreCreateMutex();
  nvsMutex    = xSemaphoreCreateMutex();

  xTaskCreatePinnedToCore(
    httpWorkerTask,  // function
    "httpWorker",    // name
    12288,           // stack -- extra headroom for reconnect + CCLK + flush
    NULL,            // param
    1,               // priority
    NULL,            // handle
    0                // Core 0
  );

  lastHealthCheck = millis();
  state = LOGIN_PIN;
  screenLoginPin();
}

// LOOP
void loop() {

  // Bidirectional LoRa: drain queued downlinks + check for fresh ones
  checkLoRaIncoming();

  // Loop-alive heartbeat -- confirms Core 1 is running every 3 s
  { static unsigned long lastAlive = 0;
    if (millis() - lastAlive >= 3000) {
      lastAlive = millis();
      Serial.printf("[CORE1] alive -- state=%d canObd2=%d tripId=%s core=%d\n",
                    (int)state, (int)canObd2Ready,
                    activeTripId.isEmpty() ? "none" : activeTripId.substring(0,8).c_str(),
                    (int)xPortGetCoreID());
    }
  }

  // Opportunistic LoRa attempt for buffered trip/start
  { static unsigned long lastLoraStartTry = 0;
    static uint8_t       loraStartFails   = 0;
    static String        loraStartLastBody;
    if (pendingTripStartBody != loraStartLastBody) {
      loraStartFails    = 0;
      loraStartLastBody = pendingTripStartBody;
    }
    const unsigned long retryMs = (loraStartFails >= 1) ? 30000UL : 5000UL;
    const bool touchActive = (digitalRead(TOUCH_IRQ_PIN) == LOW);
    if (loraReady
     && !pendingTripStartBody.isEmpty()
     && millis() >= pendingTripStartReadyAt
     && millis() - lastLoraStartTry >= retryMs
     && !touchActive) {
      lastLoraStartTry = millis();
      Serial.printf("[trip/start] LoRa-first attempt from Core 1 (fails=%u, next in %lums)\n",
                    loraStartFails, retryMs);
      String resp = commEventSend("/trip/start", pendingTripStartBody);
      if (lastCommChannel == CH_LORA_OK || lastCommChannel == CH_WIFI_OK) {
        const char* ch = (lastCommChannel == CH_LORA_OK) ? "LoRa" : "WiFi";
        Serial.printf("[trip/start] synced via %s -- clearing pending body\n", ch);
        // If we synced via WiFi, the response includes the server's start_time.
        // Adopt it so reboot restores the correct driving clock.
        if (lastCommChannel == CH_WIFI_OK && !resp.isEmpty()) {
          JsonDocument sd;
          if (deserializeJson(sd, resp) == DeserializationError::Ok) {
            String serverStart = sd["start_time"].as<String>();
            if (serverStart.length() > 10 && activeTripStartIso.isEmpty()) {
              activeTripStartIso = serverStart;
              Serial.printf("[trip] adopted server start_time=%s\n", serverStart.c_str());
            }
          }
        }
        if (activeTripStartIso.isEmpty()) {
          JsonDocument sb;
          if (deserializeJson(sb, pendingTripStartBody) == DeserializationError::Ok) {
            String bodyStart = sb["start_time"].as<String>();
            if (bodyStart.length() > 10) activeTripStartIso = bodyStart;
          }
        }
        pendingTripStartBody = "";
        loraStartFails       = 0;
        loraStartLastBody    = "";
        nvsSavePendingTripBody("");
        { Preferences p; p.begin("fleet", false);
          p.remove("pendTripMs"); p.putString("pendTripId", ""); p.end(); }
        nvsSaveActiveTrip();   // persist so reboot restores the trip
      } else if (loraStartFails < 255) {
        loraStartFails++;
      }
      // If GSM also responded inline (non-blocking mutex), commEventSend already cleared
    }
  }

  pollGPS();

  // Periodic GPS status badge refresh
  if (millis() - lastGpsStatusRefresh > GPS_STATUS_REFRESH_MS) {
    lastGpsStatusRefresh = millis();
    if (!alertOverlayActive) refreshGpsStatusBadge();
  }

  // CAN polling -- OBD2 vehicle data or loopback self-test
  if (canReady && !alertOverlayActive &&
      (state == READY || state == TRIP_ACTIVE || state == TRIP_PAUSED)) {
    unsigned long nowMs = millis();
    if (canObd2Ready && nowMs - lastCanPoll >= OBD_POLL_MS) {
      // OBD2 mode: read speed + fuel from vehicle ECU every 1 s.
      lastCanPoll = nowMs;
      if (state != READY) {
        // Serial spam: print [OBD2] start/done bookends only every 10 polls
        static uint8_t obdLogCycle = 0;
        bool verboseTick = (++obdLogCycle >= 10);
        if (verboseTick) {
          obdLogCycle = 0;
          Serial.printf("[OBD2] poll -- fuelMode01=%d spd=%.0f fuel=%.1f\n",
                        (int)obdFuelMode01, obdSpeedKmh, obdFuelPct);
        }
        pollObd2();
        refreshCanBadge();
      }
    } else if (!canObd2Ready && nowMs - lastCanPoll >= CAN_POLL_MS) {
      // Bench/loopback mode: self-test heartbeat every 5 s
      lastCanPoll = nowMs;
      bool prev = canLoopbackOk;
      canLoopbackOk = canSelfTest();
      Serial.printf("[CAN] loopback self-test: %s  tx=%u rx=%u\n",
                    canLoopbackOk ? "OK" : "FAIL", canTxCount, canRxCount);

      // Skipped in READY state -- tryObd2Mode()+logSupportedPids() can block Core 1 for
      static unsigned long lastObd2Probe = 0;
      if (state == READY) {
        lastObd2Probe = nowMs;
      } else if (nowMs - lastObd2Probe >= 20000UL) {
        // 20 s cadence: previous 120 s value meant a driver who replugged
        lastObd2Probe = nowMs;
        Serial.println("[OBD2] Periodic probe -- checking for vehicle OBD2 connector...");
        Serial.printf("[OBD2]   canReady=%d canObd2Ready=%d canLoopbackOk=%d crystal=%uMHz\n",
                      (int)canReady, (int)canObd2Ready, (int)canLoopbackOk, (unsigned)canCrystalMhz);
        if (tryObd2Mode()) {
          canObd2Ready     = true;
          obdFuelChecked   = false;
          obdSpeedKmh      = -1.0f;
          obdFuelPct       = -1.0f;
          obdReconnectAtMs = nowMs;   // arm 60 s fuel up-snap holdoff
          lastCanPoll      = nowMs;
          Serial.println("[OBD2] Vehicle OBD2 detected -- switched to OBD2 polling mode");
        } else {
          Serial.println("[OBD2] No vehicle detected -- staying in loopback mode");
        }
      }

      refreshCanBadge();
      if (canLoopbackOk != prev) statusBarDirty = true;
    }
  }

  // Process async HTTP results
  processHttpDone();

  // Flush deferred screen redraws from remote dispatchers
  if (pendingScreenRedraw != SCR_NONE) {
    uint8_t scr = pendingScreenRedraw;
    pendingScreenRedraw = SCR_NONE;
    if (scr == SCR_TRIP_PAUSED && state == TRIP_PAUSED) screenTripPaused();
    else if (scr == SCR_TRIP_ACTIVE && state == TRIP_ACTIVE) screenTripActive();
    else if (scr == SCR_TRIP_ENDED && state == TRIP_ENDED) {
      screenTripEnded(pendingTripEndedSeconds);
    }
  }

  // WiFi watchdog: detect drop -> clear flag -> attempt reconnect
  {
    static unsigned long lastWifiCheck   = 0;
    static unsigned long lastWifiReconn  = 0;
    unsigned long nowMs = millis();
    if (wifiReady && nowMs - lastWifiCheck >= 5000) {
      lastWifiCheck = nowMs;
      if (WiFi.status() != WL_CONNECTED) {
        wifiReady      = false;
        statusBarDirty = true;
        Serial.println("[wifi] dropped -- GSM fallback active");
        // Kick a non-blocking reconnect immediately
        if (!nvsWifiSsid.isEmpty()) {
          WiFi.disconnect(false);
          WiFi.begin(nvsWifiSsid.c_str(), nvsWifiPass.c_str());
          lastWifiReconn = nowMs;
        }
      }
    }
    if (!wifiReady && !nvsWifiSsid.isEmpty() && nowMs - lastWifiReconn >= 5000) {
      if (WiFi.status() == WL_CONNECTED) {
        wifiReady      = true;
        statusBarDirty = true;
        Serial.printf("[wifi] reconnected -- IP %s\n", WiFi.localIP().toString().c_str());
      } else {
        // Retry reconnect every 30 s
        if (nowMs - lastWifiReconn >= 30000) {
          WiFi.begin(nvsWifiSsid.c_str(), nvsWifiPass.c_str());
          lastWifiReconn = nowMs;
          Serial.println("[wifi] retrying reconnect...");
        }
      }
    }
  }

  // No periodic override needed -- the CSQ poll handles dropout detection.

  {
    // "OFFLINE" while LoRa is happily carrying trip events to the gateway.
    bool nowOnline = gsmReady
                  || (wifiReady && WiFi.status() == WL_CONNECTED)
                  || (loraReady && loraGatewayRecentlyOk());
    if (nowOnline != isOnline) {
      isOnline = nowOnline;
      statusBarDirty = true;
      Serial.printf("[status] online=%s (gsm=%s wifi=%s)\n",
        isOnline ? "true" : "false",
        gsmReady ? "y" : "n",
        wifiReady ? "y" : "n");
    }
    static bool prevBackendReachable = false;
    if ((bool)backendReachable != prevBackendReachable) {
      prevBackendReachable = backendReachable;
      statusBarDirty = true;
      Serial.printf("[status] backendReachable=%s\n", backendReachable ? "true" : "false");
    }
    if (statusBarDirty && state != BOOT && state != WIFI_CONNECT) {
      statusBarDirty = false;
      drawStatusBar();
    }
  }

  // Periodic retry: offline-buffered trip end
  const unsigned long endRetryInterval = loraReady ? 5000UL : 30000UL;
  if (!pendingEndTripId.isEmpty() && isOnline && millis() - lastEndRetry > endRetryInterval) {
    lastEndRetry = millis();
    if (!activeTripId.isEmpty() && pendingTripStartBody.isEmpty() && pendingEndTripId != activeTripId) {
      Serial.printf("[trip/end] clearing stale retry pendingEnd=%s while activeTrip=%s\n",
                    pendingEndTripId.c_str(), activeTripId.c_str());
      pendingEndTripId = "";
      pendingEndTime   = "";
      nvsSavePendingEnd("");
      nvsSavePendingEndTime("");
    } else {
      queueEndTrip(pendingEndTripId, pendingEndTime);
    }
  }

  // Periodic retry: HMI snooze must be visible on the LoRa gateway/activity path.
  if (!pendingSnoozeId.isEmpty() && loraReady) {
    static unsigned long lastSnoozeLoraRetry = 0;
    if (millis() - lastSnoozeLoraRetry > 10000UL) {
      lastSnoozeLoraRetry = millis();
      sendSnoozeLoraOnly(pendingSnoozeId);
    }
  }
  // Periodic retry: HMI rest must be visible on the LoRa gateway/activity path.
  if (!pendingPauseTripId.isEmpty() && pendingPauseTripId != activeTripId) {
    pendingPauseTripId = "";
    pendingPauseTime   = "";
  }
  if (!pendingPauseTripId.isEmpty() && loraReady) {
    static unsigned long lastPauseLoraRetry = 0;
    if (millis() - lastPauseLoraRetry > 5000UL) {
      lastPauseLoraRetry = millis();
      sendPauseLoraOnly(pendingPauseTripId, pendingPauseTime);
    }
  }
  // Periodic retry: HMI resume must be visible on the LoRa gateway/activity path.
  if (!pendingResumeTripId.isEmpty() && loraReady) {
    static unsigned long lastResumeLoraRetry = 0;
    if (millis() - lastResumeLoraRetry > 5000UL) {
      lastResumeLoraRetry = millis();
      sendResumeLoraOnly(pendingResumeTripId, pendingResumeTime);
    }
  }
  // HMI session heartbeat -- keeps mobile app access alive
  bool currentlyOnline = isOnline;
  // Fire immediate heartbeat on reconnect so mobile sees session come back quickly
  if (!hmiSessionId.isEmpty() && !driverId.isEmpty() &&
      currentlyOnline && !prevOnlineState) {
    lastHmiHeartbeat = millis();
    queueHmiHeartbeat();
  }
  prevOnlineState = currentlyOnline;
  const uint32_t heartbeatInterval =
      (!wifiReady && gsmReady && !activeTripId.isEmpty()) ? 90000UL : 20000UL;
  if (!hmiSessionId.isEmpty() && !driverId.isEmpty() &&
      millis() - lastHmiHeartbeat > heartbeatInterval) {
    lastHmiHeartbeat = millis();
    if (currentlyOnline) {
      queueHmiHeartbeat();
    }
  }

  // Touch detection
  if (digitalRead(TOUCH_IRQ_PIN) == HIGH) touchReleasedSinceLastTap = true;

  bool isTouched = false;
  int  sx = 0, sy = 0;
  if (millis() >= touchDebounceUntil
      && touchReleasedSinceLastTap
      && digitalRead(TOUCH_IRQ_PIN) == LOW) {
    uint16_t _tx, _ty;
    if (getFleetTouch(&_tx, &_ty)) {
      sx = (int)_tx;
      sy = (int)_ty;
      isTouched = true;
      touchDebounceUntil        = millis() + TOUCH_DEBOUNCE_MS;
      touchReleasedSinceLastTap = false;   // require lift before next tap
      Serial.printf("[TOUCH] screen=(%d,%d)\n", sx, sy);
    }
  }

  if (isTouched && state != WIFI_SETTINGS && state != BOOT && state != WIFI_CONNECT && inWifiStatusBtn(sx, sy)) {
    wifiReturnState = state;
    wsetScanMode = false;
    wsetUseBuffers = false;
    beepOk();
    state = WIFI_SETTINGS;
    screenWifiSettings();
    return;
  }

  switch (state) {

    // PIN entry
    case LOGIN_PIN:
      if (pinRevealIdx >= 0 && millis() >= pinRevealUntil) {
        pinRevealIdx = -1;
        drawPinDots();
      }
      if (isTouched) {
        String key = getTappedNumpad(sx, sy);
        Serial.printf("[LOGIN_PIN] touch=(%d,%d) key=%s\n", sx, sy, key.c_str());
        if (key == "CLR") {
          if (driverPin.length() > 0) {
            pinRevealIdx = -1;
            driverPin.remove(driverPin.length() - 1);
            drawPinDots(); beepOk();
          }
        } else if (key == "OK") {
          if (driverPin.length() == 4) {
            pinRevealIdx = -1;
            screenLoadingStart(isOnline ? "Logging in..." : "Checking cache...");
            if (apiLogin()) {
              beepOk(); delay(80); beepOk();
              Serial.printf("[LOGIN_PIN] success driver=%s\n", driverName.c_str());
              if (loginFoundActiveTrip) {
                screenLoadingStop();
                screenLoading("Resuming active trip...");
                restoreServerTripClock();
                lastShownAlertId = "";
                restAlertSnoozedUntil = 0;
                fetchRestThreshold();
                // USB-power-loss recovery: force an immediate /device/alerts poll so
                lastAlertPoll     = 0;
                lastTelemetryPost = millis() - TELEMETRY_INTERVAL_MS + 3000;
                Serial.printf("[LOGIN_PIN] resuming trip=%s truck=%s\n",
                              activeTripId.c_str(), selectedTruckCode.c_str());
                state = (activeTripStatus == "paused") ? TRIP_PAUSED : TRIP_ACTIVE; if (state == TRIP_PAUSED) screenTripPaused(); else screenTripActive();
              } else {
                screenLoadingStart("Loading trucks...");
                fetchTrucks();
                screenLoadingStop();
                state = TRUCK_SELECT; screenTruckSelect();
              }
            } else {
              screenLoadingStop();
              driverPin = ""; state = LOGIN_PIN; screenLoginPin();
            }
          }
        } else if (inBtn(sx, sy, 420, 292, 48, 22)) {
          // WiFi settings button
          beepOk();
          wifiReturnState = LOGIN_PIN;
          wsetScanMode = false;
          wsetUseBuffers = false;
          state = WIFI_SETTINGS; screenWifiSettings();
        } else if (key.length() > 0 && driverPin.length() < 4) {
          driverPin += key;
          pinRevealIdx  = driverPin.length() - 1;
          pinRevealUntil = millis() + 1400;
          beepOk(); drawPinDots();
          if (driverPin.length() == 4) {
            delay(180);
            pinRevealIdx = -1;
            screenLoadingStart(isOnline ? "Logging in..." : "Checking cache...");
            if (apiLogin()) {
              beepOk(); delay(80); beepOk();
              if (loginFoundActiveTrip) {
                screenLoadingStop();
                screenLoading("Resuming active trip...");
                restoreServerTripClock();
                lastShownAlertId = "";
                restAlertSnoozedUntil = 0;
                fetchRestThreshold();
                // USB-power-loss recovery: force an immediate /device/alerts poll so the
                // HMI re-syncs threshold, route, and pending_actions without delay.
                lastAlertPoll     = 0;
                lastTelemetryPost = millis() - TELEMETRY_INTERVAL_MS + 3000;
                state = (activeTripStatus == "paused") ? TRIP_PAUSED : TRIP_ACTIVE; if (state == TRIP_PAUSED) screenTripPaused(); else screenTripActive();
              } else {
                screenLoadingStart("Loading trucks...");
                fetchTrucks();
                screenLoadingStop();
                state = TRUCK_SELECT; screenTruckSelect();
              }
            } else {
              screenLoadingStop();
              driverPin = ""; state = LOGIN_PIN; screenLoginPin();
            }
          }
        }
      }
      break;

    // WiFi Settings
    case WIFI_SETTINGS:
      if (isTouched) {
        if (wsetScanMode) {
          if (inBtn(sx, sy, 18, 272, 96, 34)) {
            wsetScanMode = false;
            screenWifiSettings();
            break;
          }
          for (int i = 0; i < wsetScanCount; i++) {
            int y = 126 + i * 30;
            if (inBtn(sx, sy, 18, y, 444, 26)) {
              strncpy(wsetSsidBuf, wsetScanSsids[i].c_str(), sizeof(wsetSsidBuf)-1);
              wsetSsidBuf[sizeof(wsetSsidBuf)-1] = '\0';
              memset(wsetPassBuf, 0, sizeof(wsetPassBuf));
              wsetField = 1;
              wsetScanMode = false;
              wsetUseBuffers = true;
              beepOk();
              screenWifiSettings();
              break;
            }
          }
          break;
        }
        if (inBtn(sx, sy, 374, 54, 86, 40)) {
          screenLoading("Scanning WiFi...");
          // Disconnect any pending connection attempt before scanning.
          WiFi.mode(WIFI_STA);
          WiFi.disconnect(false);
          delay(200);
          int n = WiFi.scanNetworks();  // blocking, returns count or negative on error
          Serial.printf("[wifi] scan: %d network(s) found\n", n);
          wsetScanCount = (n > 0) ? min(n, 5) : 0;
          for (int i = 0; i < wsetScanCount; i++) wsetScanSsids[i] = WiFi.SSID(i);
          WiFi.scanDelete();
          // Kick reconnect after scan so we don't stay disconnected
          if (!nvsWifiSsid.isEmpty()) WiFi.begin(nvsWifiSsid.c_str(), nvsWifiPass.c_str());
          wsetScanMode = true;
          wsetUseBuffers = true;
          beepOk();
          screenWifiSettings();
          break;
        }
        // Field tap: toggle focused field
        for (int fi = 0; fi < 2; fi++) {
          int fy = 40 + fi * 29;
          int fw = 364;
          if (inBtn(sx, sy, 8, fy, fw, 26)) {
            wsetField = fi;
            wsetDrawField(0); wsetDrawField(1);
            break;
          }
        }
        // Keyboard rows
        const char* rowsUp[4][11] = {
          {"1","2","3","4","5","6","7","8","9","0", nullptr},
          {"Q","W","E","R","T","Y","U","I","O","P", nullptr},
          {"A","S","D","F","G","H","J","K","L",nullptr,nullptr},
          {"Z","X","C","V","B","N","M",nullptr,nullptr,nullptr,nullptr},
        };
        const char* rowsLo[4][11] = {
          {"1","2","3","4","5","6","7","8","9","0", nullptr},
          {"q","w","e","r","t","y","u","i","o","p", nullptr},
          {"a","s","d","f","g","h","j","k","l",nullptr,nullptr},
          {"z","x","c","v","b","n","m",nullptr,nullptr,nullptr,nullptr},
        };
        const char* (*rows)[11] = wsetCapsLock ? rowsUp : rowsLo;
        int rowKeys[4] = {10, 10, 9, 7};
        int rowY[4]    = {102, 138, 174, 210};
        bool handled   = false;
        for (int row = 0; row < 4 && !handled; row++) {
          int kw = WSET_KEY_W, kh = WSET_KEY_H, gap = WSET_KEY_GAP;
          int totalW = rowKeys[row] * kw + (rowKeys[row]-1) * gap;
          int startX = (480 - totalW) / 2;
          int y = rowY[row];
          for (int k = 0; k < rowKeys[row] && !handled; k++) {
            int x = startX + k * (kw + gap);
            if (inBtn(sx, sy, x, y, kw, kh)) {
              wsetAppend(rows[row][k][0]);
              beepOk(); handled = true;
            }
          }
          // Backspace on row 3
          if (row == 3 && !handled) {
            int bspX = startX + 7*(kw+gap);
            int bspW = 480 - WSET_MARGIN - bspX;
            if (inBtn(sx, sy, bspX, y, bspW, kh)) {
              wsetBackspace(); beepOk(); handled = true;
            }
          }
        }
        if (!handled) {
          int ay = 248, smW = 34, ah = 34, gap = WSET_KEY_GAP;
          // CAPS -- leftmost
          if (!handled && inBtn(sx, sy, WSET_MARGIN, ay, 50, ah)) {
            wsetCapsLock = !wsetCapsLock;
            wsetDrawKeyboard();   // fast partial redraw -- no full screen repaint
            beepOk(); handled = true;
          }
          const char* symKeys2[] = {"@","-","_",".","(",")"};
          const int   symCount2  = sizeof(symKeys2) / sizeof(symKeys2[0]);
          for (int k = 0; k < symCount2 && !handled; k++) {
            int x = WSET_MARGIN + 50 + gap + k * (smW + gap);
            if (inBtn(sx, sy, x, ay, smW, ah)) {
              wsetAppend(symKeys2[k][0]); beepOk(); handled = true;
            }
          }
          int symEndX = WSET_MARGIN + 50 + gap + symCount2 * (smW + gap);
          int saveX   = 480 - WSET_MARGIN - 64;
          int backX   = saveX - gap - 64;
          int spaceW  = backX - gap - symEndX;
          int spaceX  = symEndX;
          if (!handled && inBtn(sx, sy, spaceX, ay, spaceW, ah)) {
            wsetAppend(' '); beepOk(); handled = true;
          }
          // BACK
          if (!handled && inBtn(sx, sy, backX, ay, 64, ah)) {
            beepOk();
            state = wifiReturnState;
            if      (state == LOGIN_PIN)    screenLoginPin();
            else if (state == TRUCK_SELECT) screenTruckSelect();
            else if (state == READY)        screenReady();
            else if (state == TRIP_ACTIVE)  screenTripActive();
            else if (state == TRIP_PAUSED)  screenTripPaused();
            else { state = LOGIN_PIN; screenLoginPin(); }
            handled = true;
          }
          // SAVE
          if (!handled && inBtn(sx, sy, saveX, ay, 64, ah)) {
            String newSsid = String(wsetSsidBuf);
            String newPass = String(wsetPassBuf);
            nvsSaveWifi(newSsid, newPass);
            beepOk(); delay(80); beepOk();
            // Attempt WiFi connection immediately
            if (!newSsid.isEmpty()) {
              screenLoading("Connecting to WiFi...");
              bool ok = tryWifiConnect();
              drawGradientBg();
              tft.setTextColor(ok ? TFT_GREEN : TFT_RED);
              tft.drawCentreString(ok ? "WiFi Connected!" : "WiFi Failed", SCREEN_W/2, 108, 4);
              tft.setTextColor(C_DIM);
              if (ok) {
                String ipStr = "IP: " + WiFi.localIP().toString();
                tft.drawCentreString(ipStr.c_str(), SCREEN_W/2, 168, 2);
                isOnline = true; backendReachable = true;
              } else {
                tft.drawCentreString("Check SSID / password", SCREEN_W/2, 168, 2);
              }
              delay(1200);
            }
            state = wifiReturnState;
            if      (state == LOGIN_PIN)    screenLoginPin();
            else if (state == TRUCK_SELECT) screenTruckSelect();
            else if (state == READY)        screenReady();
            else if (state == TRIP_ACTIVE)  screenTripActive();
            else if (state == TRIP_PAUSED)  screenTripPaused();
            else { state = LOGIN_PIN; screenLoginPin(); }
            handled = true;
          }
        }
      }
      break;

    // Truck selection
    case TRUCK_SELECT: {
      // Background refresh of in-use / online state.
      static unsigned long lastTruckRefreshMs = 0;
      if (wifiReady
          && (millis() - lastTruckRefreshMs) > 60000UL) {
        lastTruckRefreshMs = millis();
        if (fetchTrucks()) screenTruckSelect();
      }
      if (isTouched) {
        bool handled = false;
        for (int i = 0; i < truckCount && i < 6; i++) {
          int bx = TS_X0 + (i % 2) * (TS_BW + TS_GAP);
          int by = TS_Y0 + (i / 2) * (TS_BH + TS_GAP);
          if (inBtn(sx, sy, bx, by, TS_BW, TS_BH)) {
            if (trucks[i].status == "maintenance") {
              beepError();
              tft.setTextColor(TFT_RED);
              tft.drawCentreString("Truck under maintenance",
                                    SCREEN_W / 2, SCREEN_H - 30, 2);
              handled = true; break;
            }
            if (trucks[i].active) {
              // Check if the active trip on this truck belongs to THIS driver.
              selectedTruckId   = trucks[i].id;
              selectedTruckCode = trucks[i].code;
              selectedTruckModel = trucks[i].model;
              checkExternalTrip();   // populates externalTripId + externalDriverId
              if (!externalTripId.isEmpty() && externalDriverId == driverId) {
                // This driver's trip -- adopt it
                screenLoading("Syncing your trip...");
                activeTripId          = externalTripId;
                activeTripStartIso    = externalTripStart;
                activeTripPausedIso   = externalPausedAt;
                activeTripNextRestAlertIso = externalNextRestAlert;
                activeTripRestSeconds = externalRestSeconds;
                externalTripId = ""; externalDriverId = "";
                externalDriverName = ""; externalTripStart = "";
                externalPausedAt = ""; externalNextRestAlert = ""; externalRestSeconds = 0;
                externalChannel = "";
                beepOk();
                restoreServerTripClock();
                lastShownAlertId = "";
                restAlertSnoozedUntil = 0;
                fetchRestThreshold();
                lastAlertPoll     = millis();
                lastTelemetryPost = millis() - TELEMETRY_INTERVAL_MS + 3000;
                state = (activeTripStatus == "paused") ? TRIP_PAUSED : TRIP_ACTIVE;
                if (state == TRIP_PAUSED) screenTripPaused(); else screenTripActive();
              } else {
                // Someone else's trip -- block
                selectedTruckId = ""; selectedTruckCode = ""; selectedTruckModel = "";
                externalTripId = ""; externalDriverId = "";
                beepError();
                tft.setTextColor(TFT_RED);
                tft.drawCentreString("In use by another driver", SCREEN_W / 2, SCREEN_H - 30, 2);
              }
              handled = true; break;
            }
            selectedTruckId   = trucks[i].id;
            selectedTruckCode = trucks[i].code;
            selectedTruckModel = trucks[i].model;
            beepOk();
            state = READY;
            lastExternalTripCheck = 0;  // trigger immediate check on first entry
            screenReady();
            handled = true; break;
          }
        }
        if (!handled && inBtn(sx, sy, 338, 270, 132, 44)) {
          beepOk();
          screenLoadingStart("Refreshing trucks...");
          bool ok = fetchTrucks();
          screenLoadingStop();
          if (!ok) {
            screenLoading("No trucks found");
            delay(1000);
          }
          state = TRUCK_SELECT; screenTruckSelect();
          handled = true;
        }
        if (!handled && inBtn(sx, sy, BACK_X, BACK_Y, BACK_W, BACK_H)) {
          doLogout();
        }
      }
      break;
    }

    // Ready
    case READY:
      { static unsigned long lastReadyDiag = 0;
        if (millis() - lastReadyDiag >= 3000) {
          lastReadyDiag = millis();
          Serial.printf("[READY] alive  extTrip=%s  activeTripId=%s  isTouched=%d  sx=%d sy=%d\n",
            externalTripId.isEmpty() ? "none" : externalTripId.c_str(),
            activeTripId.isEmpty()   ? "none" : activeTripId.c_str(),
            (int)isTouched, sx, sy);
        }
      }

      if (isOnline && !activeTripId.length() &&
          millis() - lastExternalTripCheck > EXTERNAL_TRIP_CHECK_MS) {
        lastExternalTripCheck = millis();
        queueExternalTripCheck();
      }

      // Auto-adopt: if mobile started a trip, transition immediately -- no tap required
      if (!externalTripId.isEmpty()) {
        screenLoading("Syncing trip from mobile...");
        activeTripId          = externalTripId;
        activeTripStartIso    = externalTripStart;
        activeTripPausedIso   = externalPausedAt;
        activeTripNextRestAlertIso = externalNextRestAlert;
        activeTripRestSeconds = externalRestSeconds;
        externalTripId        = "";
        externalDriverId      = "";
        externalDriverName    = "";
        externalTripStart     = "";
        externalPausedAt      = "";
        externalNextRestAlert = "";
        externalRestSeconds   = 0;
        externalChannel       = "";
        beepOk();
        restoreServerTripClock();
        lastShownAlertId      = "";
        restAlertSnoozedUntil = 0;
        fetchRestThreshold();
        // Force an immediate /device/alerts poll so threshold, route, mobile companion
        lastAlertPoll         = 0;
        lastTelemetryPost     = millis() - TELEMETRY_INTERVAL_MS + 3000;
        Serial.printf("[ext-trip] auto-adopted -- activeTripId=%s status=%s\n",
          activeTripId.c_str(), activeTripStatus.c_str());
        state = (activeTripStatus == "paused") ? TRIP_PAUSED : TRIP_ACTIVE;
        if (state == TRIP_PAUSED) screenTripPaused(); else screenTripActive();
        break;
      }

      if (isTouched) {
        Serial.printf("[READY] touch=(%d,%d)  START_BTN=%d  BACK=%d  LOGOUT=%d\n",
          sx, sy,
          (int)inBtn(sx, sy, RDY_START_X, RDY_START_Y, RDY_START_W, RDY_START_H),
          (int)inBtn(sx, sy, RDY_BACK_X,  RDY_BACK_Y,  RDY_BACK_W,  RDY_BACK_H),
          (int)inBtn(sx, sy, RDY_LGOUT_X, RDY_LGOUT_Y, RDY_LGOUT_W, RDY_LGOUT_H));
        if (inBtn(sx, sy, RDY_START_X, RDY_START_Y, RDY_START_W, RDY_START_H)) {
          Serial.println("[READY] START TRIP pressed -- calling apiStartTrip()");
          apiStartTrip();
          beepOk();
          tripStart = millis(); pausedTotal = 0;
          lastRestMs            = millis();
          lastShownAlertId      = "";
          restAlertSnoozedUntil = 0;
          fetchRestThreshold();
          // Force an immediate /device/alerts poll once trip-start syncs so threshold,
          lastAlertPoll     = 0;
          lastTelemetryPost = millis() - TELEMETRY_INTERVAL_MS + 3000;
          activeTripStatus  = "active";
          state = TRIP_ACTIVE;
          Serial.printf("[READY->ACTIVE] calling screenTripActive() core=%d\n", (int)xPortGetCoreID());
          screenTripActive();
          Serial.println("[READY->ACTIVE] screenTripActive() returned -- entering TRIP_ACTIVE loop");
        } else if (inBtn(sx, sy, RDY_BACK_X, RDY_BACK_Y, RDY_BACK_W, RDY_BACK_H)) {
          externalTripId = "";   // clear banner on back navigation
          goToTruckSelect();
        } else if (inBtn(sx, sy, RDY_LGOUT_X, RDY_LGOUT_Y, RDY_LGOUT_W, RDY_LGOUT_H)) {
          externalTripId = "";
          doLogout();
        }
      }
      break;

    // Trip active
    case TRIP_ACTIVE:
      { static unsigned long lastActiveDiag = 0;
        if (millis() - lastActiveDiag >= 3000) {
          lastActiveDiag = millis();
          Serial.printf("[TRIP_ACTIVE] loop tick -- elapsed=%lus obd=%d fuel=%.1f spd=%.0f\n",
                        tripElapsedSec(), (int)canObd2Ready, obdFuelPct, obdSpeedKmh);
        }
      }
      refreshTimer();
      refreshRestCountdown();

      // Local rest timer -- fires even when offline (no server dependency).
      {
        unsigned long drivingMs  = millis() - lastRestMs;
        bool snoozeActive        = restAlertSnoozedUntil != 0 && millis() < restAlertSnoozedUntil;
        if (drivingMs >= restThresholdMs && !snoozeActive && !alertOverlayActive) {
          if (!localRestAlertPending) {
            localRestAlertPending = true;
            Serial.println("[ALERT] local rest timer fired (offline-safe)");
            showAlertOverlay("rest_alert", "");
          }
        } else {
          localRestAlertPending = false;  // reset so it re-fires after snooze expires
        }
      }

      // Local overspeed detection -- fires immediately on the HMI when the
      {
        static bool      localOverspeedActive   = false;
        static uint32_t  lastLocalOverspeedMs   = 0;
        const  uint32_t  OVERSPEED_RE_FIRE_MS   = 60000UL;
        float currentSpeed = (obdSpeedKmh >= 0.0f) ? obdSpeedKmh
                           : (gpsFix ? gpsSpeedKmh : -1.0f);
        if (currentSpeed >= 0.0f && overspeedThresholdKmh > 0.0f) {
          if (!localOverspeedActive && currentSpeed > overspeedThresholdKmh + 0.5f
              && !alertOverlayActive
              && (lastLocalOverspeedMs == 0
                  || millis() - lastLocalOverspeedMs > OVERSPEED_RE_FIRE_MS)) {
            localOverspeedActive = true;
            lastLocalOverspeedMs = millis();
            char msg[64];
            snprintf(msg, sizeof(msg), "Overspeed: %d km/h (limit %d km/h)",
                     (int)currentSpeed, (int)overspeedThresholdKmh);
            Serial.printf("[ALERT] local overspeed: %s\n", msg);
            showAlertOverlay("overspeed", String(msg));
          } else if (localOverspeedActive
                     && currentSpeed < overspeedThresholdKmh - 5.0f) {
            localOverspeedActive = false;  // exit hysteresis -- re-arm for next event
          }
        }
      }

      // Local low-fuel warning -- fires immediately when published fuel drops
      {
        static bool      localLowFuelActive  = false;
        static uint32_t  lastLocalLowFuelMs  = 0;
        const  uint32_t  LOW_FUEL_RE_FIRE_MS = 300000UL;
        if (obdFuelPct >= 0.0f) {
          if (!localLowFuelActive && obdFuelPct > 0.5f && obdFuelPct < 15.0f
              && !alertOverlayActive
              && (lastLocalLowFuelMs == 0
                  || millis() - lastLocalLowFuelMs > LOW_FUEL_RE_FIRE_MS)) {
            localLowFuelActive = true;
            lastLocalLowFuelMs = millis();
            char msg[64];
            snprintf(msg, sizeof(msg), "Low fuel: %d %% -- refuel below 15 %%",
                     (int)obdFuelPct);
            Serial.printf("[ALERT] local low_fuel: %s\n", msg);
            showAlertOverlay("low_fuel", String(msg));
          } else if (localLowFuelActive && obdFuelPct >= 18.0f) {
            localLowFuelActive = false;  // refuel -- re-arm
          }
        }
      }

      if (millis() - lastTelemetryPost > TELEMETRY_INTERVAL_MS) {
        sendTelemetry();
      }

      // Local arrival detection using embedded GPS vs destination coords
      if (navDestValid && gpsFix) {
        static bool localArrived = false;
        const double R = 6371000.0;
        double dLat = (navDestLat - gpsLat) * (M_PI / 180.0);
        double dLon = (navDestLon - gpsLon) * (M_PI / 180.0);
        double a    = sin(dLat/2)*sin(dLat/2)
                    + cos(gpsLat*(M_PI/180.0))*cos(navDestLat*(M_PI/180.0))
                    * sin(dLon/2)*sin(dLon/2);
        double distToDest = R * 2.0 * atan2(sqrt(a), sqrt(1.0-a));
        if (!localArrived && distToDest < 50.0) {
          localArrived = true;
          if (navState != "arrived") {
            navState = "arrived";
            refreshNavPanel();
            if (arrivalBeepArmed) { beepDone(); arrivalBeepArmed = false; }
            Serial.printf("[nav] local arrival detected dist=%.1fm\n", distToDest);
          }
        } else if (localArrived && distToDest > 120.0) {
          localArrived  = false;
          arrivalBeepArmed = true;
          if (navState == "arrived") {
            navState = "navigating";
            refreshNavPanel();
            Serial.printf("[nav] left arrival zone dist=%.1fm -- resuming nav\n", distToDest);
          }
        }
      }

      {
        const uint32_t alertInterval = wifiReady ? ALERT_POLL_WIFI_MS : 15000UL;
        if (millis() - lastAlertPoll > alertInterval) {
          lastAlertPoll = millis();
          if (activeTripId.isEmpty()) {
            Serial.println("[alerts] skip -- no active trip");
          } else if (!pendingTripStartBody.isEmpty()) {
            Serial.println("[alerts] skip -- trip/start not yet synced to backend");
          } else {
            HttpJob job = {}; job.type = HJ_ALERT; job.isPost = false;
            snprintf(job.path, sizeof(job.path), "/device/alerts/%s", activeTripId.c_str());
            job.body[0] = '\0';
            // Stuck-worker backstop -- see telemetry coalesce path for rationale.
            if (alertJobQueued && alertJobQueuedAt
                && millis() - alertJobQueuedAt > STUCK_JOB_MS) {
              Serial.printf("[alerts] WARN: job stuck >%lums -- releasing flag\n",
                            (unsigned long)STUCK_JOB_MS);
              alertJobQueued   = false;
              alertJobQueuedAt = 0;
            }
            if (!alertJobQueued && uxQueueMessagesWaiting(gHttpJobQ) < 10) {
              if (xQueueSendToFront(gHttpJobQ, &job, 0) == pdTRUE) {
                alertJobQueued   = true;
                alertJobQueuedAt = millis();
                Serial.printf("[alerts] poll queued for trip=%.8s (wifi=%d gsm=%d)\n",
                              activeTripId.c_str(), (int)wifiReady, (int)gsmReady);
              }
            } else if (alertJobQueued) {
              Serial.println("[alerts] poll coalesced -- previous poll still pending");
            } else {
              Serial.println("[alerts] poll dropped -- job queue full");
            }
          }
        }
      }

      if (!alertOverlayActive && digitalRead(BTN_TAKE_REST) == LOW) {
        delay(BTN_DEBOUNCE_MS);
        if (digitalRead(BTN_TAKE_REST) == LOW) {
          Serial.println("[BTN] Take Rest pressed (TRIP_ACTIVE)");
          localRestAlertPending = false;
          restAlertSnoozedUntil = 0;
          queueTripEvent(HJ_PAUSE, "/trip/pause", activeTripId);
          pauseStart = millis();
          state      = TRIP_PAUSED;
          screenTripPaused();
          beepAck();
        }
      }

      if (isTouched) {
        if (inBtn(sx, sy, TA_REST_X, TA_BTN_Y, TA_REST_W, TA_BTN_H)) {
          // REST BREAK -- immediate local state change, async HTTP
          Serial.println("[TRIP_ACTIVE] REST BREAK -> immediate local pause");
          localRestAlertPending  = false;
          restAlertSnoozedUntil  = 0;
          lastLocalActionMs      = millis();  // HMI priority window: block remote re-activate
          queueTripEvent(HJ_PAUSE, "/trip/pause", activeTripId);
          pauseStart = millis();
          state      = TRIP_PAUSED;
          screenTripPaused();
          beepAck();

        } else if (inBtn(sx, sy, TA_END_X, TA_BTN_Y, TA_END_W, TA_BTN_H)) {
          Serial.println("[TRIP_ACTIVE] END TRIP -> immediate local end");
          lastLocalActionMs = millis();
          unsigned long total = tripElapsedSec();
          if (!activeTripId.isEmpty()) {
            if (pendingSnoozeId == activeTripId) {
              pendingSnoozeId = "";
              nvsSavePendingSnooze("");
            }
            pendingEndTime   = getTimestamp();
            pendingEndTripId = activeTripId;
            nvsSavePendingEnd(pendingEndTripId);
            nvsSavePendingEndTime(pendingEndTime);
            locallyEndedTripId = activeTripId;
            nvsSaveLocallyEndedTripId(locallyEndedTripId);
            queueEndTrip(activeTripId, pendingEndTime);
          }
          activeTripId = "";
          activeTripStartIso = ""; activeTripPausedIso = ""; activeTripRestSeconds = 0; activeTripDrivingSeconds = -1; activeTripSinceRestSeconds = -1;
          activeTripNextRestAlertIso = "";
          nvsClearActiveTrip();
          state        = TRIP_ENDED;
          screenTripEnded(total);
          beepDone();
        }
      }
      break;

    // Trip paused
    case TRIP_PAUSED:
      refreshTimer();
      if (millis() - lastTelemetryPost > TELEMETRY_INTERVAL_MS) {
        sendTelemetry();
      }
      {
        const uint32_t alertInterval = wifiReady ? ALERT_POLL_WIFI_MS : 15000UL;
        if (millis() - lastAlertPoll > alertInterval) {
          lastAlertPoll = millis();
          if (activeTripId.isEmpty()) {
            Serial.println("[alerts] skip -- no active trip");
          } else if (!pendingTripStartBody.isEmpty()) {
            Serial.println("[alerts] skip -- trip/start not yet synced to backend");
          } else {
            HttpJob job = {}; job.type = HJ_ALERT; job.isPost = false;
            snprintf(job.path, sizeof(job.path), "/device/alerts/%s", activeTripId.c_str());
            job.body[0] = '\0';
            // Stuck-worker backstop -- see telemetry coalesce path for rationale.
            if (alertJobQueued && alertJobQueuedAt
                && millis() - alertJobQueuedAt > STUCK_JOB_MS) {
              Serial.printf("[alerts] WARN: job stuck >%lums -- releasing flag\n",
                            (unsigned long)STUCK_JOB_MS);
              alertJobQueued   = false;
              alertJobQueuedAt = 0;
            }
            if (!alertJobQueued && uxQueueMessagesWaiting(gHttpJobQ) < 10) {
              if (xQueueSendToFront(gHttpJobQ, &job, 0) == pdTRUE) {
                alertJobQueued   = true;
                alertJobQueuedAt = millis();
                Serial.printf("[alerts] poll queued for trip=%.8s (wifi=%d gsm=%d)\n",
                              activeTripId.c_str(), (int)wifiReady, (int)gsmReady);
              }
            } else if (alertJobQueued) {
              Serial.println("[alerts] poll coalesced -- previous poll still pending");
            } else {
              Serial.println("[alerts] poll dropped -- job queue full");
            }
          }
        }
      }

      if (isTouched) {
        if (inBtn(sx, sy, TA_REST_X, TA_BTN_Y, TA_REST_W, TA_BTN_H)) {
          // RESUME -- immediate local state change, async HTTP
          Serial.println("[TRIP_PAUSED] RESUME -> immediate local resume");
          lastLocalActionMs = millis();  // HMI priority window: block remote re-pause
          queueTripEvent(HJ_RESUME, "/trip/resume", activeTripId);
          pausedTotal += millis() - pauseStart;
          lastRestMs   = millis();
          state        = TRIP_ACTIVE;
          screenTripActive();
          beepAck();

        } else if (inBtn(sx, sy, TA_END_X, TA_BTN_Y, TA_END_W, TA_BTN_H)) {
          Serial.println("[TRIP_PAUSED] END TRIP -> immediate local end");
          lastLocalActionMs = millis();
          pausedTotal += millis() - pauseStart;
          unsigned long total = tripElapsedSec();
          if (!activeTripId.isEmpty()) {
            if (pendingSnoozeId == activeTripId) {
              pendingSnoozeId = "";
              nvsSavePendingSnooze("");
            }
            pendingEndTime   = getTimestamp();
            pendingEndTripId = activeTripId;
            nvsSavePendingEnd(pendingEndTripId);
            nvsSavePendingEndTime(pendingEndTime);
            locallyEndedTripId = activeTripId;
            nvsSaveLocallyEndedTripId(locallyEndedTripId);
            queueEndTrip(activeTripId, pendingEndTime);
          }
          activeTripId = "";
          activeTripStartIso = ""; activeTripPausedIso = ""; activeTripRestSeconds = 0; activeTripDrivingSeconds = -1; activeTripSinceRestSeconds = -1;
          activeTripNextRestAlertIso = "";
          nvsClearActiveTrip();
          state        = TRIP_ENDED;
          screenTripEnded(total);
          beepDone();
        }
      }
      break;

    // Trip ended
    case TRIP_ENDED:
      if (isTouched) {
        if (inBtn(sx, sy, TE_NEW_X, TE_NEW_Y, TE_NEW_W, TE_NEW_H)) {
          goToTruckSelect();
        } else if (inBtn(sx, sy, TE_LGOUT_X, TE_LGOUT_Y, TE_LGOUT_W, TE_LGOUT_H)) {
          doLogout();
        }
      }
      break;

    default: break;
  }
}
