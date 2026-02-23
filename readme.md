# OC Transpo Bus Tracker (Go)

This project is a Go web app that shows the next two arrival times for an OC Transpo bus at a given stop using the GTFS Realtime API.

It is a Go rewrite of a Flask app and supports:
- Query parameters for bus and stop: `/next_bus?bus=68&stop=1095`
- Automatic loading of an API key from a `.env` file
- Simple HTML UI using Go templates

---

## Features

- Fetches live GTFS Realtime data from OC Transpo
- Filters by route (bus number) and stop ID
- Shows the next two upcoming arrivals
- Uses environment variables for the API key
- Simple web interface
- Works locally and can be used from Apple Shortcuts

---

## Requirements

- Go 1.20+ (Go 1.22 recommended)
- An OC Transpo API subscription key

---

## Project Structure
