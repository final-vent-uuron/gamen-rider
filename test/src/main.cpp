#include <Arduino.h>

// GPIO 10番ピン（内蔵LED）
#define LED_PIN 10

void setup() {
  // シリアル通信の開始
  Serial.begin(115200);

  // LEDピンを出力に設定
  pinMode(LED_PIN, OUTPUT);
}

void loop() {
  // PCに状態を送る
  Serial.println("LED ON");
  digitalWrite(LED_PIN, LOW); // LOWで光る仕様の可能性が高いためLOWにします
  delay(1000);

  Serial.println("LED OFF");
  digitalWrite(LED_PIN, HIGH); // HIGHで消灯
  delay(1000);
}
