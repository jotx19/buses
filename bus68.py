#1044,0717,CONSTELLATION / GEMINI,,,45.349435,-75.765633,,,0,,,,,
#1095,0718,CONSTELLATION / GEMINI,,,45.348925,-75.765077,,,0,,,,,

import requests
from google.transit import gtfs_realtime_pb2
from datetime import datetime

# Replace with your subscription key
SUBSCRIPTION_KEY = "8a108b0bd4f140ccabb60b6a431673e5"

URL = "https://nextrip-public-api.azure-api.net/octranspo/gtfs-rt-tp/beta/v1/TripUpdates"

def fetch_route_68_updates():
    headers = {
        "Cache-Control": "no-cache",
        "Ocp-Apim-Subscription-Key": SUBSCRIPTION_KEY,
    }

    response = requests.get(URL, headers=headers)
    if response.status_code != 200:
        print("Failed to fetch feed:", response.status_code)
        return

    feed = gtfs_realtime_pb2.FeedMessage()
    feed.ParseFromString(response.content)

    for entity in feed.entity:
        if entity.HasField('trip_update'):
            trip = entity.trip_update
            route_id = trip.trip.route_id

            # Only process Route 68
            if route_id != "68":
                continue

            trip_id = trip.trip.trip_id
            start_time = trip.trip.start_time
            start_date = trip.trip.start_date
            print(f"Trip ID: {trip_id}, Route: {route_id}, Start: {start_date} {start_time}")
            
            for stop_time_update in trip.stop_time_update:
                stop_id = stop_time_update.stop_id
                arrival = stop_time_update.arrival.time if stop_time_update.HasField('arrival') else None
                departure = stop_time_update.departure.time if stop_time_update.HasField('departure') else None
                arrival_str = datetime.fromtimestamp(arrival).strftime("%Y-%m-%d %H:%M:%S") if arrival else "N/A"
                departure_str = datetime.fromtimestamp(departure).strftime("%Y-%m-%d %H:%M:%S") if departure else "N/A"
                print(f"  Stop: {stop_id}, Arrival: {arrival_str}, Departure: {departure_str}")
            print("-" * 50)

if __name__ == "__main__":
    fetch_route_68_updates()


