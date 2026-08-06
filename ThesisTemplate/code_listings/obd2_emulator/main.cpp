#include <Arduino.h>
#include <SPI.h>
#include <WiFi.h>
#include <WebServer.h>
#include <ArduinoJson.h>
#include <mcp2515.h>
#include <math.h>
#include <esp_system.h>
#include <Preferences.h>
#include <ESPmDNS.h>

//  Compile-time features
static constexpr bool USE_NMEA_GPS_OUTPUT = true;   // set false to disable NMEA TX

#define CAN_CS      14
#define CAN_INT     35
#define CAN_SCK     12
#define CAN_MISO     2
#define CAN_MOSI    15

//  NMEA UART
#define NMEA_TX_PIN 17
#define NMEA_RX_PIN 16
#define NMEA_BAUD   9600

//  WiFi
static constexpr const char* WIFI_DEFAULT_SSID = "GFiber_2.4_Coverage_A0237";
static constexpr const char* WIFI_DEFAULT_PSK  = "57A07F5D";
static constexpr const char* MDNS_HOSTNAME     = "obd2emu";   // -> http://obd2emu.local/

static const char* AP_SSID = "OBD2_EMULATOR";
static const char* AP_PSK  = "obd2demo";

static Preferences prefs;
static String wifiActiveMode  = "off";      // "sta" | "ap" | "off"
static String wifiActiveSsid  = "";
static String wifiActiveIp    = "";
static bool   mdnsActive      = false;

struct Tunables {
  // NORMAL_TRIP
  float trip_target_kph        = 55.0f;   // cruise target
  float trip_accel_kph_per_s   =  0.7f;   // ramp up rate
  // TRAFFIC / IDLE
  float traffic_max_kph        = 10.0f;
  float traffic_min_kph        =  0.0f;
  float traffic_swing_period_s = 20.0f;
  float sudden_drop_pct        = 12.0f;   // % that vanishes on trigger
  // GRADUAL_LEAK
  float leak_rate_pct_per_min  =  0.8f;   // abnormally fast slow leak
  // RAPID_ABNORMAL_DROP
  float rapid_rate_pct_per_min =  4.0f;
  // REFUEL
  float refuel_target_pct      = 90.0f;
  uint32_t refuel_quiet_ms     = 8000;    // vehicle must be idle this long
  uint32_t refuel_fill_ms      = 6000;    // then fills over this window
  // Realistic burn
  float idle_burn_pct_per_min  =  0.05f;  // engine on & stopped
  float drive_burn_pct_per_min =  0.30f;  // engine on & moving
  float slosh_pct_amp          =  0.4f;   // 0 disables
  float slosh_period_s         =  3.0f;
  // OVERSPEED
  float overspeed_kph          = 95.0f;
  // REST_ALERT
  uint32_t rest_alert_runtime_boost_s = 4 * 3600; // jump runtime by 4h
};

static Tunables TUN;

//  Vehicle profiles
struct VehicleProfile {
  const char* name;
  int   fuel_mode;             // FMODE_* -- which CAN path answers fuel
  float tank_capacity_l;
  float idle_rpm;
  float coolant_target_c;
  float speed_rpm_gain;        // extra RPM per kph above idle
  float drive_burn_pct_per_min;
  float idle_burn_pct_per_min;
  const char* vin;
};

static const VehicleProfile PROFILES[] = {
  { "Toyota Fortuner (diesel, meter)",    2,  80.0f, 750.0f, 88.0f, 30.0f, 0.30f, 0.05f, "MHFYX8CD500123456" },
  { "Toyota Hilux (diesel, meter)",       2,  80.0f, 750.0f, 88.0f, 28.0f, 0.32f, 0.05f, "MR0FR22G7L0555777" },
  { "Toyota Fortuner 2018+ (BCM)",        3, 80.0f, 750.0f, 88.0f, 30.0f, 0.30f, 0.05f, "MHFYX8CE900654321" },
  { "Hino 300 light truck (Mode01 fuel)", 1, 100.0f, 700.0f, 85.0f, 20.0f, 0.55f, 0.08f, "JHDFC9JN7HK011223" },
  { "Generic sedan (gasoline)",           1, 55.0f, 800.0f, 92.0f, 35.0f, 0.20f, 0.04f, "1G1JC5241X7123456" },
  { "Custom (sliders only)",              0,     80.0f, 750.0f, 88.0f, 30.0f, 0.30f, 0.05f, "TEST0000000000000" },
};
static const size_t N_PROFILES = sizeof(PROFILES) / sizeof(PROFILES[0]);

//  Ignition state machine
enum Ignition {
  IGN_OFF     = 0,
  IGN_CRANK   = 1,   // ~800 ms while starter engaged
  IGN_WARMUP  = 2,   // cold-start elevated idle; blends into RUN over ~60 s
  IGN_RUN     = 3,   // normal operation
};

struct DtcPreset {
  const char* code;   // "P0300"
  uint16_t    raw;
  const char* label;
};
// SAE J2012 DTC encoding:
static const DtcPreset DTC_PRESETS[] = {
  { "P0171", 0x0171, "System too lean (bank 1)" },
  { "P0300", 0x0300, "Random / multiple cylinder misfire" },
  { "P0420", 0x0420, "Catalyst efficiency below threshold" },
  { "P0128", 0x0128, "Coolant thermostat malfunction" },
  { "P0455", 0x0455, "EVAP large leak" },
  { "U0100", 0xC100, "Lost comm with ECM/PCM" },
};
static const size_t N_DTC_PRESETS = sizeof(DTC_PRESETS) / sizeof(DTC_PRESETS[0]);

//  GPS route waypoints
struct Waypoint { double lat; double lng; float target_kph; };

// Route 1: SGSA (Paranaque) -> SLEX -> Batangas -- 8 rough waypoints
static const Waypoint ROUTE_SGSA_BATANGAS[] = {
  { 14.4793, 121.0198,  30.0f },  // SGSA gate
  { 14.4550, 121.0350,  60.0f },  // SLEX Bicutan on-ramp
  { 14.3800, 121.0500,  90.0f },  // SLEX Sucat / Alabang stretch
  { 14.2500, 121.0800,  90.0f },  // Santa Rosa
  { 14.1300, 121.1200,  85.0f },  // Calamba
  { 14.0400, 121.1400,  80.0f },  // Batangas approach
  { 13.9500, 121.1600,  60.0f },  // Batangas City limits
  { 13.7565, 121.0583,  30.0f },  // Batangas Port
};
// Route 2: Metro Manila short loop -- 6 waypoints
static const Waypoint ROUTE_MANILA_LOOP[] = {
  { 14.5547, 121.0244,  30.0f },  // Makati CBD
  { 14.5764, 121.0851,  40.0f },  // Ortigas
  { 14.6510, 121.0490,  50.0f },  // Quezon City
  { 14.6010, 120.9840,  40.0f },  // Manila
  { 14.5340, 120.9800,  35.0f },  // Pasay
  { 14.5547, 121.0244,  30.0f },  // back to Makati
};

enum RouteId { ROUTE_NONE = 0, ROUTE_SGSA = 1, ROUTE_LOOP = 2 };

static const Waypoint* routePoints(int id, size_t& outN) {
  switch (id) {
    case ROUTE_SGSA: outN = sizeof(ROUTE_SGSA_BATANGAS) / sizeof(Waypoint); return ROUTE_SGSA_BATANGAS;
    case ROUTE_LOOP: outN = sizeof(ROUTE_MANILA_LOOP)   / sizeof(Waypoint); return ROUTE_MANILA_LOOP;
    default:         outN = 0;                                              return nullptr;
  }
}

static const char* routeName(int id) {
  switch (id) {
    case ROUTE_NONE: return "straight_line";
    case ROUTE_SGSA: return "sgsa_to_batangas";
    case ROUTE_LOOP: return "manila_loop";
  }
  return "?";
}

//  Live emulator state
struct EmuState {
  // OBD2 values
  float    speed_kph        = 0.0f;
  float    rpm              = 0.0f;
  float    engine_load_pct  = 0.0f;
  float    throttle_pct     = 0.0f;
  float    fuel_level_pct   = 25.0f;   // safe default: parked, low tank
  float    coolant_temp_c   = 55.0f;
  float    maf_gps          = 2.0f;
  uint32_t runtime_sec      = 0;
  bool     engine_on        = false;
  bool     mil_on           = false;
  uint8_t  dtc_count        = 0;
  // Fuel model uses litres internally; percent is derived
  float    tank_capacity_l  = 80.0f;   // Fortuner default
  // GPS
  double   gps_lat          = 14.4793;
  double   gps_lng          = 121.0198;
  float    gps_course_deg   = 135.0f;    // SE -- toward Batangas
  bool     gps_fix          = true;
  // Meta
  int      scenario         = 0;
  uint32_t last_scenario_ms = 0;
  int      fuel_mode        = 2;

  int      vehicle_profile  = 0;
  float    idle_rpm         = 750.0f;
  float    coolant_target_c = 88.0f;
  float    speed_rpm_gain   = 30.0f;
  float    drive_burn_pct_per_min = 0.30f;
  float    idle_burn_pct_per_min  = 0.05f;

  uint8_t  ignition_state   = IGN_OFF;
  uint32_t ignition_since_ms = 0;
  float    ambient_temp_c   = 30.0f;      // room temperature at boot
  bool     cold_start_enabled = true;

  // Realism switches -- #3 jitter, #5 slosh
  bool     jitter_enabled   = true;
  float    jitter_intensity = 1.0f;       // 0..2 multiplier on default amplitude
  bool     slosh_enabled    = true;

  uint16_t dtc_codes[6]     = {0, 0, 0, 0, 0, 0};

  // #8 driver style / terrain
  int      driver_style     = 1;
  float    terrain_grade_pct = 0.0f;

  // #9 predefined route
  int      route_id         = ROUTE_NONE;
  int      route_wp_idx     = 0;
};

enum FuelMode {
  FMODE_BOTH       = 0,
  FMODE_UNIVERSAL  = 1,
  FMODE_TOYOTA     = 2,
  FMODE_TOYOTA_BCM = 3,
};

static const char* fuelModeName(int m) {
  switch (m) {
    case FMODE_BOTH:       return "both";
    case FMODE_UNIVERSAL:  return "universal_mode01";
    case FMODE_TOYOTA:     return "toyota_meter_21_29";
    case FMODE_TOYOTA_BCM: return "toyota_bcm_1F2F";
  }
  return "?";
}

static const char* ignitionName(uint8_t s) {
  switch (s) {
    case IGN_OFF:    return "off";
    case IGN_CRANK:  return "crank";
    case IGN_WARMUP: return "warmup";
    case IGN_RUN:    return "run";
  }
  return "?";
}

static const char* driverStyleName(int s) {
  switch (s) {
    case 0: return "eco";
    case 1: return "normal";
    case 2: return "aggressive";
  }
  return "?";
}

static float driverBurnMultiplier(int s) {
  return s == 0 ? 0.7f : (s == 2 ? 1.4f : 1.0f);
}
static float driverRpmOffset(int s) {
  return s == 0 ? -60.0f : (s == 2 ? 220.0f : 0.0f);
}
static float driverLoadOffset(int s) {
  return s == 0 ? -6.0f : (s == 2 ? 14.0f : 0.0f);
}

static EmuState ST;

enum Scenario {
  SCN_SAFE_IDLE       = 0,   // engine off, fuel 25%, speed 0
  SCN_NORMAL_TRIP     = 1,
  SCN_TRAFFIC_IDLE    = 2,
  SCN_SUDDEN_DROP     = 3,
  SCN_GRADUAL_LEAK    = 4,
  SCN_RAPID_ABNORMAL  = 5,
  SCN_REFUEL          = 6,
  SCN_REST_ALERT      = 7,
  SCN_OVERSPEED       = 8,
  SCN_MANUAL          = 9,   // sliders drive everything, no auto motion
};

static const char* scenarioName(int s) {
  switch (s) {
    case SCN_SAFE_IDLE:      return "safe_idle";
    case SCN_NORMAL_TRIP:    return "normal_trip";
    case SCN_TRAFFIC_IDLE:   return "traffic_idle";
    case SCN_SUDDEN_DROP:    return "sudden_drop";
    case SCN_GRADUAL_LEAK:   return "gradual_leak";
    case SCN_RAPID_ABNORMAL: return "rapid_abnormal";
    case SCN_REFUEL:         return "refuel";
    case SCN_REST_ALERT:     return "rest_alert";
    case SCN_OVERSPEED:      return "overspeed";
    case SCN_MANUAL:         return "manual";
  }
  return "?";
}

//  CAN globals
static SPIClass canSpi(HSPI);
static MCP2515  mcp(CAN_CS, 500000, &canSpi);
static bool     canReady = false;

//  Web server
static WebServer server(80);
static HardwareSerial nmeaSerial(2);

//  Rolling log for /log endpoint
static constexpr size_t LOG_LINES = 64;
static String logBuf[LOG_LINES];
static size_t logHead = 0;

static void emuLog(const String& line) {
  logBuf[logHead] = String(millis()) + "  " + line;
  logHead = (logHead + 1) % LOG_LINES;
  Serial.println(line);
}

//  Small helpers
static uint8_t clampByte(int v) {
  if (v < 0)   return 0;
  if (v > 255) return 255;
  return (uint8_t)v;
}

static float clampf(float v, float lo, float hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

static int jitterInt(int amp) {
  if (!ST.jitter_enabled || amp == 0) return 0;
  int scaled = (int)roundf(amp * ST.jitter_intensity);
  if (scaled <= 0) return 0;
  int span = 2 * scaled + 1;
  return (int)(esp_random() % span) - scaled;
}

static float jitterFloat(float amp) {
  if (!ST.jitter_enabled || amp <= 0.0f) return 0.0f;
  float a = amp * ST.jitter_intensity;
  float u = (float)esp_random() / (float)UINT32_MAX;
  return (u - 0.5f) * 2.0f * a;
}

// WIRE layer (raw byte) so the HMI's median+EMA filter cascade is what
static float applyFuelSlosh(float basePct) {
  if (!ST.slosh_enabled || TUN.slosh_pct_amp <= 0.0f) return basePct;
  float speedFactor = clampf(ST.speed_kph / 40.0f, 0.0f, 1.0f);
  if (speedFactor <= 0.0f) return basePct;
  float phase = fmodf((float)millis() / 1000.0f, TUN.slosh_period_s)
                / TUN.slosh_period_s;
  float wave  = sinf(phase * 2.0f * (float)M_PI);
  float slosh = TUN.slosh_pct_amp * speedFactor * wave;
  return clampf(basePct + slosh, 0.0f, 100.0f);
}

// Apply a preset from PROFILES[] to ST + related runtime fields.
static void applyProfile(int idx) {
  if (idx < 0 || (size_t)idx >= N_PROFILES) return;
  const VehicleProfile& p = PROFILES[idx];
  ST.vehicle_profile         = idx;
  ST.fuel_mode               = p.fuel_mode;
  ST.tank_capacity_l         = p.tank_capacity_l;
  ST.idle_rpm                = p.idle_rpm;
  ST.coolant_target_c        = p.coolant_target_c;
  ST.speed_rpm_gain          = p.speed_rpm_gain;
  ST.drive_burn_pct_per_min  = p.drive_burn_pct_per_min;
  ST.idle_burn_pct_per_min   = p.idle_burn_pct_per_min;
  emuLog(String("[PROFILE] applied idx=") + idx + " '" + p.name
         + "' fmode=" + fuelModeName(p.fuel_mode)
         + " tank=" + String(p.tank_capacity_l, 0) + "L"
         + " idle=" + String((int)p.idle_rpm) + "rpm");
}

// CAN response builders

// Send a single 8-byte frame with 0x55 padding after `payloadLen` bytes.
static void sendFrame(uint32_t id, const uint8_t* buf, uint8_t payloadLen) {
  if (!canReady) return;
  struct can_frame tx = {};
  tx.can_id  = id;
  tx.can_dlc = 8;
  memcpy(tx.data, buf, payloadLen);
  for (uint8_t i = payloadLen; i < 8; i++) tx.data[i] = 0x55;
  auto err = mcp.sendMessage(&tx);
  if (err != MCP2515::ERROR_OK) {
    emuLog(String("[CAN] TX FAIL id=0x") + String(id, HEX) + " err=" + String((int)err));
  }
}

static void respondMode01(uint8_t pid, const uint8_t* payload, uint8_t nData) {
  uint8_t buf[8];
  buf[0] = 2 + nData;
  buf[1] = 0x41;               // 0x01 + 0x40
  buf[2] = pid;
  for (uint8_t i = 0; i < nData; i++) buf[3 + i] = payload[i];
  sendFrame(0x7E8, buf, 3 + nData);
}

static void respondMode22(uint32_t respId, uint16_t did,
                          const uint8_t* payload, uint8_t nData) {
  uint8_t buf[8];
  buf[0] = 3 + nData;
  buf[1] = 0x62;
  buf[2] = (did >> 8) & 0xFF;
  buf[3] =  did       & 0xFF;
  for (uint8_t i = 0; i < nData; i++) buf[4 + i] = payload[i];
  sendFrame(respId, buf, 4 + nData);
}

// Response address is always 0x7C8.
static void respondToyotaMode21(uint8_t did, const uint8_t* payload, uint8_t nData) {
  uint8_t buf[8];
  buf[0] = 2 + nData;
  buf[1] = 0x61;
  buf[2] = did;
  for (uint8_t i = 0; i < nData; i++) buf[3 + i] = payload[i];
  sendFrame(0x7C8, buf, 3 + nData);
}

// Mode 22 answer coming from the Toyota combo meter (0x7C8).
static void respondToyotaMode22(uint16_t did, const uint8_t* payload, uint8_t nData) {
  respondMode22(0x7C8, did, payload, nData);
}

// Negative response (0x7F <service> <NRC>) -- currently unused, kept for
static void __attribute__((unused))
respondNegative(uint32_t respId, uint8_t service, uint8_t nrc) {
  uint8_t buf[8] = { 0x03, 0x7F, service, nrc, 0x55, 0x55, 0x55, 0x55 };
  sendFrame(respId, buf, 4);
}

// Count non-zero DTC slots.
static uint8_t activeDtcCount() {
  uint8_t n = 0;
  for (auto c : ST.dtc_codes) if (c != 0) n++;
  return n;
}

static void respondMode03() {
  uint8_t buf[8] = {0};
  uint8_t n = activeDtcCount();
  uint8_t emit = n > 2 ? 2 : n;   // single-frame budget
  buf[0] = 1 + 1 + 2 * emit;      // PCI: service + count + 2*n
  buf[1] = 0x43;
  buf[2] = n;                     // report ALL count so tools know there's more
  uint8_t j = 0;
  for (auto c : ST.dtc_codes) {
    if (c == 0) continue;
    if (j >= emit) break;
    buf[3 + 2 * j]     = (c >> 8) & 0xFF;
    buf[3 + 2 * j + 1] =  c       & 0xFF;
    j++;
  }
  sendFrame(0x7E8, buf, 3 + 2 * emit);
}

// PID handlers -- all use the CURRENT snapshot of ST

// HMI's logSupportedPids() decoder.
static uint32_t supportedPidsBitmap(uint8_t group) {
  auto bit = [](uint8_t pidOffset) -> uint32_t {
    return (uint32_t)1UL << (31 - (pidOffset - 1));
  };
  switch (group) {
    case 0x00: {
      uint32_t b = 0;
      b |= bit(0x01);  // DTC status
      b |= bit(0x04);  // engine load
      b |= bit(0x05);  // coolant
      b |= bit(0x0C);  // rpm
      b |= bit(0x0D);  // speed
      b |= bit(0x10);  // maf
      b |= bit(0x11);  // throttle
      b |= bit(0x1F);  // runtime
      if (ST.fuel_mode == FMODE_BOTH || ST.fuel_mode == FMODE_UNIVERSAL) {
        b |= 0x00000001;
      }
      return b;
    }
    case 0x20: {
      uint32_t b = 0;
      if (ST.fuel_mode == FMODE_BOTH || ST.fuel_mode == FMODE_UNIVERSAL) {
        b |= (uint32_t)1UL << (32 - (0x2F - 0x20));
      }
      return b;
    }
    default:
      return 0;
  }
}

static void handleMode01(uint8_t pid) {
  if ((pid & 0x1F) == 0) {
    uint32_t bits = supportedPidsBitmap(pid);
    uint8_t p[4] = {
      (uint8_t)((bits >> 24) & 0xFF),
      (uint8_t)((bits >> 16) & 0xFF),
      (uint8_t)((bits >>  8) & 0xFF),
      (uint8_t)( bits        & 0xFF),
    };
    respondMode01(pid, p, 4);
    return;
  }

  uint8_t p[4] = {0, 0, 0, 0};

  switch (pid) {
    case 0x01: {  // DTC status -- bit7 MIL, bits6-0 count
      uint8_t n = activeDtcCount();
      bool mil = ST.mil_on || (n > 0);
      p[0] = (mil ? 0x80 : 0x00) | (n & 0x7F);
      respondMode01(pid, p, 4);
      return;
    }
    case 0x04: {
      int raw = (int)roundf(ST.engine_load_pct * 255.0f / 100.0f) + jitterInt(1);
      p[0] = clampByte(raw);
      respondMode01(pid, p, 1);
      return;
    }
    case 0x05: {
      p[0] = clampByte((int)roundf(ST.coolant_temp_c + 40.0f));
      respondMode01(pid, p, 1);
      return;
    }
    case 0x0C: {
      int raw = (int)roundf(ST.rpm * 4.0f) + jitterInt(4);
      if (raw < 0) raw = 0;
      if (raw > 65535) raw = 65535;
      p[0] = ((uint16_t)raw >> 8) & 0xFF;
      p[1] =  (uint16_t)raw       & 0xFF;
      respondMode01(pid, p, 2);
      return;
    }
    case 0x0D: {
      int raw = (int)roundf(ST.speed_kph) + jitterInt(1);
      p[0] = clampByte(raw);
      respondMode01(pid, p, 1);
      return;
    }
    case 0x10: {
      int raw = (int)roundf(ST.maf_gps * 100.0f) + jitterInt(3);
      if (raw < 0) raw = 0;
      if (raw > 65535) raw = 65535;
      p[0] = ((uint16_t)raw >> 8) & 0xFF;
      p[1] =  (uint16_t)raw       & 0xFF;
      respondMode01(pid, p, 2);
      return;
    }
    case 0x11: {  // throttle -- +/-1 count
      int raw = (int)roundf(ST.throttle_pct * 255.0f / 100.0f) + jitterInt(1);
      p[0] = clampByte(raw);
      respondMode01(pid, p, 1);
      return;
    }
    case 0x1F: {
      uint32_t rt = ST.runtime_sec;
      if (rt > 65535) rt = 65535;
      p[0] = (rt >> 8) & 0xFF;
      p[1] =  rt       & 0xFF;
      respondMode01(pid, p, 2);
      return;
    }
    case 0x2F: {  // fuel level %
      // Silence when the operator has forced a Toyota-only mode -- that's how
      if (ST.fuel_mode == FMODE_TOYOTA || ST.fuel_mode == FMODE_TOYOTA_BCM) return;
      float pct = applyFuelSlosh(ST.fuel_level_pct);
      int raw = (int)roundf(pct * 255.0f / 100.0f) + jitterInt(1);
      p[0] = clampByte(raw);
      respondMode01(pid, p, 1);
      return;
    }
    default:
      // Silence unsupported PIDs -- real ECUs simply don't respond.
      return;
  }
}

static void handleToyotaMode21(uint8_t did) {
  if (ST.fuel_mode == FMODE_UNIVERSAL || ST.fuel_mode == FMODE_TOYOTA_BCM) return;
  if (did == 0x29) {
    float pct    = applyFuelSlosh(ST.fuel_level_pct);
    float liters = pct * ST.tank_capacity_l / 100.0f;
    int raw = (int)roundf(liters * 2.0f) + jitterInt(1);
    uint8_t payload[1] = { clampByte(raw) };
    respondToyotaMode21(did, payload, 1);
  }
}

static void handleToyotaMode22(uint16_t did) {
  if (ST.fuel_mode == FMODE_UNIVERSAL || ST.fuel_mode == FMODE_TOYOTA_BCM) return;
  if (did == 0x1022) {
    float pct    = applyFuelSlosh(ST.fuel_level_pct);
    float liters = pct * ST.tank_capacity_l / 100.0f;
    int raw = (int)roundf(liters * 100.0f) + jitterInt(2);
    if (raw < 0) raw = 0;
    if (raw > 65535) raw = 65535;
    uint8_t payload[2] = { (uint8_t)((raw >> 8) & 0xFF), (uint8_t)(raw & 0xFF) };
    respondToyotaMode22(did, payload, 2);
  }
}

static void handleBcmMode22(uint16_t did) {
  if (ST.fuel_mode == FMODE_UNIVERSAL || ST.fuel_mode == FMODE_TOYOTA) return;
  if (did == 0x1F2F) {
    float pct = applyFuelSlosh(ST.fuel_level_pct);
    int raw = (int)roundf(pct * 255.0f / 100.0f) + jitterInt(1);
    uint8_t payload[1] = { clampByte(raw) };
    respondMode22(0x708, did, payload, 1);
  }
}

// CAN request dispatcher

static void handleCanFrame(const can_frame& f) {
  if (f.can_dlc < 2) return;
  uint8_t pci     = f.data[0];
  uint8_t service = f.data[1];

  // 0x7DF broadcast -- Mode 01 or Mode 22 UDS
  if (f.can_id == 0x7DF) {
    if (service == 0x01 && pci >= 2 && f.can_dlc >= 3) {
      uint8_t pid = f.data[2];
      emuLog(String("[OBD2] RX  0x7DF Mode01 PID=0x") + String(pid, HEX));
      handleMode01(pid);
    } else if (service == 0x03 && f.can_dlc >= 2) {
      emuLog(String("[OBD2] RX  0x7DF Mode03 (read DTCs)  active=")
             + activeDtcCount());
      respondMode03();
    } else if (service == 0x22 && pci >= 3 && f.can_dlc >= 4) {
      uint16_t did = ((uint16_t)f.data[2] << 8) | f.data[3];
      emuLog(String("[OBD2] RX  0x7DF Mode22 DID=0x") + String(did, HEX));
      if (did == 0x1F2F &&
          (ST.fuel_mode == FMODE_BOTH || ST.fuel_mode == FMODE_TOYOTA_BCM)) {
        uint8_t raw = clampByte((int)roundf(ST.fuel_level_pct * 255.0f / 100.0f));
        respondMode22(0x7E8, did, &raw, 1);
      }
    }
    return;
  }

  if (f.can_id == 0x700) {
    if (service == 0x22 && f.can_dlc >= 4) {
      uint16_t did = ((uint16_t)f.data[2] << 8) | f.data[3];
      emuLog(String("[OBD2] RX  0x700 BCM  Mode22 DID=0x") + String(did, HEX));
      handleBcmMode22(did);
    }
    return;
  }

  if (f.can_id == 0x7C0) {
    if (service == 0x21 && f.can_dlc >= 3) {
      uint8_t did = f.data[2];
      emuLog(String("[OBD2] RX  0x7C0 METER Mode21 DID=0x") + String(did, HEX));
      handleToyotaMode21(did);
    } else if (service == 0x22 && f.can_dlc >= 4) {
      uint16_t did = ((uint16_t)f.data[2] << 8) | f.data[3];
      emuLog(String("[OBD2] RX  0x7C0 METER Mode22 DID=0x") + String(did, HEX));
      handleToyotaMode22(did);
    }
    return;
  }
}

static void canPump() {
  if (!canReady) return;
  struct can_frame rx;
  while (mcp.readMessage(&rx) == MCP2515::ERROR_OK) {
    handleCanFrame(rx);
  }
}


static bool initCan() {
  pinMode(CAN_CS, OUTPUT);
  digitalWrite(CAN_CS, HIGH);
  pinMode(CAN_INT, INPUT_PULLUP);
  canSpi.begin(CAN_SCK, CAN_MISO, CAN_MOSI, CAN_CS);

  if (mcp.reset() != MCP2515::ERROR_OK) {
    emuLog("[CAN] reset() failed");
    return false;
  }
  auto br = mcp.setBitrate(CAN_500KBPS, MCP_8MHZ);
  if (br != MCP2515::ERROR_OK) {
    // Common alternative crystal
    br = mcp.setBitrate(CAN_500KBPS, MCP_16MHZ);
    if (br != MCP2515::ERROR_OK) {
      emuLog(String("[CAN] setBitrate failed err=") + String((int)br));
      return false;
    }
    emuLog("[CAN] using 16 MHz crystal");
  } else {
    emuLog("[CAN] using 8 MHz crystal");
  }

  // Accept everything -- we filter in software by can_id in handleCanFrame().
  mcp.setFilterMask(MCP2515::MASK0, false, 0x00000000);
  mcp.setFilter(MCP2515::RXF0,      false, 0x00000000);
  mcp.setFilter(MCP2515::RXF1,      false, 0x00000000);
  mcp.setFilterMask(MCP2515::MASK1, false, 0x00000000);
  mcp.setFilter(MCP2515::RXF2,      false, 0x00000000);
  mcp.setFilter(MCP2515::RXF3,      false, 0x00000000);
  mcp.setFilter(MCP2515::RXF4,      false, 0x00000000);
  mcp.setFilter(MCP2515::RXF5,      false, 0x00000000);

  if (mcp.setNormalMode() != MCP2515::ERROR_OK) {
    emuLog("[CAN] setNormalMode failed");
    return false;
  }
  emuLog("[CAN] READY -- 500 kbps normal mode, filters open");
  return true;
}

// Scenario engine -- updates ST every SCENARIO_TICK_MS

static constexpr uint32_t SCENARIO_TICK_MS = 100;

static float rpmCruise(float kph) {
  float ign_bias = 0.0f;
  if (ST.ignition_state == IGN_CRANK)  return 260.0f + jitterFloat(20.0f);
  if (ST.ignition_state == IGN_WARMUP) ign_bias = 400.0f * clampf(
      1.0f - ((float)(millis() - ST.ignition_since_ms) / 60000.0f), 0.0f, 1.0f);
  return ST.idle_rpm + kph * ST.speed_rpm_gain
         + driverRpmOffset(ST.driver_style) + ign_bias;
}

static float loadCruise(float baseOffset, float kphGain, float kph) {
  return clampf(baseOffset + kph * kphGain
                + driverLoadOffset(ST.driver_style)
                + ST.terrain_grade_pct * 0.6f,
                0.0f, 100.0f);
}

static void applyScenario(uint32_t nowMs, float dt) {
  static bool prevEngineOn = false;
  if (ST.engine_on != prevEngineOn) {
    ST.ignition_state    = ST.engine_on ? IGN_CRANK : IGN_OFF;
    ST.ignition_since_ms = nowMs;
    if (ST.engine_on) {
      // Cold start: coolant reset toward ambient so warmup is visible
      if (ST.cold_start_enabled && ST.coolant_temp_c > ST.ambient_temp_c + 15.0f) {
        ST.coolant_temp_c = ST.ambient_temp_c;
      }
      emuLog("[IGN] CRANK");
    } else {
      emuLog("[IGN] OFF");
    }
    prevEngineOn = ST.engine_on;
  }
  uint32_t inState = nowMs - ST.ignition_since_ms;
  if (ST.ignition_state == IGN_CRANK && inState > 800) {
    ST.ignition_state    = IGN_WARMUP;
    ST.ignition_since_ms = nowMs;
    emuLog("[IGN] WARMUP");
  }
  if (ST.ignition_state == IGN_WARMUP && inState > 60000) {
    ST.ignition_state    = IGN_RUN;
    emuLog("[IGN] RUN");
  }

  static float runtimeAcc = 0.0f;
  if (ST.engine_on) {
    runtimeAcc += dt;
    while (runtimeAcc >= 1.0f) { runtimeAcc -= 1.0f; ST.runtime_sec++; }
  }

  // Coolant slew -- warms toward profile target when running, cools toward
  float coolantTarget = ST.engine_on ? ST.coolant_target_c : ST.ambient_temp_c;
  float slew = ST.engine_on ? 0.02f : 0.005f;   // ~50 s to 63 % / much slower cool
  ST.coolant_temp_c += (coolantTarget - ST.coolant_temp_c) * clampf(dt * slew, 0.0f, 1.0f);

  // Realistic fuel burn -- driver style + uphill grade both scale it.
  float burnBase = ST.engine_on
      ? (ST.speed_kph > 3.0f
          ? ST.drive_burn_pct_per_min
          : ST.idle_burn_pct_per_min)
      : 0.0f;
  float terrainFactor = 1.0f + (ST.terrain_grade_pct * 0.04f);
  if (terrainFactor < 0.4f) terrainFactor = 0.4f;
  float burn = burnBase * driverBurnMultiplier(ST.driver_style) * terrainFactor;
  ST.fuel_level_pct -= burn * dt / 60.0f;

  switch (ST.scenario) {

    case SCN_SAFE_IDLE:
      ST.engine_on       = false;
      ST.speed_kph       = 0;
      ST.rpm             = 0;
      ST.engine_load_pct = 0;
      ST.throttle_pct    = 0;
      ST.maf_gps         = 0;
      break;

    case SCN_NORMAL_TRIP: {
      ST.engine_on = true;
      float dv = TUN.trip_accel_kph_per_s * dt;
      if (ST.speed_kph < TUN.trip_target_kph) {
        ST.speed_kph = fminf(TUN.trip_target_kph, ST.speed_kph + dv);
      } else {
        ST.speed_kph = fmaxf(TUN.trip_target_kph, ST.speed_kph - dv);
      }
      ST.rpm             = rpmCruise(ST.speed_kph);
      ST.engine_load_pct = loadCruise(20.0f, 0.6f, ST.speed_kph);
      ST.throttle_pct    = loadCruise(12.0f, 0.3f, ST.speed_kph);
      ST.maf_gps         = clampf(2.0f + ST.speed_kph * 0.15f, 0.0f, 300.0f);
      break;
    }

    case SCN_TRAFFIC_IDLE: {
      ST.engine_on = true;
      float phase = fmodf((float)nowMs / 1000.0f, TUN.traffic_swing_period_s)
                    / TUN.traffic_swing_period_s;
      float wave  = 0.5f * (1.0f - cosf(phase * 2.0f * (float)M_PI));  // 0..1
      ST.speed_kph = TUN.traffic_min_kph
                     + (TUN.traffic_max_kph - TUN.traffic_min_kph) * wave;
      ST.rpm             = rpmCruise(ST.speed_kph) - 20.0f;   // low-gear crawl
      ST.engine_load_pct = loadCruise(15.0f, 1.2f, ST.speed_kph);
      ST.throttle_pct    = loadCruise(8.0f,  0.9f, ST.speed_kph);
      ST.maf_gps         = clampf(1.6f + ST.speed_kph * 0.10f, 0.0f, 300.0f);
      break;
    }

    case SCN_SUDDEN_DROP: {
      // One-shot -- subtract sudden_drop_pct immediately, then hold pattern.
      static uint32_t lastAppliedAt = 0;
      if (ST.last_scenario_ms != lastAppliedAt) {
        lastAppliedAt      = ST.last_scenario_ms;
        ST.fuel_level_pct -= TUN.sudden_drop_pct;
        if (ST.fuel_level_pct < 0) ST.fuel_level_pct = 0;
        emuLog(String("[SCN] SUDDEN_DROP applied -")
               + String(TUN.sudden_drop_pct, 1) + "%  now="
               + String(ST.fuel_level_pct, 1) + "%");
      }
      ST.engine_on = true;
      // Suspicious context: still moving-ish so the anomaly is context-aware
      if (ST.speed_kph < 20.0f) ST.speed_kph += 4.0f * dt;
      ST.rpm             = rpmCruise(ST.speed_kph) + 60.0f;
      ST.engine_load_pct = loadCruise(18.0f, 0.6f, ST.speed_kph);
      ST.throttle_pct    = loadCruise(10.0f, 0.3f, ST.speed_kph);
      break;
    }

    case SCN_GRADUAL_LEAK: {
      ST.engine_on = true;
      ST.fuel_level_pct -= TUN.leak_rate_pct_per_min * dt / 60.0f;
      // Normal-looking driving on top of the abnormal leak
      if (ST.speed_kph < TUN.trip_target_kph)
        ST.speed_kph = fminf(TUN.trip_target_kph, ST.speed_kph + 0.5f * dt);
      ST.rpm             = rpmCruise(ST.speed_kph);
      ST.engine_load_pct = loadCruise(20.0f, 0.6f, ST.speed_kph);
      ST.throttle_pct    = loadCruise(12.0f, 0.3f, ST.speed_kph);
      ST.maf_gps         = clampf(2.0f + ST.speed_kph * 0.15f, 0, 300);
      break;
    }

    case SCN_RAPID_ABNORMAL: {
      ST.engine_on = true;
      ST.fuel_level_pct -= TUN.rapid_rate_pct_per_min * dt / 60.0f;
      if (ST.speed_kph < TUN.trip_target_kph)
        ST.speed_kph = fminf(TUN.trip_target_kph, ST.speed_kph + 0.5f * dt);
      ST.rpm             = rpmCruise(ST.speed_kph);
      ST.engine_load_pct = loadCruise(20.0f, 0.6f, ST.speed_kph);
      ST.throttle_pct    = loadCruise(12.0f, 0.3f, ST.speed_kph);
      break;
    }

    case SCN_REFUEL: {
      static uint32_t enteredScnAt = 0;
      static uint32_t phaseSince   = 0;
      static uint8_t  phase        = 0;
      static float    fillStartPct = 0.0f;
      if (ST.last_scenario_ms != enteredScnAt) {
        enteredScnAt = ST.last_scenario_ms;
        phaseSince   = nowMs;
        phase        = 0;
        emuLog("[SCN] REFUEL -- pulling over");
      }
      if (phase == 0) {
        ST.engine_on = true;
        ST.speed_kph = fmaxf(0.0f, ST.speed_kph - 6.0f * dt);
        ST.rpm       = ST.idle_rpm + ST.speed_kph * 10.0f;
        if (ST.speed_kph <= 0.5f) {
          phase = 1;
          phaseSince = nowMs;
          emuLog("[SCN] REFUEL -- engine off, quiet window");
        }
      } else if (phase == 1) {
        ST.engine_on = false;
        ST.speed_kph = 0;
        ST.rpm       = 0;
        ST.throttle_pct = 0;
        ST.engine_load_pct = 0;
        if (nowMs - phaseSince >= TUN.refuel_quiet_ms) {
          phase = 2;
          phaseSince   = nowMs;
          fillStartPct = ST.fuel_level_pct;
          emuLog(String("[SCN] REFUEL -- filling from ")
                 + String(fillStartPct, 1) + "%");
        }
      } else if (phase == 2) {
        float frac = (float)(nowMs - phaseSince) / (float)TUN.refuel_fill_ms;
        if (frac >= 1.0f) {
          ST.fuel_level_pct = TUN.refuel_target_pct;
          phase = 3;
          emuLog(String("[SCN] REFUEL -- done, tank at ")
                 + String(TUN.refuel_target_pct, 1) + "%");
        } else {
          ST.fuel_level_pct = fillStartPct
              + (TUN.refuel_target_pct - fillStartPct) * frac;
        }
      }
      break;
    }

    case SCN_REST_ALERT: {
      static uint32_t boostedAt = 0;
      if (ST.last_scenario_ms != boostedAt) {
        boostedAt = ST.last_scenario_ms;
        ST.runtime_sec += TUN.rest_alert_runtime_boost_s;
        emuLog(String("[SCN] REST_ALERT -- runtime jumped to ")
               + String(ST.runtime_sec) + " s");
      }
      ST.engine_on = true;
      if (ST.speed_kph < TUN.trip_target_kph)
        ST.speed_kph = fminf(TUN.trip_target_kph, ST.speed_kph + 0.5f * dt);
      ST.rpm             = rpmCruise(ST.speed_kph);
      ST.engine_load_pct = loadCruise(20.0f, 0.6f, ST.speed_kph);
      ST.throttle_pct    = loadCruise(12.0f, 0.3f, ST.speed_kph);
      break;
    }

    case SCN_OVERSPEED: {
      ST.engine_on = true;
      ST.speed_kph = fminf(TUN.overspeed_kph, ST.speed_kph + 1.2f * dt);
      ST.rpm             = rpmCruise(ST.speed_kph) + 200.0f;
      ST.engine_load_pct = loadCruise(30.0f, 0.5f, ST.speed_kph);
      ST.throttle_pct    = loadCruise(20.0f, 0.3f, ST.speed_kph);
      break;
    }

    case SCN_MANUAL:
    default:
      break;
  }

  // Fuel noise (slosh) -- simulates raw sender jitter so the HMI's median+EMA
  ST.fuel_level_pct = clampf(ST.fuel_level_pct, 0.0f, 100.0f);
  ST.speed_kph      = clampf(ST.speed_kph,      0.0f, 250.0f);
  ST.rpm            = clampf(ST.rpm,            0.0f, 8000.0f);

  // GPS advance
  if (ST.speed_kph > 0.1f) {
    size_t nWp = 0;
    const Waypoint* wps = routePoints(ST.route_id, nWp);
    if (wps && nWp > 0) {
      if (ST.route_wp_idx < 0 || ST.route_wp_idx >= (int)nWp) ST.route_wp_idx = 0;
      const Waypoint& tgt = wps[ST.route_wp_idx];
      double dLat_deg = tgt.lat - ST.gps_lat;
      double dLng_deg = tgt.lng - ST.gps_lng;
      double latRad = ST.gps_lat * M_PI / 180.0;
      double dNorth_m = dLat_deg * 111320.0;
      double dEast_m  = dLng_deg * 111320.0 * cos(latRad);
      double distM    = sqrt(dNorth_m * dNorth_m + dEast_m * dEast_m);
      if (distM < 80.0) {
        ST.route_wp_idx = (ST.route_wp_idx + 1) % (int)nWp;
        emuLog(String("[ROUTE] reached waypoint, next idx=")
               + ST.route_wp_idx + "/" + (int)nWp);
      }
      float bearingDeg = (float)(atan2(dEast_m, dNorth_m) * 180.0 / M_PI);
      if (bearingDeg < 0.0f) bearingDeg += 360.0f;
      ST.gps_course_deg = bearingDeg;
    }
    float m_per_s = ST.speed_kph / 3.6f;
    float dist_m  = m_per_s * dt;
    float rad     = ST.gps_course_deg * (float)M_PI / 180.0f;
    double dLat = (dist_m * cosf(rad)) / 111320.0;
    double dLng = (dist_m * sinf(rad)) / (111320.0 * cos(ST.gps_lat * M_PI / 180.0));
    ST.gps_lat += dLat;
    ST.gps_lng += dLng;
  }
}


static uint8_t nmeaChecksum(const char* s) {
  uint8_t c = 0;
  while (*s) c ^= (uint8_t)(*s++);
  return c;
}

// Convert degrees to NMEA "ddmm.mmmm" (or "dddmm.mmmm") + hemisphere char.
static void nmeaLatLng(double deg, bool isLat, char* out, char& hemi) {
  hemi = isLat ? (deg >= 0 ? 'N' : 'S') : (deg >= 0 ? 'E' : 'W');
  double a = fabs(deg);
  int d = (int)a;
  double m = (a - d) * 60.0;
  if (isLat) snprintf(out, 32, "%02d%07.4f", d, m);
  else       snprintf(out, 32, "%03d%07.4f", d, m);
}

static void nmeaEmit(const char* body) {
  char buf[128];
  snprintf(buf, sizeof(buf), "$%s*%02X\r\n", body, nmeaChecksum(body));
  nmeaSerial.print(buf);
}

static void nmeaTick() {
  if (!USE_NMEA_GPS_OUTPUT) return;
  static uint32_t lastMs = 0;
  uint32_t now = millis();
  if (now - lastMs < 1000) return;
  lastMs = now;

  uint32_t s = now / 1000;
  uint8_t hh = (s / 3600) % 24;
  uint8_t mm = (s / 60) % 60;
  uint8_t ss = s % 60;

  char latS[32], lngS[32];
  char latH, lngH;
  nmeaLatLng(ST.gps_lat, true,  latS, latH);
  nmeaLatLng(ST.gps_lng, false, lngS, lngH);

  char body[128];
  // $GPRMC,hhmmss.00,A,ddmm.mmmm,N,dddmm.mmmm,E,speed_kn,course,ddmmyy,,,A
  float knots = ST.speed_kph * 0.539957f;
  snprintf(body, sizeof(body),
           "GPRMC,%02u%02u%02u.00,%c,%s,%c,%s,%c,%.1f,%.1f,050705,,,A",
           hh, mm, ss,
           ST.gps_fix ? 'A' : 'V',
           latS, latH, lngS, lngH,
           knots, ST.gps_course_deg);
  nmeaEmit(body);

  // $GPGGA,hhmmss.00,ddmm.mmmm,N,dddmm.mmmm,E,fix,sats,hdop,alt,M,geoid,M,,
  snprintf(body, sizeof(body),
           "GPGGA,%02u%02u%02u.00,%s,%c,%s,%c,%d,08,0.9,25.0,M,17.0,M,,",
           hh, mm, ss,
           latS, latH, lngS, lngH,
           ST.gps_fix ? 1 : 0);
  nmeaEmit(body);
}

// Web UI  --  served from PROGMEM

static const char INDEX_HTML[] PROGMEM = R"HTML(
<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>OBD2 Emulator</title>
<style>
 :root{--bg:#0a0e1a;--panel:#131824;--panel2:#0e1220;--border:#1e2536;--text:#e6ebf1;--muted:#64748b;--amber:#f59e0b;--cyan:#22d3ee;--green:#10b981;--red:#ef4444;--blue:#3b82f6;--purple:#a855f7}
 *{box-sizing:border-box}
 body{margin:0;background:var(--bg);color:var(--text);font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:14px}
 .hdr{background:linear-gradient(180deg,#1a2033,#0e1220);border-bottom:1px solid var(--border);padding:10px 18px;display:flex;justify-content:space-between;align-items:center}
 .brand{font-size:13px;font-weight:700;color:var(--amber);letter-spacing:.15em}
 .brand small{color:var(--muted);font-weight:400;margin-left:8px;letter-spacing:.05em}
 .wifi{font-size:11px;color:var(--muted);font-family:monospace}
 .wifi b{color:var(--green)}

 /* ?? Cluster (gauges) ?? */
 .cluster{background:var(--panel2);border-bottom:1px solid var(--border);padding:20px 16px}
 .big-row{display:grid;grid-template-columns:1fr 1fr;gap:20px;max-width:820px;margin:0 auto}
 .gauge{position:relative;text-align:center}
 .gauge svg{width:100%;max-width:240px;display:block;margin:0 auto}
 .gauge-bg{fill:none;stroke:#1a2033;stroke-width:14;stroke-linecap:round}
 .gauge-fg{fill:none;stroke-width:14;stroke-linecap:round;transition:stroke-dashoffset .3s ease-out}
 .g-speed .gauge-fg{stroke:var(--cyan)}
 .g-rpm .gauge-fg{stroke:var(--amber)}
 .g-value{position:absolute;top:52%;left:50%;transform:translate(-50%,-50%);font-family:'Courier New',monospace;font-weight:700;font-size:48px;line-height:1;color:var(--text)}
 .g-unit{position:absolute;top:70%;left:50%;transform:translate(-50%,0);color:var(--muted);font-size:11px;letter-spacing:.2em}
 .g-label{margin-top:6px;color:var(--muted);font-size:11px;letter-spacing:.25em}
 .g-max{position:absolute;bottom:4px;left:50%;transform:translate(-50%,0);color:var(--muted);font-size:9px;letter-spacing:.1em}

 /* ?? Linear bars for fuel + coolant ?? */
 .lin-row{display:grid;grid-template-columns:1fr 1fr;gap:16px;max-width:820px;margin:14px auto 0}
 .lg{background:#0a0e1a;border:1px solid var(--border);border-radius:8px;padding:10px 14px}
 .lg-hdr{display:flex;justify-content:space-between;font-size:11px;letter-spacing:.2em;color:var(--muted)}
 .lg-hdr b{color:var(--text);font-family:monospace;letter-spacing:0;font-size:15px}
 .lg-track{margin-top:8px;height:10px;background:#1a2033;border-radius:5px;overflow:hidden}
 .lg-fill{height:100%;border-radius:5px;transition:width .3s,background .3s}

 /* ?? Warning lights ?? */
 .warn-row{display:flex;gap:10px;max-width:820px;margin:14px auto 0;flex-wrap:wrap}
 .warn{flex:1;min-width:110px;padding:8px 12px;border:1px solid var(--border);border-radius:6px;display:flex;align-items:center;gap:8px;font-size:10px;letter-spacing:.2em;color:var(--muted);background:#0a0e1a}
 .warn-dot{width:8px;height:8px;border-radius:50%;background:#1e2536;flex-shrink:0}
 .warn.on{color:var(--text)}
 .warn.on .warn-dot{background:currentColor;box-shadow:0 0 8px currentColor}
 .warn.engine.on{color:var(--green)}
 .warn.mil.on{color:var(--amber)}
 .warn.dtc.on{color:var(--red)}
 .warn.low.on{color:var(--amber)}
 .warn.overspeed.on{color:var(--red)}

 /* ?? Content sections ?? */
 main{max-width:820px;margin:0 auto;padding:16px;display:grid;gap:12px}
 .sec{background:var(--panel);border:1px solid var(--border);border-radius:10px;padding:14px 16px}
 .sec h3{margin:0 0 12px;font-size:10px;letter-spacing:.25em;color:var(--muted);text-transform:uppercase;display:flex;justify-content:space-between;align-items:center}
 .sec h3 .pill{font-size:10px;color:var(--amber);background:rgba(245,158,11,.1);padding:3px 8px;border-radius:99px;letter-spacing:.05em;text-transform:none}

 /* ?? Buttons ?? */
 .btns{display:flex;flex-wrap:wrap;gap:8px}
 button{background:#1a2033;color:var(--text);border:1px solid var(--border);padding:9px 14px;border-radius:6px;font-size:13px;cursor:pointer;transition:all .12s;font-family:inherit}
 button:hover{background:#232b40;border-color:#2d3752}
 button.active{background:var(--amber);color:#0a0e1a;border-color:var(--amber);font-weight:600}
 button.danger{background:transparent;border-color:var(--red);color:var(--red)}
 button.danger:hover{background:rgba(239,68,68,.1)}
 button.scn{padding:12px 16px;font-weight:500;min-width:120px}
 button.scn.theft{border-color:rgba(239,68,68,.4)}
 button.scn.theft.active{background:var(--red);color:#fff;border-color:var(--red)}

 /* ?? Details / advanced ?? */
 details{background:var(--panel);border:1px solid var(--border);border-radius:10px}
 details summary{padding:14px 16px;cursor:pointer;font-size:10px;letter-spacing:.25em;color:var(--muted);text-transform:uppercase;list-style:none;user-select:none}
 details summary::-webkit-details-marker{display:none}
 details summary::before{content:'?  ';color:var(--amber)}
 details[open] summary::before{content:'?  '}
 details .body{padding:0 16px 16px}

 /* ?? Sliders ?? */
 .sliders{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px}
 .sld label{display:flex;justify-content:space-between;font-size:11px;color:var(--muted);letter-spacing:.05em;margin-bottom:4px}
 .sld label .v{color:var(--amber);font-family:monospace}
 input[type=range]{width:100%;accent-color:var(--amber);background:transparent}
 input[type=number]{width:100%;background:var(--bg);border:1px solid var(--border);color:var(--text);padding:6px 8px;border-radius:4px;font-size:13px;font-family:monospace}
 .toggle{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--muted)}
 .toggle input{accent-color:var(--amber)}

 /* ?? Log ?? */
 .log{background:#05070d;border:1px solid var(--border);border-radius:6px;padding:10px;max-height:200px;overflow:auto;font-family:'Courier New',monospace;font-size:11px;color:#94a3b8;white-space:pre-wrap;word-break:break-all;line-height:1.5}

 .hint{color:var(--muted);font-size:11px;margin-top:8px;font-style:italic}

 @media(max-width:640px){
  .big-row{grid-template-columns:1fr}
  .lin-row{grid-template-columns:1fr}
  .g-value{font-size:36px}
 }
</style></head><body>

<div class="hdr">
 <div class="brand">FLEETMONITOR OBD2 <small>EMULATOR</small></div>
 <div class="wifi" id="wifi">--</div>
</div>

<!-- CLUSTER: speed + rpm gauges -->
<div class="cluster">
 <div class="big-row">
  <div class="gauge g-speed">
   <svg viewBox="0 0 220 200">
    <path class="gauge-bg" pathLength="100" d="M 46.4 173.6 A 90 90 0 1 1 173.6 173.6"/>
    <path class="gauge-fg" id="arc_speed" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100" d="M 46.4 173.6 A 90 90 0 1 1 173.6 173.6"/>
   </svg>
   <div class="g-value" id="v_speed">0</div>
   <div class="g-unit">KM/H</div>
   <div class="g-max">0 ? 60 ? 120 ? 180</div>
   <div class="g-label">SPEED</div>
  </div>
  <div class="gauge g-rpm">
   <svg viewBox="0 0 220 200">
    <path class="gauge-bg" pathLength="100" d="M 46.4 173.6 A 90 90 0 1 1 173.6 173.6"/>
    <path class="gauge-fg" id="arc_rpm" pathLength="100" stroke-dasharray="100" stroke-dashoffset="100" d="M 46.4 173.6 A 90 90 0 1 1 173.6 173.6"/>
   </svg>
   <div class="g-value" id="v_rpm">0</div>
   <div class="g-unit">x 1000 RPM</div>
   <div class="g-max">0 ? 2 ? 4 ? 6</div>
   <div class="g-label">TACHOMETER</div>
  </div>
 </div>

 <!-- Linear bars: fuel + coolant -->
 <div class="lin-row">
  <div class="lg">
   <div class="lg-hdr"><span>FUEL LEVEL</span><b id="v_fuel">-</b></div>
   <div class="lg-track"><div class="lg-fill" id="bar_fuel" style="width:0%;background:var(--green)"></div></div>
  </div>
  <div class="lg">
   <div class="lg-hdr"><span>COOLANT</span><b id="v_coolant">-</b></div>
   <div class="lg-track"><div class="lg-fill" id="bar_coolant" style="width:0%;background:var(--blue)"></div></div>
  </div>
 </div>

 <!-- Warning lights -->
 <div class="warn-row">
  <div class="warn engine" id="w_engine"><div class="warn-dot"></div>ENGINE</div>
  <div class="warn mil"    id="w_mil"><div class="warn-dot"></div>MIL</div>
  <div class="warn dtc"    id="w_dtc"><div class="warn-dot"></div>DTC <span id="w_dtc_n">0</span></div>
  <div class="warn low"    id="w_low"><div class="warn-dot"></div>LOW FUEL</div>
  <div class="warn overspeed" id="w_over"><div class="warn-dot"></div>OVERSPEED</div>
 </div>
</div>

<main>

 <!-- SCENARIO -- the primary defense-demo action -->
 <div class="sec">
  <h3>SCENARIO <span class="pill" id="scn_pill">safe idle</span></h3>
  <div class="btns" id="scn_btns"></div>
 </div>

 <!-- VEHICLE PROFILE -->
 <div class="sec">
  <h3>VEHICLE <span class="pill" id="vp_pill">-</span></h3>
  <div class="btns" id="vp_btns"></div>
 </div>

 <!-- FUEL SOURCE MODE -->
 <div class="sec">
  <h3>FUEL SOURCE MODE <span class="pill" id="fm_pill">-</span></h3>
  <div class="btns" id="fm_btns"></div>
  <div class="hint">Overrides which OBD-II fuel path answers the HMI. Change to force the Path A -> Path B fallback demo.</div>
 </div>

 <!-- DTC injection -->
 <div class="sec">
  <h3>DIAGNOSTIC CODES <span class="pill" id="dtc_pill">0 active</span></h3>
  <div class="btns" id="dtc_btns"></div>
  <div class="btns" style="margin-top:8px">
   <button class="danger" onclick="clearDtc()">Clear all DTCs</button>
  </div>
 </div>

 <!-- Advanced (collapsed) -->
 <details>
  <summary>ADVANCED -- driver style, terrain, GPS route</summary>
  <div class="body">
   <div style="display:grid;gap:14px">
    <div>
     <div style="font-size:10px;color:var(--muted);letter-spacing:.2em;margin-bottom:8px">DRIVER STYLE</div>
     <div class="btns" id="ds_btns"></div>
    </div>
    <div>
     <div style="font-size:10px;color:var(--muted);letter-spacing:.2em;margin-bottom:8px">GPS ROUTE</div>
     <div class="btns" id="rt_btns"></div>
    </div>
    <div class="sliders">
     <div class="sld">
      <label>TERRAIN GRADE <span class="v" id="v_terrain">0</span></label>
      <input id="s_terrain" type="range" min="-20" max="20" step="0.5" onchange="apply({terrain_grade_pct:parseFloat(this.value)})" oninput="document.getElementById('v_terrain').textContent=this.value+'%'"/>
     </div>
     <div class="sld">
      <label>JITTER INTENSITY <span class="v" id="v_jit">1.0</span></label>
      <input id="s_jit" type="range" min="0" max="2" step="0.1" onchange="apply({jitter_intensity:parseFloat(this.value)})" oninput="document.getElementById('v_jit').textContent=parseFloat(this.value).toFixed(1)"/>
     </div>
    </div>
    <div style="display:flex;gap:16px;flex-wrap:wrap">
     <label class="toggle"><input id="j_en" type="checkbox" onchange="apply({jitter_enabled:this.checked})"/> Sensor jitter</label>
     <label class="toggle"><input id="sl_en" type="checkbox" onchange="apply({slosh_enabled:this.checked})"/> Fuel slosh</label>
     <label class="toggle"><input id="cs_en" type="checkbox" onchange="apply({cold_start_enabled:this.checked})"/> Cold-start realism</label>
    </div>
   </div>
  </div>
 </details>

 <!-- Manual override (collapsed) -->
 <details>
  <summary>MANUAL OVERRIDE -- sliders</summary>
  <div class="body">
   <div class="hint" style="margin-top:0;margin-bottom:12px">Moving any driving slider automatically switches the scenario to MANUAL so the value stops snapping back.</div>
   <div class="sliders" id="ctrls"></div>
   <div class="btns" style="margin-top:14px">
    <button class="danger" onclick="apply({fuel_level_pct: Math.max(0,(cur.fuel_level_pct||0)-5)})">-5% fuel</button>
    <button onclick="apply({fuel_level_pct: Math.min(100,(cur.fuel_level_pct||0)+5)})">+5% fuel</button>
    <button onclick="apply({engine_on:!cur.engine_on})">Toggle engine</button>
   </div>
   <div style="margin-top:16px;font-size:10px;letter-spacing:.2em;color:var(--muted)">GPS</div>
   <div class="sliders" style="margin-top:8px">
    <div class="sld"><label>LAT</label><input id="gps_lat" type="number" step="0.000001" onchange="applyField('gps_lat')"/></div>
    <div class="sld"><label>LNG</label><input id="gps_lng" type="number" step="0.000001" onchange="applyField('gps_lng')"/></div>
    <div class="sld"><label>COURSE  deg</label><input id="gps_course_deg" type="number" step="1" onchange="applyField('gps_course_deg')"/></div>
   </div>
  </div>
 </details>

 <!-- Serial log (collapsed) -->
 <details>
  <summary>SERIAL LOG</summary>
  <div class="body"><pre class="log" id="log">...</pre></div>
 </details>

</main>

<script>
const SCENARIOS = [
 [0,'Safe idle',''], [1,'Normal trip',''], [2,'Traffic / idle',''],
 [3,'Sudden drop','theft'], [4,'Gradual leak','theft'], [5,'Rapid abnormal','theft'],
 [6,'Refuel',''], [7,'Rest alert',''], [8,'Overspeed',''],
];
const FUEL_MODES = [ [0,'BOTH'], [1,'UNIVERSAL'], [2,'TOYOTA meter'], [3,'TOYOTA BCM'] ];
const VEHICLE_PROFILES = [ [0,'Fortuner meter'],[1,'Hilux meter'],[2,'Fortuner 2018+ BCM'],[3,'Hino 300'],[4,'Sedan'],[5,'Custom'] ];
const DRIVER_STYLES = [ [0,'Eco'],[1,'Normal'],[2,'Aggressive'] ];
const ROUTES = [ [0,'Straight'],[1,'SGSA -> Batangas'],[2,'Manila loop'] ];
const DTC_LIST = [ [0,'P0171'],[1,'P0300'],[2,'P0420'],[3,'P0128'],[4,'P0455'],[5,'U0100'] ];
const CONTROLS = [
 ['speed_kph','Speed km/h',0,180,1],
 ['rpm','RPM',0,6000,10],
 ['engine_load_pct','Load %',0,100,1],
 ['throttle_pct','Throttle %',0,100,1],
 ['fuel_level_pct','Fuel %',0,100,0.5],
 ['coolant_temp_c','Coolant  degC',-10,120,1],
 ['maf_gps','MAF g/s',0,200,0.5],
 ['runtime_sec','Runtime s',0,36000,10],
 ['tank_capacity_l','Tank L',10,300,1],
];
const SPEED_MAX = 180, RPM_MAX = 6000, COOLANT_HOT = 105;
let cur = {};
const $ = id => document.getElementById(id);
const post = (url,body) => fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}).then(()=>refresh());
const apply = p => post('/set', p);
const applyField = k => apply({[k]: parseFloat($(k).value)});
const setScn = n => post('/scenario',{scenario:n});
const setProfile = n => post('/profile',{profile:n});
const setRoute = n => post('/route',{route_id:n});
const injectDtc = n => post('/dtc',{inject:n});
const clearDtc = () => post('/dtc',{clear:true});

function buildAll(){
 $('scn_btns').innerHTML = SCENARIOS.map(([n,l,cls])=>`<button class="scn ${cls}" data-scn="${n}" onclick="setScn(${n})">${l}</button>`).join('');
 $('vp_btns').innerHTML  = VEHICLE_PROFILES.map(([n,l])=>`<button data-vp="${n}" onclick="setProfile(${n})">${l}</button>`).join('');
 $('fm_btns').innerHTML  = FUEL_MODES.map(([n,l])=>`<button data-fm="${n}" onclick="apply({fuel_mode:${n}})">${l}</button>`).join('');
 $('ds_btns').innerHTML  = DRIVER_STYLES.map(([n,l])=>`<button data-ds="${n}" onclick="apply({driver_style:${n}})">${l}</button>`).join('');
 $('rt_btns').innerHTML  = ROUTES.map(([n,l])=>`<button data-rt="${n}" onclick="setRoute(${n})">${l}</button>`).join('');
 $('dtc_btns').innerHTML = DTC_LIST.map(([n,l])=>`<button onclick="injectDtc(${n})">${l}</button>`).join('');
 $('ctrls').innerHTML = CONTROLS.map(([k,l,lo,hi,st])=>`<div class="sld"><label>${l} <span class="v" id="v_${k}">-</span></label><input id="s_${k}" type="range" min="${lo}" max="${hi}" step="${st}" oninput="document.getElementById('v_${k}').textContent=this.value" onchange="apply({${k}:parseFloat(this.value)})"/></div>`).join('');
}

function fuelColor(p){ return p<15?'var(--red)':p<30?'var(--amber)':'var(--green)'; }
function coolColor(c){ return c<60?'var(--blue)':c<95?'var(--green)':c<105?'var(--amber)':'var(--red)'; }

function arcOffset(pct){ return 100 - Math.max(0, Math.min(100, pct)); }

function update(st){
 // Gauges
 const speed = st.speed_kph||0;
 const rpm   = st.rpm||0;
 const fuel  = st.fuel_level_pct||0;
 const cool  = st.coolant_temp_c||0;

 $('v_speed').textContent = Math.round(speed);
 $('v_rpm').textContent   = (rpm/1000).toFixed(1);
 $('arc_speed').setAttribute('stroke-dashoffset', arcOffset(speed/SPEED_MAX*100));
 $('arc_rpm').setAttribute('stroke-dashoffset',   arcOffset(rpm/RPM_MAX*100));

 // Bars
 $('v_fuel').textContent = fuel.toFixed(1)+' %';
 $('v_coolant').textContent = Math.round(cool)+'  degC';
 const fb = $('bar_fuel'); fb.style.width = Math.max(0,Math.min(100,fuel))+'%'; fb.style.background = fuelColor(fuel);
 const cb = $('bar_coolant'); cb.style.width = Math.max(0,Math.min(100,(cool+10)/130*100))+'%'; cb.style.background = coolColor(cool);

 // Warning lights
 const dtcN = st.active_dtc_count||0;
 $('w_engine').classList.toggle('on', !!st.engine_on);
 $('w_mil').classList.toggle('on', !!st.mil_on || dtcN>0);
 $('w_dtc').classList.toggle('on', dtcN>0);
 $('w_dtc_n').textContent = dtcN;
 $('w_low').classList.toggle('on', fuel<15);
 $('w_over').classList.toggle('on', speed>90);

 // Pills
 $('scn_pill').textContent = st.scenario_name || '?';
 $('vp_pill').textContent  = st.vehicle_profile_name || '?';
 $('fm_pill').textContent  = st.fuel_mode_name || '?';
 $('dtc_pill').textContent = dtcN + ' active';

 // WiFi status
 const w = $('wifi');
 if (st.wifi_mode === 'sta') w.innerHTML = `<b>STA</b>  ${st.wifi_ssid}  ${st.wifi_ip}`;
 else if (st.wifi_mode === 'ap') w.innerHTML = `<b style="color:var(--amber)">AP</b>  ${st.wifi_ssid}  ${st.wifi_ip}`;
 else w.textContent = '--';

 // Active button highlighting
 document.querySelectorAll('#scn_btns button').forEach(b=>b.classList.toggle('active', +b.dataset.scn===st.scenario));
 document.querySelectorAll('#vp_btns button').forEach(b=>b.classList.toggle('active', +b.dataset.vp===st.vehicle_profile));
 document.querySelectorAll('#fm_btns button').forEach(b=>b.classList.toggle('active', +b.dataset.fm===st.fuel_mode));
 document.querySelectorAll('#ds_btns button').forEach(b=>b.classList.toggle('active', +b.dataset.ds===st.driver_style));
 document.querySelectorAll('#rt_btns button').forEach(b=>b.classList.toggle('active', +b.dataset.rt===st.route_id));

 for (const [k] of CONTROLS){
  const el=$('s_'+k), lbl=$('v_'+k);
  if (el && st[k]!=null && document.activeElement!==el){ el.value=st[k]; if(lbl) lbl.textContent=(+st[k]).toFixed(k==='fuel_level_pct'||k==='maf_gps'?1:0); }
 }
 for (const k of ['gps_lat','gps_lng','gps_course_deg']){
  const el=$(k); if(el && st[k]!=null && document.activeElement!==el) el.value = st[k];
 }
 const je=$('j_en'); if(je) je.checked = !!st.jitter_enabled;
 const se=$('sl_en'); if(se) se.checked = !!st.slosh_enabled;
 const ce=$('cs_en'); if(ce) ce.checked = !!st.cold_start_enabled;
 const stt=$('s_terrain'); if(stt && st.terrain_grade_pct!=null && document.activeElement!==stt){ stt.value=st.terrain_grade_pct; $('v_terrain').textContent=st.terrain_grade_pct+'%'; }
 const sjt=$('s_jit'); if(sjt && st.jitter_intensity!=null && document.activeElement!==sjt){ sjt.value=st.jitter_intensity; $('v_jit').textContent=(+st.jitter_intensity).toFixed(1); }

 cur = st;
}

function refresh(){
 fetch('/state').then(r=>r.json()).then(update).catch(()=>{});
 const l=$('log'); if(l && document.querySelector('details[open] .log')) fetch('/log').then(r=>r.text()).then(t=>{ l.textContent=t; l.scrollTop=l.scrollHeight; }).catch(()=>{});
}
buildAll(); refresh(); setInterval(refresh, 500);
</script>
</body></html>
)HTML";

//  HTTP handlers
static void httpRoot() {
  server.send_P(200, "text/html", INDEX_HTML);
}

static void httpState() {
  StaticJsonDocument<2048> doc;
  doc["speed_kph"]        = ST.speed_kph;
  doc["rpm"]              = ST.rpm;
  doc["engine_load_pct"]  = ST.engine_load_pct;
  doc["throttle_pct"]     = ST.throttle_pct;
  doc["fuel_level_pct"]   = ST.fuel_level_pct;
  doc["coolant_temp_c"]   = ST.coolant_temp_c;
  doc["maf_gps"]          = ST.maf_gps;
  doc["runtime_sec"]      = ST.runtime_sec;
  doc["engine_on"]        = ST.engine_on;
  doc["mil_on"]           = ST.mil_on;
  doc["dtc_count"]        = ST.dtc_count;
  doc["tank_capacity_l"]  = ST.tank_capacity_l;
  doc["gps_lat"]          = ST.gps_lat;
  doc["gps_lng"]          = ST.gps_lng;
  doc["gps_course_deg"]   = ST.gps_course_deg;
  doc["gps_fix"]          = ST.gps_fix;
  doc["scenario"]         = ST.scenario;
  doc["scenario_name"]    = scenarioName(ST.scenario);
  doc["fuel_mode"]        = ST.fuel_mode;
  doc["fuel_mode_name"]   = fuelModeName(ST.fuel_mode);
  doc["vehicle_profile"]  = ST.vehicle_profile;
  doc["vehicle_profile_name"] =
      (ST.vehicle_profile >= 0 && (size_t)ST.vehicle_profile < N_PROFILES)
        ? PROFILES[ST.vehicle_profile].name : "?";
  doc["idle_rpm"]         = ST.idle_rpm;
  doc["coolant_target_c"] = ST.coolant_target_c;
  doc["ambient_temp_c"]   = ST.ambient_temp_c;
  doc["cold_start_enabled"] = ST.cold_start_enabled;
  doc["ignition_state"]   = ST.ignition_state;
  doc["ignition_name"]    = ignitionName(ST.ignition_state);
  doc["driver_style"]     = ST.driver_style;
  doc["driver_style_name"] = driverStyleName(ST.driver_style);
  doc["terrain_grade_pct"] = ST.terrain_grade_pct;
  doc["route_id"]         = ST.route_id;
  doc["route_name"]       = routeName(ST.route_id);
  doc["route_wp_idx"]     = ST.route_wp_idx;
  doc["jitter_enabled"]   = ST.jitter_enabled;
  doc["jitter_intensity"] = ST.jitter_intensity;
  doc["slosh_enabled"]    = ST.slosh_enabled;
  doc["active_dtc_count"] = activeDtcCount();
  JsonArray dtc = doc.createNestedArray("dtc_codes");
  for (auto c : ST.dtc_codes) if (c != 0) {
    char s[8];
    char letter = "PCBU"[(c >> 14) & 0x3];
    snprintf(s, sizeof(s), "%c%04X", letter, c & 0x3FFF);
    dtc.add(String(s));   // copy -- s is a per-iteration stack buffer
  }
  doc["can_ready"]        = canReady;
  doc["uptime_ms"]        = (uint32_t)millis();
  doc["wifi_mode"]        = wifiActiveMode;
  doc["wifi_ssid"]        = wifiActiveSsid;
  doc["wifi_ip"]          = wifiActiveIp;
  doc["mdns_host"]        = mdnsActive ? String(MDNS_HOSTNAME) + ".local" : String("");
  String out; serializeJson(doc, out);
  server.send(200, "application/json", out);
}

static void httpSet() {
  if (!server.hasArg("plain")) { server.send(400, "text/plain", "no body"); return; }
  StaticJsonDocument<512> doc;
  if (deserializeJson(doc, server.arg("plain"))) { server.send(400, "text/plain", "bad json"); return; }
  bool touched_driving = false;
  if (doc.containsKey("speed_kph"))       { ST.speed_kph       = doc["speed_kph"];       touched_driving = true; }
  if (doc.containsKey("rpm"))             { ST.rpm             = doc["rpm"];             touched_driving = true; }
  if (doc.containsKey("engine_load_pct")) { ST.engine_load_pct = doc["engine_load_pct"]; touched_driving = true; }
  if (doc.containsKey("throttle_pct"))    { ST.throttle_pct    = doc["throttle_pct"];    touched_driving = true; }
  if (doc.containsKey("fuel_level_pct"))  ST.fuel_level_pct  = doc["fuel_level_pct"];
  if (doc.containsKey("coolant_temp_c"))  ST.coolant_temp_c  = doc["coolant_temp_c"];
  if (doc.containsKey("maf_gps"))         { ST.maf_gps         = doc["maf_gps"];         touched_driving = true; }
  if (doc.containsKey("runtime_sec"))     ST.runtime_sec     = doc["runtime_sec"];
  if (doc.containsKey("engine_on"))       ST.engine_on       = doc["engine_on"];
  if (doc.containsKey("mil_on"))          ST.mil_on          = doc["mil_on"];
  if (doc.containsKey("dtc_count"))       ST.dtc_count       = (uint8_t)(int)doc["dtc_count"];
  if (doc.containsKey("tank_capacity_l")) ST.tank_capacity_l = doc["tank_capacity_l"];
  if (doc.containsKey("gps_lat"))         ST.gps_lat         = doc["gps_lat"];
  if (doc.containsKey("gps_lng"))         ST.gps_lng         = doc["gps_lng"];
  if (doc.containsKey("gps_course_deg"))  ST.gps_course_deg  = doc["gps_course_deg"];
  if (doc.containsKey("gps_fix"))         ST.gps_fix         = doc["gps_fix"];
  if (doc.containsKey("fuel_mode")) {
    int fm = doc["fuel_mode"];
    if (fm >= 0 && fm <= FMODE_TOYOTA_BCM) {
      ST.fuel_mode = fm;
      emuLog(String("[FUELMODE] switched to ") + fuelModeName(fm));
    }
  }
  if (doc.containsKey("idle_rpm"))          ST.idle_rpm          = doc["idle_rpm"];
  if (doc.containsKey("coolant_target_c"))  ST.coolant_target_c  = doc["coolant_target_c"];
  if (doc.containsKey("ambient_temp_c"))    ST.ambient_temp_c    = doc["ambient_temp_c"];
  if (doc.containsKey("cold_start_enabled")) ST.cold_start_enabled = doc["cold_start_enabled"];
  if (doc.containsKey("jitter_enabled"))    ST.jitter_enabled    = doc["jitter_enabled"];
  if (doc.containsKey("jitter_intensity"))  ST.jitter_intensity  = doc["jitter_intensity"];
  if (doc.containsKey("slosh_enabled"))     ST.slosh_enabled     = doc["slosh_enabled"];
  if (doc.containsKey("driver_style")) {
    int ds = doc["driver_style"];
    if (ds >= 0 && ds <= 2) {
      ST.driver_style = ds;
      emuLog(String("[DRIVER] style=") + driverStyleName(ds));
    }
  }
  if (doc.containsKey("terrain_grade_pct")) ST.terrain_grade_pct = doc["terrain_grade_pct"];

  if (touched_driving && ST.scenario != SCN_MANUAL) {
    ST.scenario         = SCN_MANUAL;
    ST.last_scenario_ms = millis();
    if (ST.speed_kph > 0.5f) ST.engine_on = true;
    emuLog("[SCN] auto-switched to MANUAL (driving slider used)");
  }
  server.send(200, "application/json", "{\"ok\":true}");
}

// POST /profile -- apply a preset vehicle profile
static void httpProfile() {
  if (!server.hasArg("plain")) { server.send(400, "text/plain", "no body"); return; }
  StaticJsonDocument<128> doc;
  if (deserializeJson(doc, server.arg("plain"))) { server.send(400, "text/plain", "bad json"); return; }
  int idx = doc["profile"] | -1;
  if (idx < 0 || (size_t)idx >= N_PROFILES) { server.send(400, "text/plain", "bad profile"); return; }
  applyProfile(idx);
  server.send(200, "application/json", "{\"ok\":true}");
}

static void httpRoute() {
  if (!server.hasArg("plain")) { server.send(400, "text/plain", "no body"); return; }
  StaticJsonDocument<128> doc;
  if (deserializeJson(doc, server.arg("plain"))) { server.send(400, "text/plain", "bad json"); return; }
  int r = doc["route_id"] | -1;
  if (r < ROUTE_NONE || r > ROUTE_LOOP) { server.send(400, "text/plain", "bad route"); return; }
  ST.route_id     = r;
  ST.route_wp_idx = 0;
  // Snap position to the first waypoint of the newly-selected route.
  size_t nWp = 0;
  const Waypoint* wps = routePoints(r, nWp);
  if (wps && nWp > 0) {
    ST.gps_lat = wps[0].lat;
    ST.gps_lng = wps[0].lng;
  }
  emuLog(String("[ROUTE] switched to ") + routeName(r));
  server.send(200, "application/json", "{\"ok\":true}");
}

// POST /dtc -- inject a preset by index, or clear all
static void httpDtc() {
  if (!server.hasArg("plain")) { server.send(400, "text/plain", "no body"); return; }
  StaticJsonDocument<128> doc;
  if (deserializeJson(doc, server.arg("plain"))) { server.send(400, "text/plain", "bad json"); return; }
  if (doc["clear"] | false) {
    for (auto& c : ST.dtc_codes) c = 0;
    ST.mil_on   = false;
    ST.dtc_count = 0;
    emuLog("[DTC] cleared");
    server.send(200, "application/json", "{\"ok\":true}");
    return;
  }
  int idx = doc["inject"] | -1;
  if (idx < 0 || (size_t)idx >= N_DTC_PRESETS) {
    server.send(400, "text/plain", "bad preset");
    return;
  }
  const DtcPreset& p = DTC_PRESETS[idx];
  // Insert into first empty slot; if full, replace the last one.
  bool placed = false;
  for (auto& c : ST.dtc_codes) {
    if (c == 0) { c = p.raw; placed = true; break; }
  }
  if (!placed) ST.dtc_codes[sizeof(ST.dtc_codes) / sizeof(ST.dtc_codes[0]) - 1] = p.raw;
  ST.mil_on   = true;
  ST.dtc_count = activeDtcCount();
  emuLog(String("[DTC] injected ") + p.code + " (" + p.label + ")  total=" + activeDtcCount());
  server.send(200, "application/json", "{\"ok\":true}");
}

static void httpScenario() {
  if (!server.hasArg("plain")) { server.send(400, "text/plain", "no body"); return; }
  StaticJsonDocument<128> doc;
  if (deserializeJson(doc, server.arg("plain"))) { server.send(400, "text/plain", "bad json"); return; }
  int n = doc["scenario"] | -1;
  if (n < 0 || n > SCN_MANUAL) { server.send(400, "text/plain", "bad scenario"); return; }
  ST.scenario         = n;
  ST.last_scenario_ms = millis();
  emuLog(String("[SCN] switched to ") + scenarioName(n));
  server.send(200, "application/json", "{\"ok\":true}");
}

static void httpLog() {
  String out;
  out.reserve(1024);
  for (size_t i = 0; i < LOG_LINES; i++) {
    size_t idx = (logHead + i) % LOG_LINES;
    if (logBuf[idx].length()) { out += logBuf[idx]; out += '\n'; }
  }
  server.send(200, "text/plain", out);
}

// WiFi bring-up + serial command shell

static bool tryStaConnect(const String& ssid, const String& psk, uint32_t timeoutMs) {
  Serial.printf("[WIFI] STA attempting join to '%s' (up to %us)\n",
                ssid.c_str(), (unsigned)(timeoutMs / 1000));
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(ssid.c_str(), psk.c_str());
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < timeoutMs) {
    delay(200);
    Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() != WL_CONNECTED) {
    Serial.printf("[WIFI] STA join FAILED after %lu ms  status=%d\n",
                  (unsigned long)(millis() - t0), (int)WiFi.status());
    WiFi.disconnect(true);
    return false;
  }
  wifiActiveMode = "sta";
  wifiActiveSsid = ssid;
  wifiActiveIp   = WiFi.localIP().toString();
  Serial.printf("[WIFI] STA OK  ssid='%s'  ip=%s\n",
                ssid.c_str(), wifiActiveIp.c_str());
  return true;
}

static void bringUpSoftAP() {
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PSK);
  wifiActiveMode = "ap";
  wifiActiveSsid = AP_SSID;
  wifiActiveIp   = WiFi.softAPIP().toString();
  Serial.printf("[WIFI] SoftAP up  ssid=%s  ip=%s\n", AP_SSID, wifiActiveIp.c_str());
}

static void startMdns() {
  if (mdnsActive) return;
  if (MDNS.begin(MDNS_HOSTNAME)) {
    MDNS.addService("http", "tcp", 80);
    mdnsActive = true;
    Serial.printf("[WIFI] mDNS: http://%s.local/\n", MDNS_HOSTNAME);
  } else {
    Serial.println("[WIFI] mDNS init failed (harmless)");
  }
}

static void startWifi() {
  prefs.begin("obd2emu", true);   // read-only
  String savedSsid = prefs.getString("ssid", "");
  String savedPsk  = prefs.getString("psk",  "");
  prefs.end();

  if (savedSsid.length() > 0) {
    if (tryStaConnect(savedSsid, savedPsk, 10000)) { startMdns(); return; }
  } else {
    Serial.println("[WIFI] no saved STA creds in NVS");
  }

  if (WIFI_DEFAULT_SSID[0] != '\0') {
    if (tryStaConnect(WIFI_DEFAULT_SSID, WIFI_DEFAULT_PSK, 8000)) { startMdns(); return; }
  }

  Serial.println("[WIFI] falling back to SoftAP -- join it from your phone/laptop");
  bringUpSoftAP();
  startMdns();
}

static void printSerialHelp() {
  Serial.println();
  Serial.println("  serial commands");
  Serial.println("  ?????????????????????????????????????????????????????????");
  Serial.println("  wifi <SSID> <PSK>   save WiFi STA credentials and reboot");
  Serial.println("  wifi clear          erase saved STA credentials");
  Serial.println("  wifi status         print current mode / ssid / ip");
  Serial.println("  ip                  print current IP address");
  Serial.println("  reboot              restart the emulator");
  Serial.println("  help                show this list");
  Serial.println();
}

static void handleSerialCommand(String line) {
  line.trim();
  if (line.length() == 0) return;

  if (line == "help" || line == "?") { printSerialHelp(); return; }
  if (line == "ip") {
    Serial.printf("[SERIAL] mode=%s ssid='%s' ip=%s\n",
                  wifiActiveMode.c_str(), wifiActiveSsid.c_str(), wifiActiveIp.c_str());
    return;
  }
  if (line == "reboot") { Serial.println("[SERIAL] rebooting..."); delay(200); ESP.restart(); }

  if (line == "wifi status") {
    Serial.printf("[WIFI] mode=%s ssid='%s' ip=%s status=%d\n",
                  wifiActiveMode.c_str(), wifiActiveSsid.c_str(),
                  wifiActiveIp.c_str(), (int)WiFi.status());
    return;
  }
  if (line == "wifi clear") {
    prefs.begin("obd2emu", false);
    prefs.remove("ssid");
    prefs.remove("psk");
    prefs.end();
    Serial.println("[WIFI] saved credentials erased -- reboot for SoftAP fallback");
    return;
  }
  if (line.startsWith("wifi ")) {
    String rest = line.substring(5); rest.trim();
    // Split on the FIRST space so PSKs can contain further spaces? Simpler:
    int sep = rest.indexOf(' ');
    if (sep <= 0) { Serial.println("[WIFI] usage: wifi <SSID> <PSK>"); return; }
    String newSsid = rest.substring(0, sep);
    String newPsk  = rest.substring(sep + 1);
    newSsid.trim(); newPsk.trim();
    if (newSsid.length() == 0 || newPsk.length() < 8) {
      Serial.println("[WIFI] rejected -- SSID must be non-empty, PSK >= 8 chars");
      return;
    }
    prefs.begin("obd2emu", false);
    prefs.putString("ssid", newSsid);
    prefs.putString("psk",  newPsk);
    prefs.end();
    Serial.printf("[WIFI] saved ssid='%s' psk=***%d chars -- rebooting in 1s\n",
                  newSsid.c_str(), newPsk.length());
    delay(1000);
    ESP.restart();
  }

  Serial.println("[SERIAL] unknown command -- type 'help'");
}

static void serialCommandTick() {
  static String buf;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      handleSerialCommand(buf);
      buf = "";
      continue;
    }
    buf += c;
    if (buf.length() > 200) {   // runaway paste guard
      Serial.println("[SERIAL] input too long -- discarded");
      buf = "";
    }
  }
}


void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println();
  Serial.println("========================================================");
  Serial.println("  OBD2 / CAN emulator for FleetMonitor HMI (thesis)");
  Serial.println("========================================================");

  nmeaSerial.begin(NMEA_BAUD, SERIAL_8N1, NMEA_RX_PIN, NMEA_TX_PIN);
  Serial.printf("[NMEA] UART2 up   TX=GPIO%d @ %d baud   output=%s\n",
                NMEA_TX_PIN, NMEA_BAUD, USE_NMEA_GPS_OUTPUT ? "ENABLED" : "disabled");

  canReady = initCan();
  if (!canReady) Serial.println("[CAN] init FAILED -- check MCP2515 wiring / crystal");

  // Fortuner defaults on boot.
  applyProfile(0);

  startWifi();
  printSerialHelp();

  server.on("/",          HTTP_GET,  httpRoot);
  server.on("/state",     HTTP_GET,  httpState);
  server.on("/log",       HTTP_GET,  httpLog);
  server.on("/set",       HTTP_POST, httpSet);
  server.on("/scenario",  HTTP_POST, httpScenario);
  server.on("/profile",   HTTP_POST, httpProfile);
  server.on("/route",     HTTP_POST, httpRoute);
  server.on("/dtc",       HTTP_POST, httpDtc);
  server.begin();
  Serial.println("[HTTP] server on port 80");

  emuLog("[BOOT] emulator ready -- waiting for HMI OBD2 requests");
}

void loop() {
  canPump();

  // 2) HTTP
  server.handleClient();

  // 2b) Serial command shell -- 'wifi <SSID> <PSK>', 'reboot', 'help', etc.
  serialCommandTick();

  // 3) Scenario tick -- 10 Hz is plenty; keeps physics smooth.
  static uint32_t lastScnMs = 0;
  uint32_t now = millis();
  if (now - lastScnMs >= SCENARIO_TICK_MS) {
    float dt = (now - lastScnMs) / 1000.0f;
    lastScnMs = now;
    applyScenario(now, dt);
  }

  // 4) NMEA -- 1 Hz
  nmeaTick();

  // 5) Periodic status heartbeat -- every 5 s to serial only.
  static uint32_t lastBeatMs = 0;
  if (now - lastBeatMs >= 5000) {
    lastBeatMs = now;
    Serial.printf("[STATE] prof=%d ign=%-6s scn=%-14s fmode=%-20s drv=%-10s "
                  "spd=%5.1f rpm=%4.0f fuel=%5.1f%% coolant=%3.0fC dtc=%u route=%s can=%d\n",
                  ST.vehicle_profile, ignitionName(ST.ignition_state),
                  scenarioName(ST.scenario), fuelModeName(ST.fuel_mode),
                  driverStyleName(ST.driver_style),
                  ST.speed_kph, ST.rpm, ST.fuel_level_pct, ST.coolant_temp_c,
                  (unsigned)activeDtcCount(), routeName(ST.route_id),
                  canReady ? 1 : 0);
  }
}
