
#include <Arduino.h>
#include <SPI.h>
#include <LoRa.h>

#define LORA_NSS_PIN    5       // GPIO5  -- gateway NSS / CS
#define LORA_RST_PIN    14      // GPIO14 -- gateway RST
#define LORA_DIO0_PIN   2       // GPIO2  -- TX/RX-done interrupt
#define LORA_FREQ_HZ    433000000UL

void setup() {
  Serial.begin(115200);
  delay(200);

  LoRa.setPins(LORA_NSS_PIN, LORA_RST_PIN, LORA_DIO0_PIN);
  if (!LoRa.begin(LORA_FREQ_HZ)) {
    Serial.println("[rx] LoRa init FAILED");
    while (true) delay(1000);
  }
  LoRa.setSpreadingFactor(7);
  LoRa.setSignalBandwidth(125E3);
  LoRa.setCodingRate4(5);
  Serial.println("[rx] LoRa receiver ready on gateway pins (NSS=5, DIO0=2)");
  Serial.println("[rx] format: RX|t=<ms>|rssi=<dBm>|snr=<dB>|<payload>");
}

void loop() {
  int sz = LoRa.parsePacket();
  if (sz <= 0) return;

  String body;
  while (LoRa.available()) body += (char)LoRa.read();
  int   rssi   = LoRa.packetRssi();
  float snr    = LoRa.packetSnr();
  uint32_t tMs = millis();

  Serial.printf("RX|t=%lu|rssi=%d|snr=%.1f|%s\n",
                (unsigned long)tMs, rssi, snr, body.c_str());
}
