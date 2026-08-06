#include <Arduino.h>
#include <SPI.h>
#include <SPIFFS.h>
#include <TinyGPSPlus.h>
#include <mcp2515.h>

// PIN ASSIGNMENTS -- SAME AS embedded/hmi_phase1/src/main.cpp
// MCP2515 CAN transceiver on HSPI
#define CAN_CS_PIN      14
#define CAN_INT_PIN     35
#define CAN_HSPI_SCK    12
#define CAN_HSPI_MISO    2
#define CAN_HSPI_MOSI   15

#define GPS_RX_PIN      16
#define GPS_TX_PIN      17
#define GPS_BAUD      9600

// SAMPLE CADENCE
#define SAMPLE_INTERVAL_MS 5000UL
#define OBD_TIMEOUT_MS       50

#define MA_WINDOW 5
static float ma_buf[MA_WINDOW];
static uint8_t ma_count = 0;
static uint8_t ma_head  = 0;

static float moving_average_push(float sample) {
    ma_buf[ma_head] = sample;
    ma_head = (ma_head + 1) % MA_WINDOW;
    if (ma_count < MA_WINDOW) ma_count++;
    float sum = 0.0f;
    for (uint8_t i = 0; i < ma_count; i++) sum += ma_buf[i];
    return sum / ma_count;
}

// Constants match KalmanFuelFilter defaults exactly.
static const float KF_R              = 0.25f;
static const float KF_Q_IDLE         = 0.001f;   // process noise while stationary
static const float KF_Q_MOVING       = 0.01f;    // process noise while driving
static const float KF_Q_BURST        = 5.0f;     // process noise on abrupt change
static const float KF_BURST_DELTA    = 1.0f;     // |z - x_pred| triggering burst mode
static const float KF_INITIAL_P      = 4.0f;

static float kf_x = 0.0f;
static float kf_P = KF_INITIAL_P;
static bool  kf_initialised = false;

// Mirrors _expected_burn_pct_per_min in fuel_kalman.py: base 0.03 %/min
static float expected_burn_pct_per_min(float speed_kmph, float load_pct) {
    if (speed_kmph < 5.0f) return 0.03f;
    if (load_pct < 0.0f)   load_pct = 0.0f;
    if (load_pct > 100.0f) load_pct = 100.0f;
    return 0.03f + (load_pct / 100.0f) * 0.15f;
}

static float kalman_step(float raw, float speed_kmph, float load_pct,
                         float dt_sec) {
    if (!kf_initialised) {
        kf_x = raw;
        kf_P = KF_INITIAL_P;
        kf_initialised = true;
        return kf_x;
    }
    const float u      = expected_burn_pct_per_min(speed_kmph, load_pct)
                         * (dt_sec / 60.0f);
    const float x_pred = kf_x - u;

    float q = (speed_kmph < 5.0f) ? KF_Q_IDLE : KF_Q_MOVING;
    if (fabsf(raw - x_pred) >= KF_BURST_DELTA) q = KF_Q_BURST;

    const float P_pred = kf_P + q;
    const float K      = P_pred / (P_pred + KF_R);
    kf_x = x_pred + K * (raw - x_pred);
    kf_P = (1.0f - K) * P_pred;
    return kf_x;
}

// CAN + OBD state
SPIClass hspi(HSPI);
MCP2515 mcp2515can(CAN_CS_PIN, 10000000, &hspi);

// Standard Mode 01 PIDs (primary universal path).
static const uint8_t PID_FUEL_LEVEL  = 0x2F;
static const uint8_t PID_ENGINE_LOAD = 0x04;
static const uint8_t PID_SPEED       = 0x0D;
static const uint8_t PID_RPM         = 0x0C;

// Mode 22 DID fallback table -- mirrors FUEL_DIDS[] in the deployed HMI.
static const uint16_t FUEL_DIDS[]     = { 0x1F2F, 0x0D0F, 0x2F08, 0x4C38,
                                          0x2F09, 0xF42F, 0xF45E, 0x110A, 0x1103 };
static const bool     FUEL_DID_BCM[]  = {   true,  false,  false,  false,
                                            false,  false,  false,  false, false };
static const uint8_t  FUEL_DID_COUNT  = sizeof(FUEL_DIDS) / sizeof(FUEL_DIDS[0]);

static bool obdRequestMode01(uint8_t pid, uint8_t* out, uint8_t& n,
                             uint32_t timeout_ms = OBD_TIMEOUT_MS) {
    can_frame req = {};
    req.can_id  = 0x7DF;
    req.can_dlc = 8;
    req.data[0] = 0x02;
    req.data[1] = 0x01;
    req.data[2] = pid;
    for (int i = 3; i < 8; i++) req.data[i] = 0x55;
    if (mcp2515can.sendMessage(&req) != MCP2515::ERROR_OK) return false;

    unsigned long t0 = millis();
    while (millis() - t0 < timeout_ms) {
        can_frame resp = {};
        if (mcp2515can.readMessage(MCP2515::RXB0, &resp) != MCP2515::ERROR_OK) {
            vTaskDelay(1); continue;
        }
        if (resp.can_id < 0x7E8 || resp.can_id > 0x7EF) continue;
        if (resp.data[1] != 0x41 || resp.data[2] != pid) continue;
        n = (resp.data[0] > 2) ? (resp.data[0] - 2) : 0;
        if (n > 5) n = 5;
        for (uint8_t i = 0; i < n; i++) out[i] = resp.data[3 + i];
        return true;
    }
    return false;
}

static bool obdRequestMode22BCM(uint16_t did, uint8_t* out, uint8_t& n,
                                uint32_t timeout_ms = 600) {
    can_frame req = {};
    req.can_id  = 0x700;   // Toyota BCM physical address, matches deployed HMI
    req.can_dlc = 8;
    req.data[0] = 0x03;
    req.data[1] = 0x22;
    req.data[2] = (did >> 8) & 0xFF;
    req.data[3] =  did       & 0xFF;
    for (int i = 4; i < 8; i++) req.data[i] = 0x55;
    if (mcp2515can.sendMessage(&req) != MCP2515::ERROR_OK) return false;

    unsigned long t0 = millis();
    while (millis() - t0 < timeout_ms) {
        can_frame resp = {};
        if (mcp2515can.readMessage(MCP2515::RXB1, &resp) != MCP2515::ERROR_OK) {
            vTaskDelay(1); continue;
        }
        if (resp.can_id != 0x708 || resp.can_dlc < 4) continue;
        uint16_t rDid = ((uint16_t)resp.data[2] << 8) | resp.data[3];
        if (resp.data[1] != 0x62 || rDid != did) continue;
        n = (resp.data[0] > 3) ? (resp.data[0] - 3) : 0;
        if (n > 4) n = 4;
        for (uint8_t i = 0; i < n; i++) out[i] = resp.data[4 + i];
        return true;
    }
    return false;
}

static bool obdRequestToyotaMeter(uint8_t service, uint16_t identifier,
                                  uint8_t* out, uint8_t& n,
                                  uint32_t timeout_ms = 600) {
    const bool twoByteId = (service == 0x22);
    can_frame req = {};
    req.can_id  = 0x7C0;
    req.can_dlc = 8;
    req.data[0] = twoByteId ? 0x03 : 0x02;
    req.data[1] = service;
    if (twoByteId) {
        req.data[2] = (identifier >> 8) & 0xFF;
        req.data[3] =  identifier       & 0xFF;
        for (int i = 4; i < 8; i++) req.data[i] = 0x55;
    } else {
        req.data[2] = identifier & 0xFF;
        for (int i = 3; i < 8; i++) req.data[i] = 0x55;
    }
    if (mcp2515can.sendMessage(&req) != MCP2515::ERROR_OK) return false;

    const uint8_t positiveService = service + 0x40;
    unsigned long t0 = millis();
    while (millis() - t0 < timeout_ms) {
        can_frame resp = {};
        if (mcp2515can.readMessage(MCP2515::RXB1, &resp) != MCP2515::ERROR_OK) {
            vTaskDelay(1); continue;
        }
        if (resp.can_id != 0x7C8 || resp.can_dlc < (twoByteId ? 5 : 4)) continue;
        if (resp.data[1] == 0x7F) return false;
        if (resp.data[1] != positiveService) continue;
        if (twoByteId) {
            uint16_t rDid = ((uint16_t)resp.data[2] << 8) | resp.data[3];
            if (rDid != identifier) continue;
            n = (resp.data[0] > 3) ? (resp.data[0] - 3) : 0;
            if (n > 4) n = 4;
            for (uint8_t i = 0; i < n; i++) out[i] = resp.data[4 + i];
        } else {
            if (resp.data[2] != (identifier & 0xFF)) continue;
            n = (resp.data[0] > 2) ? (resp.data[0] - 2) : 0;
            if (n > 4) n = 4;
            for (uint8_t i = 0; i < n; i++) out[i] = resp.data[3 + i];
        }
        return n > 0;
    }
    return false;
}

// Mode 22 request over the standard OBD-II functional broadcast (0x7DF).
static bool obdRequestMode22Broadcast(uint16_t did, uint8_t* out, uint8_t& n,
                                      uint32_t timeout_ms = 300) {
    can_frame req = {};
    req.can_id  = 0x7DF;
    req.can_dlc = 8;
    req.data[0] = 0x03;
    req.data[1] = 0x22;
    req.data[2] = (did >> 8) & 0xFF;
    req.data[3] =  did       & 0xFF;
    for (int i = 4; i < 8; i++) req.data[i] = 0x55;
    if (mcp2515can.sendMessage(&req) != MCP2515::ERROR_OK) return false;

    unsigned long t0 = millis();
    while (millis() - t0 < timeout_ms) {
        can_frame resp = {};
        if (mcp2515can.readMessage(MCP2515::RXB0, &resp) != MCP2515::ERROR_OK) {
            vTaskDelay(1); continue;
        }
        if (resp.can_id < 0x7E8 || resp.can_id > 0x7EF) continue;
        if (resp.data[1] == 0x7F) return false;  // negative response
        uint16_t rDid = ((uint16_t)resp.data[2] << 8) | resp.data[3];
        if (resp.data[1] != 0x62 || rDid != did) continue;
        n = (resp.data[0] > 3) ? (resp.data[0] - 3) : 0;
        if (n > 4) n = 4;
        for (uint8_t i = 0; i < n; i++) out[i] = resp.data[4 + i];
        return true;
    }
    return false;
}

// Toyota Fortuner tank capacity -- matches the deployed HMI and the
static const float TOYOTA_TANK_L = 80.0f;

static uint8_t activeToyotaCmd    = 0;
static int8_t  activeGenericDid   = -3;

static float readFuelPercent() {
    uint8_t buf[5]; uint8_t len = 0;

    if (activeToyotaCmd == 0) {
        if (obdRequestToyotaMeter(0x21, 0x29, buf, len) && len >= 1) {
            activeToyotaCmd = 1;
            Serial.println("[fuel] Toyota Mode 21/29 responded");
        } else if (obdRequestToyotaMeter(0x22, 0x1022, buf, len) && len >= 2) {
            activeToyotaCmd = 2;
            Serial.println("[fuel] Toyota Mode 22/1022 responded");
        }
    }
    if (activeToyotaCmd == 1) {
        if (obdRequestToyotaMeter(0x21, 0x29, buf, len) && len >= 1) {
            const float liters = buf[0] * 0.5f;
            return (liters / TOYOTA_TANK_L) * 100.0f;
        }
        activeToyotaCmd = 0;   // fall through to re-probe
    } else if (activeToyotaCmd == 2) {
        if (obdRequestToyotaMeter(0x22, 0x1022, buf, len) && len >= 2) {
            const float liters = (((uint16_t)buf[0] << 8) | buf[1]) / 100.0f;
            return (liters / TOYOTA_TANK_L) * 100.0f;
        }
        activeToyotaCmd = 0;
    }

    // Path B: Universal Mode 01 PID 0x2F
    if (activeGenericDid == -3 || activeGenericDid == -2) {
        if (obdRequestMode01(PID_FUEL_LEVEL, buf, len) && len >= 1) {
            activeGenericDid = -2;
            return (float)buf[0] * 100.0f / 255.0f;
        }
    }

    // Path C: Generic Mode 22 DID table
    if (activeGenericDid >= 0) {
        const uint16_t did = FUEL_DIDS[activeGenericDid];
        const bool   isBcm = FUEL_DID_BCM[activeGenericDid];
        if ((isBcm ? obdRequestMode22BCM(did, buf, len)
                   : obdRequestMode22Broadcast(did, buf, len)) && len >= 1) {
            return (float)buf[0] * 100.0f / 255.0f;
        }
        activeGenericDid = -3;
    }
    for (uint8_t i = 0; i < FUEL_DID_COUNT; i++) {
        const uint16_t did = FUEL_DIDS[i];
        const bool   isBcm = FUEL_DID_BCM[i];
        if ((isBcm ? obdRequestMode22BCM(did, buf, len)
                   : obdRequestMode22Broadcast(did, buf, len)) && len >= 1) {
            activeGenericDid = i;
            Serial.printf("[fuel] Generic Mode 22 DID 0x%04X responded (%s)\n",
                          did, isBcm ? "BCM" : "broadcast");
            return (float)buf[0] * 100.0f / 255.0f;
        }
    }
    return NAN;
}

static float readSpeedKmph() {
    uint8_t buf[5]; uint8_t len = 0;
    if (obdRequestMode01(PID_SPEED, buf, len) && len >= 1)
        return (float)buf[0];
    return NAN;
}

static float readEngineLoadPct() {
    uint8_t buf[5]; uint8_t len = 0;
    if (obdRequestMode01(PID_ENGINE_LOAD, buf, len) && len >= 1)
        return (float)buf[0] * 100.0f / 255.0f;
    return NAN;
}

static float readEngineRpm() {
    uint8_t buf[5]; uint8_t len = 0;
    if (obdRequestMode01(PID_RPM, buf, len) && len >= 2)
        return ((buf[0] * 256.0f) + buf[1]) / 4.0f;
    return NAN;
}

// GPS
TinyGPSPlus gps;
HardwareSerial gpsSerial(2);

static void pumpGps() {
    while (gpsSerial.available()) gps.encode(gpsSerial.read());
}

// SPIFFS logging
static String     activeLogPath;
static File       activeLog;
static bool       loggingEnabled = true;
static char       pendingTag[32] = {0};

static String makeLogFilename() {
    // If GPS has time, use it; otherwise use a boot-counter fallback.
    if (gps.time.isValid() && gps.date.isValid()) {
        char buf[40];
        snprintf(buf, sizeof(buf), "/field_%04u%02u%02u_%02u%02u%02u.csv",
                 gps.date.year(), gps.date.month(), gps.date.day(),
                 gps.time.hour(), gps.time.minute(), gps.time.second());
        return String(buf);
    }
    static int boot_seq = 0;
    char buf[40];
    snprintf(buf, sizeof(buf), "/field_boot_%03d.csv", boot_seq++);
    return String(buf);
}

static void openLog() {
    activeLogPath = makeLogFilename();
    activeLog = SPIFFS.open(activeLogPath, FILE_WRITE);
    if (!activeLog) {
        Serial.printf("[log] ERROR opening %s\n", activeLogPath.c_str());
        return;
    }
    activeLog.println(
        "timestamp_ms,raw_fuel_pct,fuel_ma,fuel_kf,"
        "speed_kmph,engine_load_pct,engine_rpm,engine_status,"
        "gps_lat,gps_lon,scenario_tag");
    activeLog.flush();
    Serial.printf("[log] opened %s\n", activeLogPath.c_str());
}

static void closeLog() {
    if (activeLog) {
        activeLog.close();
        Serial.printf("[log] closed %s\n", activeLogPath.c_str());
    }
}

static void listLogs() {
    File root = SPIFFS.open("/");
    if (!root) { Serial.println("[log] SPIFFS root open failed"); return; }
    File f = root.openNextFile();
    while (f) {
        if (!f.isDirectory()) {
            Serial.printf("  %-32s  %8u bytes\n", f.name(), (unsigned)f.size());
        }
        f = root.openNextFile();
    }
}

static void dumpActiveLog() {
    File f = SPIFFS.open(activeLogPath, FILE_READ);
    if (!f) { Serial.println("[log] no active log to dump"); return; }
    Serial.printf("---BEGIN %s---\n", activeLogPath.c_str());
    while (f.available()) Serial.write(f.read());
    Serial.printf("---END %s---\n", activeLogPath.c_str());
    f.close();
}

// Serial console
static void pollSerial() {
    if (!Serial.available()) return;
    String line = Serial.readStringUntil('\n');
    line.trim();
    if (line.length() == 0) return;
    char cmd = line[0];
    switch (cmd) {
        case 't':
            snprintf(pendingTag, sizeof(pendingTag), "%s",
                     line.substring(1).c_str());
            Serial.printf("[tag] '%s' will be written to next sample\n",
                          pendingTag);
            break;
        case 'd': dumpActiveLog(); break;
        case 'l': listLogs();      break;
        case 'n':
            closeLog();
            openLog();
            break;
        case 'q':
            loggingEnabled = false;
            closeLog();
            Serial.println("[log] logging stopped");
            break;
        default:
            Serial.println("[cmd] t<tag>, d(ump), l(ist), n(ew), q(uit)");
    }
}

void setup() {
    Serial.begin(115200);
    delay(500);
    Serial.println("[boot] filter_field_test firmware starting");

    hspi.begin(CAN_HSPI_SCK, CAN_HSPI_MISO, CAN_HSPI_MOSI, CAN_CS_PIN);
    pinMode(CAN_CS_PIN, OUTPUT);
    digitalWrite(CAN_CS_PIN, HIGH);

    mcp2515can.reset();
    mcp2515can.setBitrate(CAN_500KBPS, MCP_8MHZ);

    // RX filters -- mirror the deployed HMI so the Fortuner's heavy
    mcp2515can.setFilterMask(MCP2515::MASK0, false, 0x7F8);
    mcp2515can.setFilter(MCP2515::RXF0, false, 0x7E8);
    mcp2515can.setFilter(MCP2515::RXF1, false, 0x7E8);
    mcp2515can.setFilterMask(MCP2515::MASK1, false, 0x7FF);
    mcp2515can.setFilter(MCP2515::RXF2, false, 0x640);
    mcp2515can.setFilter(MCP2515::RXF3, false, 0x3F9);
    mcp2515can.setFilter(MCP2515::RXF4, false, 0x708);
    mcp2515can.setFilter(MCP2515::RXF5, false, 0x7C8);

    mcp2515can.setNormalMode();
    Serial.println("[can] MCP2515 initialised with OBD/BCM filters");

    gpsSerial.begin(GPS_BAUD, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);
    Serial.println("[gps] Serial1 up");

    if (!SPIFFS.begin(true)) {
        Serial.println("[fs] SPIFFS mount failed");
    } else {
        Serial.println("[fs] SPIFFS mounted");
        openLog();
    }

    Serial.println();
    Serial.println("Commands (send over serial, then <enter>):");
    Serial.println("  t<tag>   tag the next sample (e.g. thighway, tidle, trefuel)");
    Serial.println("  d        dump the active CSV log to serial");
    Serial.println("  l        list SPIFFS files");
    Serial.println("  n        close the active log and open a new one");
    Serial.println("  q        stop logging");
    Serial.println();
}

void loop() {
    static unsigned long next_sample = 0;
    static unsigned long last_sample_ms = 0;

    pumpGps();
    pollSerial();

    unsigned long now = millis();
    if (!loggingEnabled || now < next_sample) return;
    next_sample = now + SAMPLE_INTERVAL_MS;

    const float raw   = readFuelPercent();
    const float speed = readSpeedKmph();
    const float load  = readEngineLoadPct();
    const float rpm   = readEngineRpm();

    // Filter both streams
    float ma = NAN, kf = NAN;
    if (!isnan(raw)) {
        ma = moving_average_push(raw);
        const float dt_sec = last_sample_ms
            ? (now - last_sample_ms) / 1000.0f
            : (SAMPLE_INTERVAL_MS / 1000.0f);
        kf = kalman_step(raw,
                         isnan(speed) ? 0.0f  : speed,
                         isnan(load)  ? 30.0f : load,
                         dt_sec);
    }
    last_sample_ms = now;

    const char* engine_status =
        (isnan(rpm) || rpm < 100) ? "off" :
        (rpm < 900)               ? "idle" : "on";
    const double lat = gps.location.isValid() ? gps.location.lat() : NAN;
    const double lon = gps.location.isValid() ? gps.location.lng() : NAN;

    if (activeLog) {
        activeLog.printf("%lu,%.2f,%.2f,%.2f,%.1f,%.1f,%.0f,%s,%.6f,%.6f,%s\n",
                         now,
                         isnan(raw)   ? -1.0f : raw,
                         isnan(ma)    ? -1.0f : ma,
                         isnan(kf)    ? -1.0f : kf,
                         isnan(speed) ? -1.0f : speed,
                         isnan(load)  ? -1.0f : load,
                         isnan(rpm)   ? -1.0f : rpm,
                         engine_status,
                         isnan(lat)   ?  0.0  : lat,
                         isnan(lon)   ?  0.0  : lon,
                         pendingTag);
        activeLog.flush();
    }

    Serial.printf(
        "t=%8lu ms  raw=%5.1f  MA=%5.1f  KF=%5.1f  "
        "spd=%4.0f  load=%4.0f  rpm=%5.0f  %-4s  %s\n",
        now,
        isnan(raw)   ? 0.0f : raw,
        isnan(ma)    ? 0.0f : ma,
        isnan(kf)    ? 0.0f : kf,
        isnan(speed) ? 0.0f : speed,
        isnan(load)  ? 0.0f : load,
        isnan(rpm)   ? 0.0f : rpm,
        engine_status,
        pendingTag);

    pendingTag[0] = '\0';
}
