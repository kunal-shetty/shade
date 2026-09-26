// CyberSentinel Rover — Arduino node
//
// Motor control + sensors + THREE OLED status displays, talking to the
// Raspberry Pi gateway over USB serial at 115200 baud.
//
// Library (Arduino IDE → Tools → Manage Libraries):
//   * U8g2  (Oliver Kraus)  — the OLEDs. That is the only one needed: the
//     serial protocol below is written out by hand rather than with
//     ArduinoJson, which costs RAM the Uno does not have to spare.
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
// --- Why this sketch is fussy about memory -------------------------------
// The Uno has only 2048 bytes of RAM. Three separate U8g2 display objects cost
// roughly 490 bytes each — U8g2 shares the 128-byte *pixel buffer* between
// page-mode displays, but not the u8g2_t struct behind each one. Three of them
// plus a JSON document overflowed RAM by 80 bytes and the sketch did not
// compile at all. Hence:
//   * one U8g2 object drives the hardware bus (OLED 1)
//   * ONE U8g2 object drives BOTH software-bus panels, re-pointed at the
//     other pin pair for each refresh (see selectSoftPanel)
//   * JSON is printed directly, so no ArduinoJson and no JSON document
//
// NOTE ON THE 3.3 V OLED: the Uno's I2C lines idle at 5 V, so the A4/A5
// display sees 5 V logic even though it is powered from 3.3 V. Most SSD1306
// breakouts tolerate that; if OLED 1 stays blank while OLED 2 and 3 work, feed
// it 5 V like the others or add a level shifter.

#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>

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
const uint8_t SOFT_SDA[2] = {4, 6};  // OLED 2 = D4, OLED 3 = D6
const uint8_t SOFT_SCL[2] = {5, 7};  // OLED 2 = D5, OLED 3 = D7

// Which panels answered at boot. A bitfield, because bytes are precious here.
const uint8_t OLED1 = 1 << 0;
const uint8_t OLED2 = 1 << 1;
const uint8_t OLED3 = 1 << 2;
uint8_t oledOk = 0;

const unsigned long HEARTBEAT_MS = 2000;  // sensor + health cadence
const unsigned long DISPLAY_MS = 250;     // display refresh cadence
const uint16_t HORN_MS = 500;

// Almost every SSD1306 breakout answers at 0x3C, which is also U8g2's default,
// so no address call is made here. If a panel stays blank while the I2C scan
// finds it at 0x3D, add `setI2CAddress()` BEFORE the matching begin() call and
// note that the argument form changed between U8g2 versions: older releases
// want the address shifted left one bit (0x3D << 1), 2.36+ wants it unshifted.

// ---------------------------------------------------------------------------
// Displays
//
// These are PAGE-buffered drivers (`_1_`), not full-frame (`_F_`). A full
// 128x64 frame needs 1024 bytes; page mode needs 128. Do not switch these to
// the `_F_` variants — the sketch will stop fitting.
//
// If your panels are 128x32 rather than 128x64, change `128X64` to `128X32` in
// both constructors below.
// ---------------------------------------------------------------------------

U8G2_SSD1306_128X64_NONAME_1_HW_I2C oled1(U8G2_R0, /* reset=*/ U8X8_PIN_NONE);

// The single software-I2C object, shared by OLED 2 and OLED 3.
U8G2_SSD1306_128X64_NONAME_1_SW_I2C oledSoft(U8G2_R0, /* clock=*/ SOFT_SCL[0],
                                             /* data=*/ SOFT_SDA[0], /* reset=*/ U8X8_PIN_NONE);

// ---------------------------------------------------------------------------
// State shown on the displays
// ---------------------------------------------------------------------------

const char *roverState = "IDLE";
bool doorOpen = false;
char lastCommand[9] = "-";
char lastError[18] = "none";
uint8_t commandCount = 0;
uint8_t errorCount = 0;
unsigned long bootMs = 0;
unsigned long lastHeartbeat = 0;
unsigned long lastDisplay = 0;
unsigned long buzzerUntil = 0;

// ---------------------------------------------------------------------------
// Logging
//
// Hand-written JSON: cheaper than a JSON document, and the Pi's parser does
// not care who composed the bytes. `msg` must not contain a quote or a
// backslash, so reportUnknownCommand() filters the one untrusted input.
// ---------------------------------------------------------------------------

void sendLog(const char *level, const char *msg) {
  Serial.print(F("{\"topic\":\"device/log\",\"value\":{\"level\":\""));
  Serial.print(level);
  Serial.print(F("\",\"msg\":\""));
  Serial.print(msg);
  Serial.print(F("\"}}"));
  Serial.println();
}

// Remembers the most recent problem so OLED 3 can show it without the Pi.
void reportError(const char *msg) {
  strncpy(lastError, msg, sizeof(lastError) - 1);
  lastError[sizeof(lastError) - 1] = '\0';
  if (errorCount < 255) {
    errorCount++;
  }
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
void scanHardwareI2C() {
  uint8_t found = 0;
  for (uint8_t address = 1; address < 127; address++) {
    Wire.beginTransmission(address);
    if (Wire.endTransmission() == 0) {
      found++;
      char msg[32];
      snprintf(msg, sizeof(msg), "i2c device found at 0x%02X", address);
      sendLog("info", msg);
    }
  }
  if (found == 0) {
    reportWarn("no I2C device answered on A4/A5");
  }
}

// ---------------------------------------------------------------------------
// Displays
// ---------------------------------------------------------------------------

// Re-points the shared software bus at the given panel.
//
// U8g2 figures out pinMode for its pins once, when the display is set up, so
// switching pins later has to be accompanied by configuring them here — the
// other pin pair would otherwise be left as inputs and the panel would stay
// blank.
void selectSoftPanel(uint8_t index) {
  uint8_t scl = SOFT_SCL[index];
  uint8_t sda = SOFT_SDA[index];
  u8x8_SetPin_SW_I2C(oledSoft.getU8x8(), scl, sda, U8X8_PIN_NONE);
  pinMode(scl, OUTPUT);
  pinMode(sda, OUTPUT);
  digitalWrite(scl, HIGH);
  digitalWrite(sda, HIGH);
}

void drawHeader(U8G2 &d, const char *title) {
  d.setFont(u8g2_font_6x10_tf);
  d.drawStr(0, 8, title);
  d.drawLine(0, 10, 127, 10);
}

void renderOled1() {
  if (!(oledOk & OLED1)) return;
  oled1.firstPage();
  do {
    drawHeader(oled1, "CyberSentinel");
    oled1.setFont(u8g2_font_7x13B_tf);
    oled1.drawStr(0, 25, roverState);
    oled1.setFont(u8g2_font_6x10_tf);
    char line[20];
    snprintf(line, sizeof(line), "cmds %u", commandCount);
    oled1.drawStr(0, 39, line);
    snprintf(line, sizeof(line), "up %lus", (millis() - bootMs) / 1000UL);
    oled1.drawStr(0, 51, line);
    snprintf(line, sizeof(line), "err %u", errorCount);
    oled1.drawStr(0, 63, line);
  } while (oled1.nextPage());
}

void renderOled2() {
  if (!(oledOk & OLED2)) return;
  selectSoftPanel(0);
  oledSoft.firstPage();
  do {
    drawHeader(oledSoft, "Sensors");
    oledSoft.setFont(u8g2_font_6x10_tf);
    oledSoft.drawStr(0, 24, "Door");
    oledSoft.setFont(u8g2_font_7x13B_tf);
    oledSoft.drawStr(64, 24, doorOpen ? "OPEN" : "CLOSED");
    oledSoft.setFont(u8g2_font_6x10_tf);
    char line[20];
    snprintf(line, sizeof(line), "reed %s", digitalRead(REED_PIN) ? "HI" : "LO");
    oledSoft.drawStr(0, 38, line);
    snprintf(line, sizeof(line), "p2:%s p3:%s",
             (oledOk & OLED2) ? "ok" : "--", (oledOk & OLED3) ? "ok" : "--");
    oledSoft.drawStr(0, 50, line);
    snprintf(line, sizeof(line), "hb %lus", (millis() - lastHeartbeat) / 1000UL);
    oledSoft.drawStr(0, 62, line);
  } while (oledSoft.nextPage());
}

void renderOled3() {
  if (!(oledOk & OLED3)) return;
  selectSoftPanel(1);
  oledSoft.firstPage();
  do {
    drawHeader(oledSoft, "Log");
    oledSoft.setFont(u8g2_font_6x10_tf);
    char line[20];
    snprintf(line, sizeof(line), "cmd %s", lastCommand);
    oledSoft.drawStr(0, 23, line);
    snprintf(line, sizeof(line), "errs %u", errorCount);
    oledSoft.drawStr(0, 35, line);
    oledSoft.drawStr(0, 47, "last error:");
    oledSoft.drawStr(0, 59, lastError);
  } while (oledSoft.nextPage());
  // Leave the bus pointed back at OLED 2, whose refresh comes first.
  selectSoftPanel(0);
}

bool initSoftPanel(uint8_t index, const char *label) {
  selectSoftPanel(index);
  if (oledSoft.begin()) {
    return true;
  }
  reportError(label);
  return false;
}

void setupDisplays() {
  // OLED 1 — hardware I2C on A4/A5. begin() returns 0 when nothing ACKs, which
  // is exactly the "is it wired up?" answer, so every result gets logged.
  Wire.begin();
  scanHardwareI2C();
  if (oled1.begin()) {
    oledOk |= OLED1;
  } else {
    reportError("OLED1 (A4/A5) not detected");
  }

  // OLED 2 and 3 share one object, so each is re-pointed and set up in turn.
  if (initSoftPanel(0, "OLED2 (D4/D5) not detected")) {
    oledOk |= OLED2;
  }
  if (initSoftPanel(1, "OLED3 (D6/D7) not detected")) {
    oledOk |= OLED3;
  }
  selectSoftPanel(0);
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

// The command text comes from the Pi and lands inside a JSON string, so only
// characters that need no escaping are allowed through.
void reportUnknownCommand(const char *command) {
  char safe[10];
  uint8_t i = 0;
  for (const char *p = command; *p != '\0' && i < sizeof(safe) - 1; p++) {
    char c = *p;
    if ((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-') {
      safe[i++] = c;
    }
  }
  safe[i] = '\0';
  char msg[32];
  snprintf(msg, sizeof(msg), "unknown command: %s", safe);
  reportError(msg);
}

void handleCommand(const char *command) {
  strncpy(lastCommand, command, sizeof(lastCommand) - 1);
  lastCommand[sizeof(lastCommand) - 1] = '\0';
  if (commandCount < 255) {
    commandCount++;
  }

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
    reportUnknownCommand(command);
  }
}

// Bounded line reader — avoids Arduino's heap-hungry String class.
void pollSerial() {
  static char buffer[20];
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
      reportError("serial command too long, dropped");
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

  Serial.print(F("{\"topic\":\"sensor/door\",\"value\":{\"open\":"));
  Serial.print(doorOpen ? F("true") : F("false"));
  Serial.print(F("}}"));
  Serial.println();

  Serial.print(F("{\"topic\":\"device/health\",\"value\":{\"arduino_door\":\"online\"}}"));
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
           (oledOk & OLED1) ? "1" : "-",
           (oledOk & OLED2) ? "2" : "-",
           (oledOk & OLED3) ? "3" : "-");
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
  // tick; the two bit-banged 5 V panels alternate to keep the loop responsive
  // (each software refresh takes tens of milliseconds).
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
