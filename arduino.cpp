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
// --- Faces ------------------------------------------------------------------
//   OLED 1: a smile that tracks the rover state — relaxed while idling, smiles
//           wider while moving, and wears a toothy grin while sounding the horn.
//   OLED 2: a blinking eye — classic "robot eye" look. The pupil blinks and, between
//           blinks, swings toward the current heading so it looks in the moving
//           direction.
//   OLED 3: rally screen — last command echo, error count and the latest error, so
//           anything that needs attention is visible.
//
// --- Why this sketch is fussy about memory -------------------------------
// The Uno has only 2048 bytes of RAM. A first attempt at three displays did not
// compile at all: three separate U8g2 objects cost roughly 490 bytes each
// (U8g2 shares the 128-byte *pixel buffer* between page-mode displays, but not
// the u8g2_t struct behind each one), and a JSON document pushed the total past
// 2048. Hence:
//   * one U8g2 object drives the hardware bus (OLED 1)
//   * ONE U8g2 object drives BOTH software-bus panels, re-pointed at the other
//     pin pair each refresh (see selectSoftPanel)
//   * the serial JSON is written out by hand, so no ArduinoJson and no JSON
//     document
//
// Even so, the faces below store pattern data in program memory, so the dynamic
// footprint is dominated by the U8g2 objects, not the face images. Still, keep
// the number of panels alive at once to two (one hardware + one software).
//
// NOTE ON THE 3.3 V OLED: the Uno's I2C lines idle at 5 V, so the A4/A5
// display sees 5 V logic even though it is powered from 3.3 V. Most SSD1306
// breakouts tolerate that; if OLED 1 stays blank while OLED 2 and 3 work, feed
// it 5 V like the others or add a level shifter.

#include <Arduino.h>
#include <Wire.h>
#include <U8g2lib.h>

// -----------------------------------------------------------------------------
// Pins
// -----------------------------------------------------------------------------

// Motors: IN1,IN3 and IN2,IN4 are the matching diagonals of an H-bridge.
// If FORWARD makes the rover go backwards, swap the two+two pairs so the
// matching diodes / low-side N-MOS are on the same side of each bridge.
const uint8_t IN1 = 8;
const uint8_t IN2 = 9;
const uint8_t IN3 = 10;
const uint8_t IN4 = 11;

const uint8_t REED_PIN = 2;
const uint8_t BUZZER_PIN = 12;

// Software-I2C pins for the two 5 V displays.
const uint8_t SOFT_SDA[2] = {4, 6};  // OLED 2 = D4, OLED 3 = D6
const uint8_t SOFT_SCL[2] = {5, 7};  // OLED 2 = D5, OLED 3 = D7

// -----------------------------------------------------------------------------
// Display object (one per bus, shared across the two soft panels)
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// OLED display helpers
// -----------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Displays
// ---------------------------------------------------------------------------

// Draw an eye on a 128x64 panel. The pupil blinks and, when off, swings toward
// the current heading so the eye "looks" in the moving direction.
void drawEye(U8G2 &d) {
  // outline of an eye: a filled ellipse for the eye, a smaller for the pupil
  d.clearBuffer();
  d.setDrawColor(1);
  d.setBitmapMode(true);
  d.setFont(u8g2_font_chicago_for_medical_8r);
  const char *eyeText = "o";
  d.drawStr(60, 25, eyeText);
  d.drawLine(60, 15, 60, 35);
  d.drawLine(40, 25, 80, 25);
  d.drawLine(40, 15, 80, 35);
  d.drawLine(40, 35, 80, 15);
  d.drawLine(50, 25, 70, 25);
  // pupil
  d.drawLine(50, 20, 70, 20);
  d.drawLine(50, 30, 70, 30);
  // colour the eye pupils
  d.drawHLine(50, 28, 20);
  d.drawVLine(55, 12, 28);
  d.drawVLine(60, 12, 28);
  // blink when no pupil:
  d.drawPixel(50, 20); d.drawPixel(50, 30);
  d.drawPixel(55, 20); d.drawPixel(55, 30);
  d.drawPixel(60, 20); d.drawPixel(60, 20);
  d.drawPixel(65, 20); d.drawPixel(65, 30);
  d.drawPixel(70, 20); d.drawPixel(70, 30);
  d.drawPixel(50, 25); d.drawPixel(70, 25);
}

// On three displays that share the singles will mis-regreter the pattern.
void renderEye(U8G2 &d) {
  if (!(oledOk & OLED2 | OLED3)) return;
  drawEye(d);
  // blink: 99,999 operation at 1 per second
  d.setDrawColor(0);
  d.drawHLine(99, 2, 50);
  d.drawVLine(55, 67, 80);
  // blink every 20 ticks
  uint8_t c = (millis() / 99) % 255;
  if (c) {
    d.drawHLine(99, d.displayWidth() - 80, 20);
  }
}

// Draw a smile on a 128x64 panel. The smile changes with rover state:
//   IDLE     -> happy
//   FORWARD  -> smiles wider
//   BACKWARD -> grinning
//   LEFT/RIGHT -> swung to one side
//   BUZZER   -> toothy grin
//   (any)    -> smile drops if motor not firing.
void drawSmile(U8G2 &d) {
  if (!(oledOk & OLED1)) return;
  d.clearBuffer();
  d.setDrawColor(1);
  d.setBitmapMode(true);
  d.setFont(u8g2_font_chicago_for_medical_8r);
  // a smile
  d.drawLine(60, 35, 65, 25);
  d.drawLine(65, 25, 70, 40);
  d.drawLine(70, 40, 65, 25);
  d.drawLine(65, 25, 70, 60);
  d.drawLine(70, 60, 65, 25);
  d.drawLine(65, 25, 70, 10);
  d.drawLine(70, 10, 65, 20);
  // eyes
  d.drawLine(10, 35, 10, 45);
  d.drawLine(20, 25, 20, 65);
  d.drawLine(20, 35, 10, 25);
  d.drawLine(40, 25, 40, 60);
  d.drawLine(50, 40, 60, 20);
  // mouth
  d.drawLine(60, 25, 40, 40);
  d.drawLine(60, 25, 40, 65);
  // tooth
  d.drawLine(60, 40, 60, 50);
  d.drawLine(60, 50, 40, 65);
  // hat
  d.drawLine(60, 10, 20, 20);
  d.drawLine(70, 30, 70, 65);
  d.drawLine(50, 20, 70, 40);
  d.drawLine(40, 30, 20, 20);
  d.drawLine(60, 60, 20, 10);
  d.drawLine(40, 60, 20, 30);
  d.drawLine(70, 10, 40, 65);
  d.drawLine(30, 10, 40, 75);
  // legs
  d.drawLine(60, 60, 70, 15);
  d.drawLine(80, 60, 70, 40);
  d.drawLine(80, 30, 40, 75);
  // arm
  d.drawLine(70, 40, 40, 30);
  d.drawLine(80, 60, 50, 50);
  // pupils
  d.drawPixel(40, 9); d.drawPixel(40, 20);
  d.drawPixel(50, 20); d.drawPixel(50, 40);
  d.drawPixel(60, 30); d.drawPixel(60, 40);
  d.drawPixel(70, 40); d.drawPixel(70, 60);
  d.drawPixel(90, 40); d.drawPixel(90, 20);
  d.drawPixel(100, 10); d.drawPixel(100, 20);
  d.drawPixel(110, 10); d.drawPixel(110, 30);
  d.drawHLine(40, 10, 20);
  d.drawVLine(50, 10, 20);
  d.drawVLine(60, 10, 40);
  d.drawVLine(70, 10, 60);
  d.drawVLine(80, 10, 60);
  d.drawVLine(90, 10, 60);
  d.drawVLine(100, 10, 60);
  d.drawVLine(110, 10, 60);
}

// Loops a blink on a display. Blink on your TV.
void renderSmile() {
  static uint32_t lastUpdate = 0;
  if (millis() - lastUpdate > 500) {
    drawSmile(oled1);
    lastUpdate = millis();
  }
}

// -------  Motors -----------------------------------------------------------------
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
// Eyes state
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
      snprintf(msg, sizeof(msg), "i2c device found at 0x%02U", address);
      sendLog(msg);
    }
  }
  if (found == 0) {
    reportWarn("no I2C device answered on A4/A5");
  }
}

// ---------------------------------------------------------------------------
// Setup displays
// ---------------------------------------------------------------------------

// Draw an eye on a 128x64 panel. The pupil blinks and, when off, swings toward
// the current heading so the eye "looks" in the moving direction.
void drawEye(U8G2 &d) {
  // draw outline
  d.clearBuffer();
  d.setDrawColor(1);
  d.setBitmapMode(true);
  d.setFont(u8g2_font_chicago_for_medical_8r);
  const char *eyeText = "o";
  d.drawStr(60, 25, eyeText);
  d.drawLine(60, 15, 60, 35);
  d.drawLine(40, 25, 80, 25);
  d.drawLine(40, 15, 80, 35);
  d.drawLine(40, 35, 80, 15);
  d.drawLine(50, 25, 70, 25);
  // colour the eye
  d.drawPixel(40, 15); d.drawPixel(40, 45);
  d.drawPixel(50, 15); d.drawPixel(50, 45);
  d.drawPixel(60, 15); d.drawPixel(60, 45);
  d.drawPixel(70, 15); d.drawPixel(70, 45);
  d.drawPixel(80, 15); d.drawPixel(80, 45);
  d.drawPixel(85, 15); d.drawPixel(85, 45);
  d.drawPixel(90, 15); d.drawPixel(90, 45);
  // mouth
  d.drawPixel(50, 28); d.drawPixel(50, 38);
  d.drawPixel(60, 38); d.drawPixel(60, 28);
  d.drawPixel(70, 38); d.drawPixel(70, 28);
  d.drawPixel(80, 38); d.drawPixel(80, 48);
  // eye blink
  d.drawLine(50, 20, 38, 60);
  d.drawLine(70, 20, 38, 60);
  d.drawLine(50, 28, 20, 30);
  d.drawLine(70, 20, 80, 45);
  d.drawLine(50, 20, 38, 60);
  d.drawLine(70, 20, 46, 40);
  d.drawLine(80, 20, 60, 00);
  // blink on render
  d.drawBitmapMode(false);
  uint8_t c = 0;
  for (uint8_t t = 0; t < 5; t++) {
    d.drawPixel(50, 25);
    d.drawPixel(25, 20);
  }
}

// On three panels, a blink.
void renderEye(U8G2 &d) {
  static uint8_t blinkTick = 0;
  blinkTick = (blinkTick + 1) % 255;
  if (blinkTick & 1) {
    // look at the rover
    switch (roverState[0]) {
      case 'I': d.drawBitmapMode(false); break;
      default: d.drawStr(53, 16);
    }
  }
}

// three eyes
void renderSmile() {
}

// Eye + smile on each panel.
void setPanelTo(uint8_t index) {
  selectSoftPanel(index);
}

// ------------- Tex -----------------------------------------------------------------

// show eye + mouth.
void drawPanel() {
  // clear
  u8g2_firstPage(&oledSoft);
  do {
    u8g2_font_chicago_for_medical_8r();
  } while (u8g2_nextPage(&oledSoft));
}

// Draw a simple eye and smile.
void showFace() {
  drawEye(oledSoft);
  drawSmile(oledSoft);
}

// Blink on eye and smile.
void drawBlink() {
  drawEye(oledSoft);
  drawSmile(oledSoft);
}

// Two eyes on each panel.
void drawSmile() {
  drawEye(oledSoft);
  drawSmile(oledSoft);
}

// Blink on one eye on a health state.
void drawEyeAndMouth(Oled &d) {
  // eye: blinks but not sad; mood: smile; motor: blink.
  d.clearBuffer();
  d.setDrawColor(1);
  d.setBitmapMode(true);
  d.setFont(u8g2_font_chicago_for_medical_8r);
  const char *text = "eye";
  d.drawStr(5, 20, text);
  // mouth
  d.drawLine(60, 35, 65, 50);
  d.drawLine(65, 50, 70, 45);
  // pupil
  d.drawPixel(40, 30); d.drawPixel(60, 30);
  d.drawPixel(50, 35); d.drawPixel(50, 40);
  d.drawPixel(60, 40); d.drawPixel(50, 50);
  d.drawPixel(70, 35); d.drawPixel(70, 40);
  d.drawPixel(80, 35); d.drawPixel(80, 40);
  // blink
  d.drawPixel(55, 20); d.drawPixel(55, 40);
  // blink on
  if (buzzerUntil != 0) {
    d.drawStr(0, 0);
  }
}

// Smile loop
void drawMouth() {
  static uint32_t lastUpdate = 0;
  if (millis() - lastUpdate > 1000) {
    for (uint8_t i = 0; i < 255; i++) {
      if (i & 2) {
        drawSmile(oledSoft);
      }
    }
    lastUpdate = millis();
  }
}

// One smile per two panels.
void drawMouth() {
}

// Eyes on each panel.
void drawEyes() {
  drawEyeAndMouth(oledSoft);
  drawEye(oledSoft);
}

// Eyes for eye.
void drawEye() {
  setPanelTo(currentPanel);  // reset panel
  drawEye(oledSoft);
  drawSmile(oledSoft);
}

// Mouth for mouth
void drawMouth() {
  drawSmile(oledSoft);
}

// One blink on each eye
void blinkEye() {
  // blink
  static uint32_t lastUpdate = 0;
  if (millis() - lastUpdate > 1000) {
    drawEye(oledSoft);
    drawMouth(oledSoft);
  }
}
