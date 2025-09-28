from flask import Flask, render_template, request
import requests
from google.transit import gtfs_realtime_pb2
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

app = Flask(__name__)

# === CONFIGURATION ===
SUBSCRIPTION_KEY = "8a108b0bd4f140ccabb60b6a431673e5"
DEFAULT_STOP_ID = 1095
DEFAULT_BUS_NUMBER = "68"
OC_TRANSPO_URL = "https://nextrip-public-api.azure-api.net/octranspo/gtfs-rt-tp/beta/v1/TripUpdates"
OTTAWA_TZ = ZoneInfo("America/Toronto")


@app.route("/")
def home():
    return render_template("interface.html")


@app.route("/next_bus")
def get_next_two_buses():
    bus_number = request.args.get("bus", DEFAULT_BUS_NUMBER)
    stop_id = int(request.args.get("stop", DEFAULT_STOP_ID))

    headers = {
        "Ocp-Apim-Subscription-Key": SUBSCRIPTION_KEY,
        "Cache-Control": "no-cache"
    }

    try:
        response = requests.get(OC_TRANSPO_URL, headers=headers)
        response.raise_for_status()
        feed = gtfs_realtime_pb2.FeedMessage()
        feed.ParseFromString(response.content)

        now_local = datetime.now(OTTAWA_TZ)
        arrivals = []

        for entity in feed.entity:
            trip_update = entity.trip_update
            if not trip_update or trip_update.trip.route_id != bus_number:
                continue
            for stop_time in trip_update.stop_time_update:
                if int(stop_time.stop_id) == stop_id and stop_time.arrival:
                    arrival_utc = datetime.fromtimestamp(stop_time.arrival.time, tz=timezone.utc)
                    arrival_local = arrival_utc.astimezone(OTTAWA_TZ)
                    if arrival_local >= now_local:
                        arrivals.append(arrival_local)

        arrivals.sort()
        next_two = arrivals[:2]

        def format_arrival(arrival_time):
            minutes = int((arrival_time - now_local).total_seconds() // 60)
            return {
                "time": arrival_time.strftime("%I:%M %p"),
                "minutes": minutes
            }

        formatted = [format_arrival(a) for a in next_two]

        return render_template("bus.html", buses=formatted, bus_number=bus_number, stop_id=stop_id)

    except Exception as e:
        return render_template("bus.html", error=str(e), bus_number=bus_number, stop_id=stop_id)
