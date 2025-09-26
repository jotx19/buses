from flask import Flask
import requests
from google.transit import gtfs_realtime_pb2
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

app = Flask(__name__)

# === CONFIGURATION ===
SUBSCRIPTION_KEY = "8a108b0bd4f140ccabb60b6a431673e5"  # Replace with your key if needed
STOP_ID = 1095
BUS_NUMBER = "68"
DEFAULT_PORT = 5001
OC_TRANSPO_URL = "https://nextrip-public-api.azure-api.net/octranspo/gtfs-rt-tp/beta/v1/TripUpdates"
OTTAWA_TZ = ZoneInfo("America/Toronto")

# === ROUTE ===
@app.route("/next_bus", methods=["GET"])
def get_next_two_buses():
    headers = {
        "Ocp-Apim-Subscription-Key": SUBSCRIPTION_KEY,
        "Cache-Control": "no-cache"
    }

    try:
        # Fetch GTFS Realtime Trip Updates (protobuf)
        response = requests.get(OC_TRANSPO_URL, headers=headers)
        response.raise_for_status()
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(response.content)

        now_utc = datetime.now(timezone.utc)
        arrivals = []

        # Collect all upcoming arrivals for this bus at this stop
        for entity in feed.entity:
            trip_update = entity.trip_update
            if not trip_update or trip_update.trip.route_id != BUS_NUMBER:
                continue
            for stop_time in trip_update.stop_time_update:
                if int(stop_time.stop_id) == STOP_ID and stop_time.arrival:
                    arrival_utc = datetime.fromtimestamp(stop_time.arrival.time, tz=timezone.utc)
                    if arrival_utc >= now_utc:
                        arrivals.append(arrival_utc.astimezone(OTTAWA_TZ))

        if not arrivals:
            return "No upcoming 68 bus arrivals at this stop"

        # Sort and pick the first two arrivals
        arrivals.sort()
        next_two = arrivals[:2]

        # Return as human-readable 12-hour format string
        if len(next_two) == 1:
            return f"Next 68 bus at stop {STOP_ID} arrives at {next_two[0].strftime('%I:%M %p')}"
        else:
            return (f"Next 68 buses at stop {STOP_ID} arrive at "
                    f"{next_two[0].strftime('%I:%M %p')} and {next_two[1].strftime('%I:%M %p')}")

    except Exception as e:
        return f"Error: {e}"

if __name__ == "__main__":
    print(f"Starting Flask server on port {DEFAULT_PORT}...")
    app.run(host="0.0.0.0", port=DEFAULT_PORT)
