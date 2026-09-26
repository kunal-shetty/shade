// CyberSentinel Rover — Arduino node
//
// Motor control + sensors + THREE OLED status displays, talking to the
// Raspberry Pi gateway over USB serial at 115200 baud.
//
// Libraries (Arduino IDE → Tools → Manage Libraries):
//   * ArduinoJson  (Benoit Blanchon) 6.x   — the serial protocol. v7 removed
//     StaticJsonDocument and createNestedObject, which this sketch uses.
//   * U8g2         (Oliver Kraus)          — the OLEDs
//
// Every line the Pi receives is one JSON object:
//   {"topic": "sensor/door",   "value": {"open": false}}
//   {"topic": "device/health", "value": {"arduino_door": "online"}}
//   {"topic": "device/log",    "value": {"level": "error", "msg": "..."}}
//
// The Pi prints every device/log line into `journalctl -u cybersentinel-gateway`,
// so a mis-wire or a missing display shows up there instead of failing silently.
//
// --- Wiring -------------------------------------------------------------
//   Motors    IN1..IN4   D8, D9, D10, D11
//   Reed      door       D2
//   Buzzer    horn       D12
//   OLED 1    3.3 V      A4 = SDA, A5 = SCL   (hardware I2C)
//   OLED 2    5 V        D4 = SDA, D5 = SCL   (software I2C)
//   OLED 3    5 V        D6 = SDA, D7 = SCL   (software I2C)
//
// NOTE ON THE 3.3 V OLED: the Uno's I2C lines idle at 5 V, so the A4/A5
// display sees 5 V logic even though it is powered from 3.3 V. Most SSD1306
// breakouts tolerate that; if OLED 1 stays blank while OLED 2 and 3 work, feed
// it 5 V like the others or add a level shifter.

#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>
#include <ArduinoJson.h>

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

const uint8_t IN1 = 8;
const uint8_t IN2 = 9;
const uint8_t IN3 = 10;
const uint8_t IN4 = 11;

const uint8_t REED_PIN = 2;
const uint8_t BUZZER_PIN = 12;

// Software-I2C pins for the two 5 V displays.
const uint8_t OLED2_SDA = 4;
const uint8_t OLED2_SCL = 5;
const uint8_t OLED3_SDA = 6;
const uint8_t OLED3_SCL = 7;

// Almost every SSD1306 breakout answers at 0x3C, which is also U8g2's default,
// so no address call is made here. If a panel stays blank while the scan below
// finds it at 0x3D, add `oledN.setI2CAddress(...)` BEFORE the matching begin()
// call in setupDisplays(). Note the argument form changed between U8g2 versions:
// older releases want the address shifted left one bit (0x3D << 1), 2.36+
// wants it unshifted (0x3D). Try both if the first does not light it up.

const unsigned long HEARTBEAT_MS = 2000;  // sensor + health cadence
const unsigned long DISPLAY_MS = 250;     // display refresh cadence
const uint16_t HORN_MS = 500;

// ---------------------------------------------------------------------------
// Displays
//
// These use U8g2's PAGE-buffered drivers (`_1_`), not the full-frame ones
// (`_F_`). A full 128x64 frame needs 1024 bytes and three of them would not
// fit in the Uno's 2048 bytes of SRAM — the sketch would hang or garble
// everything. A page buffer is ~130 bytes each, so all three fit comfortably.
//
// If your panels are 128x32 rather than 128x64, swap the middle token for
// `128X32_NONAME` in all three constructors.
// ---------------------------------------------------------------------------

U8G2_SSD1306_128X64_NONAME_1_HW_I2C oled1(U8G2_R0, /* reset=*/ U8X8_PIN_NONE);
U8G2_SSD1306_128X64_NONAME_1_SW_I2C oled2(U8G2_R0, /* clock=*/ OLED2_SCL, /* data=*/ OLED2_SDA, /* reset=*/ U8X8_PIN_NONE);
U8G2_SSD1306_128X64_NONAME_1_SW_I2C oled3(U8G2_R0, /* clock=*/ OLED3_SCL, /* data=*/ OLED3_SDA, /* reset=*/ U8X8_PIN_NONE);

bool oledOk[3] = {false, false, false};

// ---------------------------------------------------------------------------
// State shown on the displays
// ---------------------------------------------------------------------------

const char *roverState = "IDLE";
bool doorOpen = false;
char lastCommand[12] = "-";
char lastError[21] = "none";
uint16_t commandCount = 0;
uint16_t errorCount = 0;
unsigned long bootMs = 0;
unsigned long lastHeartbeat = 0;
unsigned long lastDisplay = 0;
unsigned long buzzerUntil = 0;

// Reused so the sketch does not hammer the tiny stack on every log line.
StaticJsonDocument<192> txDoc;

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

void sendLog(const char *level, const char *msg) {
  txDoc.clear();
  txDoc["topic"] = "device/log";
  JsonObject value = txDoc.createNestedObject("value");
  value["level"] = level;
  value["msg"] = msg;
  if (serializeJson(txDoc, Serial) == 0) {
    // Out of JSON space: fall back to a raw line so the Pi still sees something.
    Serial.print(F("{\"topic\":\"device/log\",\"value\":{\"level\":\"error\",\"msg\":\"json buffer full\"}}"));
  }
  Serial.println();
}

// Remembers the most recent problem so OLED 3 can show it without the Pi.
void reportError(const char *msg) {
  strncpy(lastError, msg, sizeof(lastError) - 1);
  lastError[sizeof(lastError) - 1] = '\0';
  errorCount++;
  sendLog("error", msg);
}

void reportWarn(const char *msg) {
  sendLog("warn", msg);
}

// ---------------------------------------------------------------------------
// I2C diagnostics
// ---------------------------------------------------------------------------

// Scans the hardware bus (A4/A5) and reports what answered. When OLED 1 is
// blank, this is the fastest way to tell "wiring" from "wrong address".
uint8_t scanHardwareI2C() {
  uint8_t found = 0;
  for (uint8_t address = 1; address < 127; address++) {
    Wire.beginTransmission(address);
    if (Wire.endTransmission() == 0) {
      found++;
      Serial.print(F("{\"topic\":\"device/log\",\"value\":{\"level\":\"info\",\"msg\":\"i2c device found at 0x"));
      if (address < 16) Serial.print('0');
      Serial.print(address, HEX);
      Serial.print(F("\"}}"));
      Serial.println();
    }
  }
  if (found == 0) {
    reportWarn("no I2C device answered on A4/A5");
  }
  return found;
}

// ---------------------------------------------------------------------------
// Displays
// ---------------------------------------------------------------------------

void drawHeader(U8G2 &d, const char *title) {
  d.setFont(u8g2_font_6x10_tf);
  d.drawStr(0, 8, title);
  d.drawLine(0, 10, 127, 10);
}

void renderOled1() {
  if (!oledOk[0]) return;
  oled1.firstPage();
  do {
    drawHeader(oled1, "CyberSentinel");
    oled1.setFont(u8g2_font_7x13B_tf);
    oled1.drawStr(0, 25, roverState);
    oled1.setFont(u8g2_font_6x10_tf);
    char line[24];
    snprintf(line, sizeof(line), "cmds %u", commandCount);
    oled1.drawStr(0, 39, line);
    snprintf(line, sizeof(line), "up %lus", (millis() - bootMs) / 1000UL);
    oled1.drawStr(0, 51, line);
    snprintf(line, sizeof(line), "err %u", errorCount);
    oled1.drawStr(0, 63, line);
  } while (oled1.nextPage());
}

void renderOled2() {
  if (!oledOk[1]) return;
  oled2.firstPage();
  do {
    drawHeader(oled2, "Sensors");
    oled2.setFont(u8g2_font_6x10_tf);
    oled2.drawStr(0, 24, "Door");
    oled2.setFont(u8g2_font_7x13B_tf);
    oled2.drawStr(64, 24, doorOpen ? "OPEN" : "CLOSED");
    oled2.setFont(u8g2_font_6x10_tf);
    char line[24];
    snprintf(line, sizeof(line), "reed %s", digitalRead(REED_PIN) ? "HIGH" : "LOW");
    oled2.drawStr(0, 38, line);
    snprintf(line, sizeof(line), "i2c 2:%s 3:%s", oledOk[1] ? "ok" : "--", oledOk[2] ? "ok" : "--");
    oled2.drawStr(0, 50, line);
    snprintf(line, sizeof(line), "hb %lus", (millis() - lastHeartbeat) / 1000UL);
    oled2.drawStr(0, 62, line);
  } while (oled2.nextPage());
}

void renderOled3() {
  if (!oledOk[2]) return;
  oled3.firstPage();
  do {
    drawHeader(oled3, "Log");
    oled3.setFont(u8g2_font_6x10_tf);
    char line[24];
    snprintf(line, sizeof(line), "cmd %s", lastCommand);
    oled3.drawStr(0, 23, line);
    snprintf(line, sizeof(line), "errs %u", errorCount);
    oled3.drawStr(0, 35, line);
    oled3.drawStr(0, 47, "last error:");
    oled3.drawStr(0, 59, lastError);
  } while (oled3.nextPage());
}

void setupDisplays() {
  // OLED 1 — hardware I2C on A4/A5. begin() returns 0 when nothing ACKs, which
  // is exactly the "is it wired up?" answer, so every result gets logged.
  Wire.begin();
  scanHardwareI2C();
  if (oled1.begin()) {
    oledOk[0] = true;
  } else {
    reportError("OLED1 (A4/A5) not detected");
  }

  if (oled2.begin()) {
    oledOk[1] = true;
  } else {
    reportError("OLED2 (D4/D5) not detected");
  }

  if (oled3.begin()) {
    oledOk[2] = true;
  } else {
    reportError("OLED3 (D6/D7) not detected");
  }
}

// ---------------------------------------------------------------------------
// Motors
// ---------------------------------------------------------------------------

void setMotor(uint8_t a, uint8_t b, uint8_t c, uint8_t d) {
  digitalWrite(IN1, a);
  digitalWrite(IN2, b);
  digitalWrite(IN3, c);
  digitalWrite(IN4, d);
}

void moveForward()  { setMotor(HIGH, LOW, HIGH, LOW); }
void moveBackward() { setMotor(LOW, HIGH, LOW, HIGH); }
void moveLeft()     { setMotor(LOW, HIGH, HIGH, LOW); }
void moveRight()    { setMotor(HIGH, LOW, LOW, HIGH); }
void stopMotors()   { setMotor(LOW, LOW, LOW, LOW); }

void startHorn(uint16_t ms) {
  if (buzzerUntil != 0) {
    reportWarn("horn asked for while already sounding");
  }
  tone(BUZZER_PIN, 1200);
  buzzerUntil = millis() + ms;
}

// ---------------------------------------------------------------------------
// Command handling
// ---------------------------------------------------------------------------

void handleCommand(const char *command) {
  strncpy(lastCommand, command, sizeof(lastCommand) - 1);
  lastCommand[sizeof(lastCommand) - 1] = '\0';
  commandCount++;

  if (strcmp(command, "FORWARD") == 0) {
    moveForward();
    roverState = "FORWARD";
  } else if (strcmp(command, "BACKWARD") == 0) {
    moveBackward();
    roverState = "BACKWARD";
  } else if (strcmp(command, "LEFT") == 0) {
    moveLeft();
    roverState = "LEFT";
  } else if (strcmp(command, "RIGHT") == 0) {
    moveRight();
    roverState = "RIGHT";
  } else if (strcmp(command, "STOP") == 0) {
    stopMotors();
    roverState = "IDLE";
  } else if (strcmp(command, "BUZZER") == 0) {
    startHorn(HORN_MS);
  } else {
    // Never fail silently: the Pi's journal will show what arrived.
    char msg[32];
    snprintf(msg, sizeof(msg), "unknown command: %.16s", command);
    reportError(msg);
  }
}

// Bounded line reader — avoids Arduino's heap-hungry String class.
void pollSerial() {
  static char buffer[24];
  static uint8_t length = 0;

  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (length > 0) {
        buffer[length] = '\0';
        handleCommand(buffer);
        length = 0;
      }
    } else if (length < sizeof(buffer) - 1) {
      buffer[length++] = c;
    } else {
      length = 0;
      reportError("serial command line too long, dropped");
    }
  }
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

void sendHeartbeat() {
  bool isOpen = (digitalRead(REED_PIN) == HIGH);
  if (isOpen != doorOpen) {
    doorOpen = isOpen;
    sendLog(isOpen ? "warn" : "info", isOpen ? "door opened" : "door closed");
  }

  txDoc.clear();
  txDoc["topic"] = "sensor/door";
  JsonObject value = txDoc.createNestedObject("value");
  value["open"] = doorOpen;
  if (serializeJson(txDoc, Serial) == 0) {
    reportError("door telemetry did not fit the json buffer");
  }
  Serial.println();

  txDoc.clear();
  txDoc["topic"] = "device/health";
  JsonObject health = txDoc.createNestedObject("value");
  health["arduino_door"] = "online";
  if (serializeJson(txDoc, Serial) == 0) {
    reportError("health telemetry did not fit the json buffer");
  }
  Serial.println();
}

// ---------------------------------------------------------------------------
// Setup / loop
// ---------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  bootMs = millis();

  // Motor pins. The enable pins are assumed tied to 5 V.
  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT);
  pinMode(IN4, OUTPUT);
  stopMotors();

  pinMode(REED_PIN, INPUT_PULLUP);

  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  setupDisplays();

  // Give the Pi a second to attach before the first line, then announce the
  // boot result so a wiring problem is visible immediately.
  delay(200);
  char boot[40];
  snprintf(boot, sizeof(boot), "arduino ready, oleds %s%s%s",
           oledOk[0] ? "1" : "-", oledOk[1] ? "2" : "-", oledOk[2] ? "3" : "-");
  sendLog("info", boot);
}

void loop() {
  // 1. Commands from the Raspberry Pi.
  pollSerial();

  // 2. Non-blocking horn: the old delay() blocked serial reads and the OLEDs.
  if (buzzerUntil != 0 && (long)(millis() - buzzerUntil) >= 0) {
    noTone(BUZZER_PIN);
    buzzerUntil = 0;
  }

  // 3. Telemetry every 2 s.
  if (millis() - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = millis();
    sendHeartbeat();
  }

  // 4. Displays. OLED 1 is on the fast hardware bus, so it refreshes every
  // tick; the two bit-banged 5 V panels alternate to keep the loop responsive.
  if (millis() - lastDisplay >= DISPLAY_MS) {
    lastDisplay = millis();
    renderOled1();
    static bool oddTick = false;
    oddTick = !oddTick;
    if (oddTick) {
      renderOled2();
    } else {
      renderOled3();
    }
  }
}
