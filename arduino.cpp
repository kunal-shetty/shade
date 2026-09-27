// CyberSentinel Rover — Arduino node
//
// Motor control + buzzer + THREE OLED displays, talking to the
// Raspberry Pi gateway over USB serial at 115200 baud.
//
// Library needed (Tools → Manage Libraries):
//   * U8g2  (Oliver Kraus)  — drives all three OLEDs.
//     ArduinoJson is NOT used; the serial protocol is hand-written so the
//     Uno's 2 KB of RAM is not blown by a JSON document.
//
// Serial protocol (one JSON object per line):
//   {"topic":"device/health", "value":{"arduino":"online"}}
//   {"topic":"device/log",    "value":{"level":"info","msg":"..."}}
//
// Wiring:
//   Motors    IN1..IN4   D8, D9, D10, D11  (H-bridge driver)
//   Buzzer               D12
//   OLED 1    hardware I2C   A4 = SDA, A5 = SCL
//   OLED 2    software I2C   D4 = SDA, D5 = SCL
//   OLED 3    software I2C   D6 = SDA, D7 = SCL
//
// Memory notes:
//   One U8G2 object is shared across OLED 2 and OLED 3. The pins are
//   re-pointed before each draw via selectSoftPanel(). Both panels must
//   be initialised once in setup(); they keep their state between draws
//   because the SSD1306 controller holds its own display RAM.
//   All format strings use PSTR() / snprintf_P() so they stay in flash.

#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>

// ---------------------------------------------------------------------------
// Forward declarations
// (.ino files get these generated automatically; .cpp files need them explicit)
// ---------------------------------------------------------------------------
void sendLog(const char *level, const char *msg);
void reportError(const char *msg);
void reportWarn(const char *msg);
void scanHardwareI2C();
void selectSoftPanel(uint8_t index);
void setMotor(uint8_t a, uint8_t b, uint8_t c, uint8_t d);
void moveForward();
void moveBackward();
void moveLeft();
void moveRight();
void stopMotors();
void startHorn(uint16_t ms);
void renderOled1();
void renderOled2();
void renderOled3();
void sendHeartbeat();
void handleCommand(const char *command);
void pollSerial();

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

const uint8_t IN1 = 8, IN2 = 9, IN3 = 10, IN4 = 11;
const uint8_t BUZZER_PIN = 12;

// Software-I2C pin pairs for OLED 2 (index 0) and OLED 3 (index 1).
const uint8_t SOFT_SDA[2] = {4, 6};
const uint8_t SOFT_SCL[2] = {5, 7};

// ---------------------------------------------------------------------------
// Display objects
//
// THE FIX: use the concrete subclass types, not the base U8G2 class.
// U8G2 is abstract — you cannot declare "U8G2 myDisplay(...)".
//
// Constructor argument order for SW_I2C:  (rotation, clock, data, reset)
// ---------------------------------------------------------------------------

// OLED 1 — hardware I2C on A4/A5
U8G2_SSD1306_128X64_NONAME_1_HW_I2C u8g2_hw(U8G2_R0, U8X8_PIN_NONE);

// OLED 2 & 3 — shared software I2C object, starting on D4/D5
U8G2_SSD1306_128X64_NONAME_1_SW_I2C u8g2_soft(U8G2_R0,
    /* clock= */ 5, /* data= */ 4, U8X8_PIN_NONE);

// Which panels answered begin() at boot.
const uint8_t OLED1 = 1 << 0;
const uint8_t OLED2 = 1 << 1;
const uint8_t OLED3 = 1 << 2;
uint8_t oledOk = 0;

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

const unsigned long HEARTBEAT_MS = 2000;
const unsigned long DISPLAY_MS   = 250;
const uint16_t      HORN_MS      = 500;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const char *roverState = "IDLE";
char     lastCommand[9]  = "-";
char     lastError[18]   = "none";
uint8_t  commandCount    = 0;
uint8_t  errorCount      = 0;
unsigned long bootMs         = 0;
unsigned long lastHeartbeat  = 0;
unsigned long lastDisplay    = 0;
unsigned long buzzerUntil    = 0;

// ---------------------------------------------------------------------------
// Logging — hand-built JSON so no ArduinoJson overhead
// ---------------------------------------------------------------------------

void sendLog(const char *level, const char *msg) {
  Serial.print(F("{\"topic\":\"device/log\",\"value\":{\"level\":\""));
  Serial.print(level);
  Serial.print(F("\",\"msg\":\""));
  Serial.print(msg);
  Serial.println(F("\"}}"));
}

void reportError(const char *msg) {
  strncpy(lastError, msg, sizeof(lastError) - 1);
  lastError[sizeof(lastError) - 1] = '\0';
  if (errorCount < 255) errorCount++;
  sendLog("error", msg);
}

void reportWarn(const char *msg) { sendLog("warn", msg); }

// ---------------------------------------------------------------------------
// I2C scan — helps diagnose a blank OLED 1 (wrong address vs bad wiring)
// ---------------------------------------------------------------------------

void scanHardwareI2C() {
  uint8_t found = 0;
  for (uint8_t addr = 1; addr < 127; addr++) {
    Wire.beginTransmission(addr);
    if (Wire.endTransmission() == 0) {
      found++;
      char msg[20];
      snprintf_P(msg, sizeof(msg), PSTR("i2c 0x%02X found"), addr);
      sendLog("info", msg);
    }
  }
  if (!found) reportWarn("no I2C on A4/A5");
}

// ---------------------------------------------------------------------------
// Re-point the shared software bus at a different pin pair.
//
// u8x8_SetPin_SW_I2C argument order: (u8x8, clock, data, reset) — the SAME
// order as the U8G2 constructor, so clock (SCL) comes first.
// ---------------------------------------------------------------------------

void selectSoftPanel(uint8_t index) {
  uint8_t sda = SOFT_SDA[index];
  uint8_t scl = SOFT_SCL[index];
  u8x8_SetPin_SW_I2C(u8g2_soft.getU8x8(), scl, sda, U8X8_PIN_NONE);
  pinMode(scl, OUTPUT); digitalWrite(scl, HIGH);
  pinMode(sda, OUTPUT); digitalWrite(sda, HIGH);
}

// ---------------------------------------------------------------------------
// Motors — no Serial.print here; raw text would corrupt the JSON protocol
// ---------------------------------------------------------------------------

void setMotor(uint8_t a, uint8_t b, uint8_t c, uint8_t d) {
  digitalWrite(IN1, a); digitalWrite(IN2, b);
  digitalWrite(IN3, c); digitalWrite(IN4, d);
}

void moveForward()  { setMotor(HIGH, LOW,  HIGH, LOW);  roverState = "FORWARD";  }
void moveBackward() { setMotor(LOW,  HIGH, LOW,  HIGH); roverState = "BACKWARD"; }
void moveLeft()     { setMotor(LOW,  HIGH, HIGH, LOW);  roverState = "LEFT";     }
void moveRight()    { setMotor(HIGH, LOW,  LOW,  HIGH); roverState = "RIGHT";    }
void stopMotors()   { setMotor(LOW,  LOW,  LOW,  LOW);  roverState = "IDLE";     }

void startHorn(uint16_t ms) {
  tone(BUZZER_PIN, 1200);
  buzzerUntil = millis() + ms;
}

// ---------------------------------------------------------------------------
// Display rendering
//
// All three use page mode (_1_ driver). Each draw call must be wrapped in
// a firstPage()/nextPage() loop — the buffer is refilled one page at a time.
// Never call clearBuffer() in page mode; the driver clears each page for you.
// ---------------------------------------------------------------------------

// OLED 1 (hardware I2C): rover status dashboard
void renderOled1() {
  if (!(oledOk & OLED1)) return;
  u8g2_hw.firstPage();
  do {
    u8g2_hw.setFont(u8g2_font_6x10_tf);
    u8g2_hw.drawStr(0, 8, "CyberSentinel");
    u8g2_hw.drawLine(0, 10, 127, 10);

    u8g2_hw.setFont(u8g2_font_7x13B_tf);
    u8g2_hw.drawStr(0, 28, roverState);

    u8g2_hw.setFont(u8g2_font_6x10_tf);
    char line[20];
    snprintf_P(line, sizeof(line), PSTR("cmds:%u errs:%u"),
               commandCount, errorCount);
    u8g2_hw.drawStr(0, 44, line);

    snprintf_P(line, sizeof(line), PSTR("up: %lus"),
               (millis() - bootMs) / 1000UL);
    u8g2_hw.drawStr(0, 58, line);
  } while (u8g2_hw.nextPage());
}

// OLED 2 (soft I2C, D4/D5): blinking robot eye
void renderOled2() {
  if (!(oledOk & OLED2)) return;
  selectSoftPanel(0);

  // Blink: closed for 2 out of every 20 frames
  static uint8_t tick = 0;
  tick++;
  bool blink = (tick % 20) < 2;

  u8g2_soft.firstPage();
  do {
    u8g2_soft.setFont(u8g2_font_6x10_tf);
    u8g2_soft.drawStr(0, 8, "Eye");
    u8g2_soft.drawLine(0, 10, 127, 10);

    if (blink) {
      // Closed eye — a single horizontal line
      u8g2_soft.drawLine(24, 38, 104, 38);
    } else {
      // Open eye: outer ellipse → iris → filled pupil
      u8g2_soft.drawEllipse(64, 40, 38, 18, U8G2_DRAW_ALL);
      u8g2_soft.drawEllipse(64, 40, 14, 14, U8G2_DRAW_ALL);
      u8g2_soft.drawDisc(64, 40, 5);
    }

    u8g2_soft.setFont(u8g2_font_5x7_tf);
    char line[20];
    if (errorCount) snprintf_P(line, sizeof(line), PSTR("warn: %u"), errorCount);
    else            snprintf_P(line, sizeof(line), PSTR("sys: nominal"));
    u8g2_soft.drawStr(0, 62, line);
  } while (u8g2_soft.nextPage());
}

// OLED 3 (soft I2C, D6/D7): log / rally screen
void renderOled3() {
  if (!(oledOk & OLED3)) return;
  selectSoftPanel(1);

  u8g2_soft.firstPage();
  do {
    u8g2_soft.setFont(u8g2_font_6x10_tf);
    u8g2_soft.drawStr(0, 8, "Log");
    u8g2_soft.drawLine(0, 10, 127, 10);

    char line[20];
    snprintf_P(line, sizeof(line), PSTR("cmd: %s"), lastCommand);
    u8g2_soft.drawStr(0, 24, line);

    snprintf_P(line, sizeof(line), PSTR("errs: %u"), errorCount);
    u8g2_soft.drawStr(0, 38, line);

    u8g2_soft.drawStr(0, 52, lastError);
  } while (u8g2_soft.nextPage());
}

// ---------------------------------------------------------------------------
// Telemetry
// ---------------------------------------------------------------------------

void sendHeartbeat() {
  // device/health — a plain liveness beacon. The Pi decides whether the node
  // is really online from the open serial link, not from this line.
  Serial.println(F("{\"topic\":\"device/health\","
                   "\"value\":{\"arduino\":\"online\"}}"));
}

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

void handleCommand(const char *command) {
  strncpy(lastCommand, command, sizeof(lastCommand) - 1);
  lastCommand[sizeof(lastCommand) - 1] = '\0';
  if (commandCount < 255) commandCount++;

  if      (strcmp_P(command, PSTR("FORWARD"))  == 0) moveForward();
  else if (strcmp_P(command, PSTR("BACKWARD")) == 0) moveBackward();
  else if (strcmp_P(command, PSTR("LEFT"))     == 0) moveLeft();
  else if (strcmp_P(command, PSTR("RIGHT"))    == 0) moveRight();
  else if (strcmp_P(command, PSTR("STOP"))     == 0) stopMotors();
  else if (strcmp_P(command, PSTR("BUZZER"))   == 0) startHorn(HORN_MS);
  else {
    char msg[20];
    snprintf_P(msg, sizeof(msg), PSTR("unknown: %.12s"), command);
    reportError(msg);
  }
}

// Non-blocking, fixed-size serial reader. Avoids Arduino's heap-hungry String.
void pollSerial() {
  static char   buf[16];
  static uint8_t len = 0;

  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      if (len > 0) {
        buf[len] = '\0';
        handleCommand(buf);
        len = 0;
      }
    } else if (len < sizeof(buf) - 1) {
      buf[len++] = c;
    } else {
      len = 0;
      reportError("cmd too long");
    }
  }
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

void setup() {
  Serial.begin(115200);
  bootMs = millis();

  // Motor & output pins
  pinMode(IN1, OUTPUT); pinMode(IN2, OUTPUT);
  pinMode(IN3, OUTPUT); pinMode(IN4, OUTPUT);
  stopMotors();
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, LOW);

  Wire.begin();
  scanHardwareI2C();

  // OLED 1 — hardware I2C
  if (u8g2_hw.begin()) {
    oledOk |= OLED1;
  } else {
    reportError("oled1 fail");
  }

  // OLED 2 — software I2C, panel 0 (D4/D5)
  selectSoftPanel(0);
  delay(10);
  if (u8g2_soft.begin()) {
    oledOk |= OLED2;
  } else {
    reportError("oled2 fail");
  }

  // OLED 3 — software I2C, panel 1 (D6/D7)
  // Re-call begin() after switching pins so the new panel gets the SSD1306
  // initialisation sequence. The panel keeps its state in its own display RAM.
  selectSoftPanel(1);
  delay(10);
  if (u8g2_soft.begin()) {
    oledOk |= OLED3;
  } else {
    reportError("oled3 fail");
  }

  lastHeartbeat = millis();
  lastDisplay   = millis();

  char boot[20];
  snprintf_P(boot, sizeof(boot), PSTR("oleds %c%c%c"),
             (oledOk & OLED1) ? '1' : '-',
             (oledOk & OLED2) ? '2' : '-',
             (oledOk & OLED3) ? '3' : '-');
  sendLog("info", boot);
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------

void loop() {
  unsigned long now = millis();

  // 1. Commands from the Pi
  pollSerial();

  // 2. Non-blocking buzzer timeout
  if (buzzerUntil != 0 && (long)(now - buzzerUntil) >= 0) {
    noTone(BUZZER_PIN);
    buzzerUntil = 0;
  }

  // 3. Telemetry every 2 s
  if (now - lastHeartbeat >= HEARTBEAT_MS) {
    lastHeartbeat = now;
    sendHeartbeat();
  }

  // 4. Display refresh every 250 ms.
  //    OLED 1 (hardware bus) on every tick.
  //    OLED 2 and OLED 3 alternate so the soft bus is not hammered.
  if (now - lastDisplay >= DISPLAY_MS) {
    lastDisplay = now;
    renderOled1();
    static bool oddTick = false;
    oddTick = !oddTick;
    if (oddTick) renderOled2();
    else         renderOled3();
  }
}