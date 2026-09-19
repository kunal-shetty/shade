// Arduino Motor Control and Sensor Node
// Target: Arduino Uno/Nano/Mega connected via USB to Raspberry Pi

#include <ArduinoJson.h> // Install "ArduinoJson" from Library Manager

// --- Pin Definitions (Your configuration) ---
const int in1 = 8;
const int in2 = 9;
const int in3 = 10;
const int in4 = 11;
// Since you didn't specify Enable pins, we'll assume they are connected to 5V
// or we'll use these pins directly.

// Door Sensor
const int REED_PIN = 2;

void setup() {
  // Set baud rate to 115200 to match the Raspberry Pi gateway.py
  Serial.begin(115200);

  // Setup Motor Pins
  pinMode(in1, OUTPUT);
  pinMode(in2, OUTPUT);
  pinMode(in3, OUTPUT);
  pinMode(in4, OUTPUT);

  // Setup Sensor Pin
  pinMode(REED_PIN, INPUT_PULLUP);

  stopMotors();
}

void loop() {
  // 1. Check for commands from Raspberry Pi
  if (Serial.available() > 0) {
    String command = Serial.readStringUntil('\n');
    command.trim();

    if (command == "FORWARD") moveForward();
    else if (command == "BACKWARD") moveBackward();
    else if (command == "LEFT") moveLeft();
    else if (command == "RIGHT") moveRight();
    else if (command == "STOP") stopMotors();
  }

  // 2. Send Sensor Data to Pi (Every 2 seconds)
  static unsigned long lastHeartbeat = 0;
  if (millis() - lastHeartbeat > 2000) {
    lastHeartbeat = millis();

    // Door Sensor Reading
    bool isOpen = (digitalRead(REED_PIN) == HIGH);

    // Format: {"topic": "sensor/door", "value": {"open": true/false}}
    StaticJsonDocument<128> doc;
    doc["topic"] = "sensor/door";
    JsonObject val = doc.createNestedObject("value");
    val["open"] = isOpen;

    serializeJson(doc, Serial);
    Serial.println(); // End line for Pi to detect

    // Health Heartbeat: {"topic": "device/health", "value": {"arduino_door": "online"}}
    StaticJsonDocument<128> healthDoc;
    healthDoc["topic"] = "device/health";
    JsonObject hVal = healthDoc.createNestedObject("value");
    hVal["arduino_door"] = "online";

    serializeJson(healthDoc, Serial);
    Serial.println();
  }
}

// --- Motor Movement Functions ---
void moveForward() {
  digitalWrite(in1, HIGH); digitalWrite(in2, LOW);
  digitalWrite(in3, HIGH); digitalWrite(in4, LOW);
}

void moveBackward() {
  digitalWrite(in1, LOW); digitalWrite(in2, HIGH);
  digitalWrite(in3, LOW); digitalWrite(in4, HIGH);
}

void moveLeft() {
  digitalWrite(in1, LOW); digitalWrite(in2, HIGH);
  digitalWrite(in3, HIGH); digitalWrite(in4, LOW);
}

void moveRight() {
  digitalWrite(in1, HIGH); digitalWrite(in2, LOW);
  digitalWrite(in3, LOW); digitalWrite(in4, HIGH);
}

void stopMotors() {
  digitalWrite(in1, LOW); digitalWrite(in2, LOW);
  digitalWrite(in3, LOW); digitalWrite(in4, LOW);
}
