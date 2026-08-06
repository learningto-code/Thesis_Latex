
#include <Arduino.h>
#include <SPI.h>
#include <LoRa.h>

#define LORA_NSS_PIN    13      // GPIO13 -- free output, no boot-strap effects
#define LORA_DIO0_PIN   36      // GPIO36 -- input-only, TX/RX-done interrupt
#define LORA_RST_PIN    -1      // RST not wired; library uses software reset
#define LORA_FREQ_HZ    433000000UL
#define LORA_TX_DBM     17

#define BOOT_BTN_PIN    0

struct Band {
  uint8_t   index;
  uint16_t  distance_m;
  const char* environment;
};

static const Band bands[] = {
  { 1,    10, "open_los"   },
  { 2,    50, "open_los"   },
  { 3,   100, "open_los"   },
  { 4,   250, "open_los"   },
  { 5,   500, "open_los"   },
  { 6,  1000, "open_los"   },
  { 7,  2000, "open_los"   },
  { 8,  5000, "open_los_elevated" },
  { 9,   100, "urban_nlos" },
  { 10,  250, "urban_nlos" },
  { 11,  500, "urban_nlos" },
};
static constexpr size_t N_BANDS              = sizeof(bands) / sizeof(bands[0]);
static constexpr uint16_t PACKETS_PER_BAND   = 100;
static constexpr uint16_t TX_INTERVAL_MS     = 200;   // ~5 Hz

static size_t nextBandIdx = 0;
static bool   btnLast     = HIGH;

static void sendOne(const String& payload) {
  LoRa.beginPacket();
  LoRa.print(payload);
  LoRa.endPacket();
}

static void runBand(const Band& b) {
  Serial.printf("[tx] starting band %u  d=%u m  env=%s\n",
                b.index, b.distance_m, b.environment);

  sendOne(String("HDR|band=") + b.index
          + "|d=" + b.distance_m
          + "|env=" + b.environment);
  delay(TX_INTERVAL_MS);

  for (uint16_t k = 1; k <= PACKETS_PER_BAND; k++) {
    sendOne(String("PKT|band=") + b.index + "|seq=" + k);
    delay(TX_INTERVAL_MS);
  }

  sendOne(String("END|band=") + b.index);
  Serial.printf("[tx] done band=%u\n", b.index);
}

void setup() {
  Serial.begin(115200);
  pinMode(BOOT_BTN_PIN, INPUT_PULLUP);

  LoRa.setPins(LORA_NSS_PIN, LORA_RST_PIN, LORA_DIO0_PIN);
  if (!LoRa.begin(LORA_FREQ_HZ)) {
    Serial.println("[tx] LoRa init FAILED");
    while (true) delay(1000);
  }
  LoRa.setSpreadingFactor(7);
  LoRa.setSignalBandwidth(125E3);
  LoRa.setCodingRate4(5);
  LoRa.setTxPower(LORA_TX_DBM);
  Serial.println("[tx] LoRa ready on HMI pins (NSS=13, DIO0=36)");
  Serial.println("[tx] press BOOT to fire the next band");
}

void loop() {
  bool btn = digitalRead(BOOT_BTN_PIN);
  if (btn == LOW && btnLast == HIGH) {
    if (nextBandIdx < N_BANDS) {
      runBand(bands[nextBandIdx]);
      nextBandIdx++;
      Serial.printf("[tx] %u/%u bands done -- move, then press BOOT\n",
                    (unsigned)nextBandIdx, (unsigned)N_BANDS);
    } else {
      Serial.println("[tx] all 11 bands done -- test complete");
    }
    delay(300); // debounce
  }
  btnLast = btn;
}
