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
//   Mouth     hardware I2C   A4 = SDA, A5 = SCL   (SH1106 128x64)
//   Left eye  software I2C   D4 = SCL, D5 = SDA   (SH1106 128x64)
//   Right eye software I2C   D6 = SCL, D7 = SDA   (SH1106 128x64)
//
// Memory notes:
//   Three separate U8G2 objects, one per panel, so each eye owns its own
//   software-I2C pin pair and the mouth stays on the hardware bus. They use
//   the page-mode (_1_) drivers, not the full-buffer (F_) ones: a full
//   128x64 frame is 1 KB and the Uno has 2 KB in total, so three of them
//   cannot fit alongside the U8G2 objects and the serial buffers.
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
void drawEye(U8G2 &display, int mode, int pupilOffset, bool blink, bool isLeft);
void drawMouth(int mode, int talkingFrame);
void updateFace(unsigned long now);
void setMotor(uint8_t a, uint8_t b, uint8_t c, uint8_t d);
void moveForward();
void moveBackward();
void moveLeft();
void moveRight();
void stopMotors();
void startHorn(uint16_t ms);
void sendHeartbeat();
void handleCommand(const char *command);
void pollSerial();

// ---------------------------------------------------------------------------
// Pins
// ---------------------------------------------------------------------------

const uint8_t IN1 = 8, IN2 = 9, IN3 = 10, IN4 = 11;
const uint8_t BUZZER_PIN = 12;

// ---------------------------------------------------------------------------
// Display objects
//
// THE FIX: use the concrete subclass types, not the base U8G2 class.
// U8G2 is abstract — you cannot declare "U8G2 myDisplay(...)".
//
// Constructor argument order for SW_I2C:  (rotation, clock, data, reset)
//                                    i.e. (rotation, SCL, SDA, reset)
//
// The _1_ in the class name is the page-mode driver. Do NOT switch these to
// the _F_ (full buffer) variants — see the memory notes at the top.
// ---------------------------------------------------------------------------

// LEFT EYE — software I2C, SCL = D4, SDA = D5
U8G2_SH1106_128X64_NONAME_1_SW_I2C leftEye(
  U8G2_R0, 4, 5, U8X8_PIN_NONE
);

// RIGHT EYE — software I2C, SCL = D6, SDA = D7
U8G2_SH1106_128X64_NONAME_1_SW_I2C rightEye(
  U8G2_R0, 6, 7, U8X8_PIN_NONE
);

// MOUTH — hardware I2C, SDA = A4, SCL = A5
U8G2_SH1106_128X64_NONAME_1_HW_I2C mouth(
  U8G2_R0, U8X8_PIN_NONE
);

// Which panels answered begin() at boot.
const uint8_t EYE_LEFT  = 1 << 0;
const uint8_t EYE_RIGHT = 1 << 1;
const uint8_t MOUTH     = 1 << 2;
uint8_t oledOk = 0;

// ---------------------------------------------------------------------------
// Face animation state
//
// Expressions: 0 = Happy, 1 = Normal, 2 = Surprised, 3 = Sleepy, 4 = Sad
// ---------------------------------------------------------------------------

int expression = 0;
int look = 0;

unsigned long lastBlink = 0;
unsigned long lastExpression = 0;
unsigned long lastLook = 0;

bool blinking = false;
unsigned long blinkStart = 0;

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
// Face rendering (eyes + mouth)
//
// Page mode (_1_ driver). A full 128x64 framebuffer would be 1 KB per panel
// and the Uno only has 2 KB total, so each draw is wrapped in a
// firstPage()/nextPage() loop instead: the scene below is re-issued once per
// page and only the 128-byte page buffer lives in RAM.
//
// Two consequences of page mode, both relied on here:
//   * never call clearBuffer()/sendBuffer() — they are full-buffer only;
//   * setDrawColor(0) only erases pixels drawn EARLIER IN THE SAME PAGE, so
//     the shapes must be issued in the order below (background first).
// ---------------------------------------------------------------------------

// ==========================================
// DRAW EYE
//
// Left panel shows  >   right panel shows  <
// Both chevrons point inward, toward the face centre.
// mode / pupilOffset are kept for API compatibility; unused now.
// ==========================================
void drawEye(U8G2 &display, int mode, int pupilOffset,
             bool blink, bool isLeft) {

  display.firstPage();
  do {

    if (blink) {
      // Squint: three stacked horizontal lines
      display.drawLine(20, 31, 108, 31);
      display.drawLine(20, 32, 108, 32);
      display.drawLine(20, 33, 108, 33);

    } else if (isLeft) {
      // > — arms open left, tip points right (toward face center)
      for (int8_t t = 0; t < 3; t++) {
        display.drawLine(20, 8  + t, 100 + t, 32);   // upper arm
        display.drawLine(20, 56 - t, 100 + t, 32);   // lower arm
      }
      // sparkle dot floating above tip
      display.drawDisc(82, 13, 2);

    } else {
      // < — arms open right, tip points left (toward face center)
      for (int8_t t = 0; t < 3; t++) {
        display.drawLine(108, 8  + t, 28 - t, 32);   // upper arm
        display.drawLine(108, 56 - t, 28 - t, 32);   // lower arm
      }
      // sparkle dot floating above tip
      display.drawDisc(46, 13, 2);
    }

  } while (display.nextPage());
}
// ==========================================
// DRAW MOUTH
// ==========================================
void drawMouth(int mode, int talkingFrame) {

  mouth.firstPage();
  do {

    // HAPPY SMILE
    if (mode == 0) {
      mouth.drawLine(25, 27, 38, 43);
      mouth.drawLine(38, 43, 53, 51);
      mouth.drawLine(53, 51, 75, 51);
      mouth.drawLine(75, 51, 90, 43);
      mouth.drawLine(90, 43, 103, 27);

      mouth.drawLine(25, 28, 103, 28);
    }

    // NORMAL / NEUTRAL
    else if (mode == 1) {
      mouth.drawRBox(29, 29, 70, 8, 4);
    }

    // SURPRISED / WOW
    else if (mode == 2) {
      mouth.drawEllipse(64, 35, 19, 25, U8G2_DRAW_ALL);
      mouth.drawEllipse(64, 35, 10, 16, U8G2_DRAW_ALL);
    }

    // SLEEPY
    else if (mode == 3) {
      mouth.drawRBox(43, 34, 42, 5, 2);
    }

    // SAD
    else if (mode == 4) {
      mouth.drawLine(29, 47, 45, 36);
      mouth.drawLine(45, 36, 64, 31);
      mouth.drawLine(64, 31, 83, 36);
      mouth.drawLine(83, 36, 99, 47);
    }

    // Talking animation for happy expression
    if (mode == 0 && talkingFrame == 1) {
      mouth.drawRBox(39, 31, 50, 24, 9);
      mouth.setDrawColor(0);
      mouth.drawRBox(47, 34, 34, 13, 4);
      mouth.setDrawColor(1);
    }

    // Talking animation for neutral expression
    if (mode == 1 && talkingFrame == 1) {
      mouth.drawRBox(35, 27, 58, 22, 8);
      mouth.setDrawColor(0);
      mouth.drawRBox(43, 32, 42, 10, 4);
      mouth.setDrawColor(1);
    }

  } while (mouth.nextPage());
}

// ==========================================
// FACE ANIMATION TICK
//
// Called from loop(). Advances the expression / pupil / blink timers and
// redraws all three panels. Only panels that answered begin() are touched.
// ==========================================
void updateFace(unsigned long now) {

  // Change facial expression every 4 seconds
  if (now - lastExpression >= 4000) {
    lastExpression = now;
    expression++;
    if (expression > 4) expression = 0;
  }

  // Move pupils every 900 milliseconds
  if (now - lastLook >= 900) {
    lastLook = now;
    look++;
    if (look > 2) look = 0;
  }

  // Blink every 3 seconds
  if (!blinking && now - lastBlink >= 3000) {
    blinking = true;
    blinkStart = now;
    lastBlink = now;
  }

  // Keep blink brief
  if (blinking && now - blinkStart >= 160) {
    blinking = false;
  }

  // Pupil direction
  int pupilOffset = 0;
  if (look == 1) pupilOffset = 12;
  if (look == 2) pupilOffset = -12;

  // Draw both eyes
  if (oledOk & EYE_LEFT)  drawEye(leftEye,  expression, pupilOffset, blinking, true);
  if (oledOk & EYE_RIGHT) drawEye(rightEye, expression, pupilOffset, blinking, false);

  // Animate mouth while talking
  int talkingFrame = (now / 250) % 2;
  if (oledOk & MOUTH) drawMouth(expression, talkingFrame);
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

  // LEFT EYE — software I2C, SCL = D4, SDA = D5
  if (leftEye.begin()) {
    oledOk |= EYE_LEFT;
  } else {
    reportError("eye L fail");
  }
  leftEye.setI2CAddress(0x3C * 2);
  leftEye.setBusClock(100000);

  // RIGHT EYE — software I2C, SCL = D6, SDA = D7
  if (rightEye.begin()) {
    oledOk |= EYE_RIGHT;
  } else {
    reportError("eye R fail");
  }
  rightEye.setI2CAddress(0x3C * 2);
  rightEye.setBusClock(100000);

  // MOUTH — hardware I2C on A4/A5
  if (mouth.begin()) {
    oledOk |= MOUTH;
  } else {
    reportError("mouth fail");
  }
  // I2C address 0x3C (default for many OLEDs)
  mouth.setI2CAddress(0x3C * 2);
  mouth.setBusClock(100000);

  lastHeartbeat = millis();
  lastDisplay   = millis();

  char boot[20];
  snprintf_P(boot, sizeof(boot), PSTR("oled L%c R%c M%c"),
             (oledOk & EYE_LEFT)  ? '1' : '-',
             (oledOk & EYE_RIGHT) ? '1' : '-',
             (oledOk & MOUTH)     ? '1' : '-');
  sendLog("info", boot);

  // First frame: open eyes ( > and < ), neutral mouth
  drawEye(leftEye,  1, 0, false, true);
  drawEye(rightEye, 1, 0, false, false);
  drawMouth(1, 0);
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

  // 4. Face refresh every 250 ms.
  //    Both eyes (software I2C) plus the mouth (hardware I2C) redraw in one
  //    tick. If the soft bus starves pollSerial(), raise DISPLAY_MS.
  if (now - lastDisplay >= DISPLAY_MS) {
    lastDisplay = now;
    updateFace(now);
  }
}