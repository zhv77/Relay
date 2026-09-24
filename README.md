# Relay

Relay is a Windows desktop companion for Warframe inventory and trading.

## Features

- Reads inventory data locally from the running Warframe client using read-only access.
- Shows mastery progress, set completion, relics, and syndicate offerings.
- Uses warframe.market prices to compare sales, costs, and trading opportunities.
- Reads and manages your own warframe.market orders after you sign in.
- Keeps inventory snapshots locally and updates the app from public GitHub releases.

Inventory recovery can be incomplete because the game keeps the source data in memory only briefly. Relay labels estimates based on the latest recovered snapshot.

## Install

1. Download the latest Windows ZIP from [Releases](https://github.com/zhv77/Relay/releases/latest).
2. Extract the ZIP.
3. Run the setup executable.

The installer is currently unsigned, so Windows may show an unknown-publisher warning.

## Run from source

Install [Node.js](https://nodejs.org/), then run:

```powershell
npm ci
npm start
```

Use `npm test` for the automated checks and `npm run build:win` to create a Windows installer.

Relay is an independent community project and is not affiliated with Digital Extremes.
