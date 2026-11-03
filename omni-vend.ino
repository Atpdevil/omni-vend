/*
  Offline RFID Vending Machine - v3
  Board : Arduino Mega 2560
  Libraries: MFRC522, Keypad, Wire (built-in), LiquidCrystal_I2C

  FLOW
  1. Idle: LCD shows "Vending Machine" / "Ready - Tap Card"
  2. Card tapped -> UID sent to laptop backend as "TAP:<uid>"
     - "INVALID"     -> card was never registered -> show Invalid Card
     - "OK:<balance>"-> card is registered -> show balance, ask to
                        select an item (keypad 1-9)
  3. Customer presses a key (e.g. "1") -> Arduino sends
     "SELECT:<uid>:<item>" to the backend
     - "DISPENSED:<balance>" -> motor spins 5 seconds, item drops,
                                 LCD shows "Item Dispensed" + balance
     - "LOWBAL:<balance>"    -> LCD shows "Low Balance" + balance left
     - "UNAVAILABLE"         -> that item slot has no motor yet
  4. Back to idle

  No LEDs, no buzzer, no local balance logic - everything about
  money lives on the laptop backend. This board only reads, asks,
  and displays.

  PIN MAP
  RC522   : SDA(SS)=53, SCK=52, MOSI=51, MISO=50, RST=5, 3.3V, GND
  L298N   : IN1=8, IN2=9, ENA=10 (PWM)
  LCD     : I2C - SDA=20, SCL=21 (Mega hardware I2C pins), address 0x27
  Keypad  : Rows = 22,23,24,25   Cols = 26,30,28,29
*/

#include <SPI.h>
#include <MFRC522.h>
#include <Wire.h>
#include <LiquidCrystal_I2C.h>
#include <Keypad.h>

#define SS_PIN  53
#define RST_PIN 5
#define IN1     8
#define IN2     9
#define ENA     10

#define MOTOR_SPEED      100
#define DISPENSE_TIME    5000   // 5 seconds, as requested
#define RESPONSE_TIMEOUT 4000   // ms to wait for the PC's reply
#define SELECT_TIMEOUT   10000  // ms to wait for a keypad press after tap

MFRC522 rfid(SS_PIN, RST_PIN);
LiquidCrystal_I2C lcd(0x27, 16, 2);

const byte ROWS = 4, COLS = 4;
char keys[ROWS][COLS] = {
  {'1', '2', '3', 'A'},
  {'4', '5', '6', 'B'},
  {'7', '8', '9', 'C'},
  {'*', '0', '#', 'D'}
};
byte rowPins[ROWS] = {22, 23, 24, 25};
byte colPins[COLS] = {26, 30, 28, 29};   // updated per current wiring
Keypad keypad = Keypad(makeKeymap(keys), rowPins, colPins, ROWS, COLS);

void setup() {
  Serial.begin(9600);
  SPI.begin();
  rfid.PCD_Init();

  pinMode(IN1, OUTPUT);
  pinMode(IN2, OUTPUT);
  pinMode(ENA, OUTPUT);
  stopMotor();

  Wire.begin();
  lcd.init();
  lcd.backlight();

  showIdle();
}

void loop() {
  if (!rfid.PICC_IsNewCardPresent()) return;
  if (!rfid.PICC_ReadCardSerial()) return;

  String uid = getUIDString();

  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Checking card...");

  Serial.print("TAP:");
  Serial.println(uid);

  String response = waitForResponse();

  if (response.length() == 0) {
    showMessage("No connection", "Check laptop");
  } else if (response.equalsIgnoreCase("INVALID")) {
    showMessage("Invalid Card", "Not registered");
  } else if (response.startsWith("OK:")) {
    int balance = response.substring(3).toInt();
    handleItemSelection(uid, balance);
  } else {
    showMessage("Unknown reply", response);
  }

  rfid.PICC_HaltA();
  rfid.PCD_StopCrypto1();
  delay(400);
  showIdle();
}

// Shows the balance and waits for the customer to pick an item,
// then sends the selection to the backend and shows the result.
void handleItemSelection(String uid, int balance) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Bal: Rs.");
  lcd.print(balance);
  lcd.setCursor(0, 1);
  lcd.print("Select item 1-9");

  char key = waitForKey(SELECT_TIMEOUT);

  if (key == 0) {
    showMessage("Timeout", "No item chosen");
    return;
  }

  if (key < '1' || key > '9') {
    showMessage("Invalid key", "Use 1-9 only");
    return;
  }

  Serial.print("SELECT:");
  Serial.print(uid);
  Serial.print(":");
  Serial.println(key);

  String response = waitForResponse();

  if (response.length() == 0) {
    showMessage("No connection", "Check laptop");
  } else if (response.startsWith("DISPENSED:")) {
    int newBalance = response.substring(10).toInt();
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("Dispensing...");
    runMotor();
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("Item Dispensed");
    lcd.setCursor(0, 1);
    lcd.print("Bal: Rs.");
    lcd.print(newBalance);
    delay(2000);
  } else if (response.startsWith("LOWBAL:")) {
    int bal = response.substring(7).toInt();
    lcd.clear();
    lcd.setCursor(0, 0);
    lcd.print("Low Balance");
    lcd.setCursor(0, 1);
    lcd.print("Rs.");
    lcd.print(bal);
    lcd.print(" left");
    delay(2000);
  } else if (response.equalsIgnoreCase("UNAVAILABLE")) {
    showMessage("Slot not fitted", "Coming soon");
  } else if (response.equalsIgnoreCase("INVALID")) {
    showMessage("Invalid Card", "Not registered");
  } else {
    showMessage("Unknown reply", response);
  }
}

// ---------- Helpers ----------

String getUIDString() {
  String result = "";
  for (byte i = 0; i < rfid.uid.size; i++) {
    if (rfid.uid.uidByte[i] < 0x10) result += "0";
    result += String(rfid.uid.uidByte[i], HEX);
  }
  result.toUpperCase();
  return result;
}

// Blocks until a full line arrives from the PC, or times out.
String waitForResponse() {
  unsigned long start = millis();
  String line = "";
  while (millis() - start < RESPONSE_TIMEOUT) {
    if (Serial.available()) {
      char c = Serial.read();
      if (c == '\n') {
        line.trim();
        if (line.length() > 0) return line;
      } else {
        line += c;
      }
    }
  }
  return "";
}

// Waits up to timeoutMs for a keypad press. Returns 0 on timeout.
char waitForKey(unsigned long timeoutMs) {
  unsigned long start = millis();
  while (millis() - start < timeoutMs) {
    char key = keypad.getKey();
    if (key) return key;
  }
  return 0;
}

void runMotor() {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, HIGH);
  analogWrite(ENA, MOTOR_SPEED);
  delay(DISPENSE_TIME);
  stopMotor();
}

void stopMotor() {
  digitalWrite(IN1, LOW);
  digitalWrite(IN2, LOW);
  analogWrite(ENA, 0);
}

void showIdle() {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print("Vending Machine");
  lcd.setCursor(0, 1);
  lcd.print("Ready - Tap Card");
}

void showMessage(String line1, String line2) {
  lcd.clear();
  lcd.setCursor(0, 0);
  lcd.print(line1);
  lcd.setCursor(0, 1);
  lcd.print(line2);
  delay(1800);
}