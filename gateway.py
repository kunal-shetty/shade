import asyncio
import json
import serial  # Required for USB communication with Arduino
from fastapi import FastAPI
import uvicorn
from paho.mqtt import client as mqtt_client
import websockets

app = FastAPI()

# --- Configuration ---
MQTT_BROKER = "localhost"
MQTT_PORT = 1883
WS_PORT = 8765
API_PORT = 8000
# Standard Arduino USB ports on Pi are usually /dev/ttyUSB0 or /dev/ttyACM0
SERIAL_PORT = "/dev/ttyUSB0"
BAUD_RATE = 115200

# Global state to store latest sensor data for the API
latest_sensors = {}
device_health = {}
ser = None # Global serial object to allow send_motor_command to access it

# --- MQTT Setup ---
def on_message(client, userdata, msg):
    global latest_sensors, device_health
    topic = msg.topic
    try:
        payload = json.loads(msg.payload.decode())
        print(f"Topic: {topic} | Data: {payload}")

        if topic == "device/health":
            device_health.update(payload)
        else:
            latest_sensors[topic] = payload
    except Exception as e:
        print(f"Error parsing MQTT message: {e}")

mqtt_c = mqtt_client.Client()
mqtt_c.on_message = on_message

def start_mqtt():
    try:
        mqtt_c.connect(MQTT_BROKER, MQTT_PORT)
        mqtt_c.subscribe("sensor/#")
        mqtt_c.subscribe("device/health")
        mqtt_c.subscribe("rover/#")
        mqtt_c.subscribe("rfid/#")
        mqtt_c.loop_start()
        print("✅ MQTT Client Started")
    except Exception as e:
        print(f"❌ MQTT Connection Error: {e}")

# --- Motor Control Logic ---
def send_motor_command(x, y):
    """
    Translates joystick X, Y coordinates into Arduino commands.
    X: -1 (Left) to 1 (Right)
    Y: -1 (Down/Back) to 1 (Up/Forward)
    """
    global ser
    if ser is None:
        print("❌ Serial not connected. Cannot move motors.")
        return

    command = "STOP"

    # Thresholding for direction
    if y > 0.3:
        command = "FORWARD"
    elif y < -0.3:
        command = "BACKWARD"
    elif x > 0.3:
        command = "RIGHT"
    elif x < -0.3:
        command = "LEFT"
    else:
        command = "STOP"

    print(f"🕹️ Motor Command: {command}")
    ser.write(f"{command}\n".encode('utf-8'))

# --- Arduino Serial Reader (USB Translation) ---
async def read_arduino_serial():
    global ser
    print(f"🔌 Connecting to Arduino on {SERIAL_PORT}...")
    try:
        # Open serial connection
        ser = serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=1)
        print("✅ Arduino Connected via USB!")
        while True:
            line = ser.readline().decode('utf-8').strip()
            if line:
                print(f"Arduino: {line}")
                try:
                    data = json.loads(line)
                    topic = data.get("topic")
                    value = data.get("value")
                    if topic and value:
                        mqtt_c.publish(topic, json.dumps(value))
                except Exception:
                    mqtt_c.publish("arduino/raw", line)
            await asyncio.sleep(0.01)
    except Exception as e:
        print(f"❌ Serial Error: {e}. Ensure Arduino is plugged into USB and port is correct.")

# --- REST API Endpoints ---
@app.get("/health")
async def health():
    return {
        "status": "online",
        "devices": device_health,
        "uptime": "running"
    }

@app.get("/sensors/latest")
async def sensors():
    return latest_sensors

@app.get("/rover/status")
async def rover_status():
    return latest_sensors.get("rover/status", {"state": "idle", "battery": 100, "zone": "Unknown"})

@app.get("/incidents")
async def list_incidents():
    return []

# --- WebSocket Control Server ---
async def control_handler(websocket):
    print("🔌 App connected via WebSocket")
    try:
        async for message in websocket:
            data = json.loads(message)
            # Expecting data: { "x": 0.5, "y": -0.2 }
            x = data.get("x", 0)
            y = data.get("y", 0)

            # 1. Send to motors via USB
            send_motor_command(x, y)

            # 2. Also publish to MQTT for logging/other devices
            mqtt_c.publish("rover/cmd", json.dumps(data))
    except websockets.exceptions.ConnectionClosed:
        print("🔌 App disconnected")

async def start_ws_server():
    print(f"🚀 Starting WebSocket server on port {WS_PORT}...")
    async with websockets.serve(control_handler, "0.0.0.0", WS_PORT):
        await asyncio.Future() # Keep running

# --- Startup Logic ---
@app.on_event("startup")
async def startup_event():
    start_mqtt()
    # Run WebSocket server and USB reader in the background
    asyncio.create_task(start_ws_server())
    asyncio.create_task(read_arduino_serial())

if __name__ == "__main__":
    print(f"🌐 Starting Gateway API on port {API_PORT}...")
    uvicorn.run(app, host="0.0.0.0", port=API_PORT)
