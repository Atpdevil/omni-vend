# OmniVend - Token Balance Terminal

RFID-based vending machine card management system with real-time Arduino serial link.

## Setup

1. Install dependencies:
   ```
   npm install
   ```

2. Create a `.env` file (or copy the example):
   ```
   copy .env.example .env
   ```

3. Find your Arduino's COM port and set it in `.env`:
   ```
   SERIAL_PORT=COM5
   BAUD_RATE=9600
   ```

4. Start the server:
   ```
   npm start
   ```

The server runs on **http://localhost:3000**.

If the Arduino is not plugged in, the server starts normally and logs a warning.
You can still use the web dashboard for card lookup and recharge.

## Finding your Arduino COM port on Windows

1. Plug in the Arduino Mega via USB
2. Open **Device Manager** (press Win+X, select Device Manager)
3. Expand **Ports (COM & LPT)**
4. Look for **Arduino Mega 2560** or **USB-SERIAL CH340** -- the port
   number is shown in parentheses, e.g. **COM5**
5. Put that value in your `.env` file as `SERIAL_PORT=COM5`

You can also check in the Arduino IDE under **Tools > Port**.

## Arduino serial protocol

The server expects the Arduino to send lines in this format:

```
TAP:<card_uid>\n
```

For example: `TAP:3E300002\n`

The server replies with one of:

```
GRANTED:<new_balance>\n
DENIED:<current_balance>\n
```

## Project structure

```
omni-vend/
  server/
    index.js       Express server, serial port, REST API
    db.js          SQLite setup (cards + transactions tables)
  public/
    index.html     Single-page app (3 views)
    style.css      Dark UI styles
    app.js         Frontend logic
    favicon.svg    Favicon
  .env             Serial port config (not committed)
  .env.example     Template for .env
```

## API

| Method | Endpoint                   | Body         | Response                                       |
|--------|----------------------------|--------------|-------------------------------------------------|
| GET    | `/api/card/:id`            |              | `{ card_id, balance }`                          |
| POST   | `/api/card/:id/recharge`   | `{ amount }` | `{ card_id, balance }`                          |
| POST   | `/api/card/:id/tap`        |              | `{ status: "granted"\|"low_balance", balance }` |
| GET    | `/api/transactions`        |              | Last 20 taps, newest first                      |

## Seed cards

Five cards are pre-loaded with Rs.100 each:

`3E300002`, `C1971307`, `D2A10202`, `0E810202`, `EB940102`

## Configuration

Edit the constants at the top of `server/index.js`:

- `ITEM_PRICE` -- rupees deducted per tap (default: 20)
- `STARTING_BALANCE` -- balance for seed cards (default: 100)
- `PORT` -- server port (default: 3000)
