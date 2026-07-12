package main

import (
	"encoding/json"
	"net/http"
	"os"
	"strconv"
)

const (
	DefaultRadiusM  = 500.0
	DefaultNearbyN  = 12
	DefaultArrivalN = 2
	DefaultVehicleN = 20
	VehicleRadiusM  = 1200.0
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeText(w http.ResponseWriter, status int, text string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_, _ = w.Write([]byte(text))
}

func parseLocation(r *http.Request) (lat, lon float64, ok bool, errMsg string) {
	q := r.URL.Query()
	latStr, lonStr := q.Get("lat"), q.Get("lon")
	if latStr == "" || lonStr == "" {
		latStr = os.Getenv("HOME_LAT")
		lonStr = os.Getenv("HOME_LON")
	}
	if latStr == "" || lonStr == "" {
		return 0, 0, false, "missing lat/lon (allow location in the browser, or set HOME_LAT and HOME_LON)"
	}
	lat, err1 := strconv.ParseFloat(latStr, 64)
	lon, err2 := strconv.ParseFloat(lonStr, 64)
	if err1 != nil || err2 != nil {
		return 0, 0, false, "invalid lat/lon"
	}
	return lat, lon, true, ""
}

func parseRadius(r *http.Request, fallback float64) float64 {
	if s := r.URL.Query().Get("radius"); s != "" {
		if v, err := strconv.ParseFloat(s, 64); err == nil && v > 0 {
			return v
		}
	}
	return fallback
}

func apiNearbyHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := ensureStopsLoaded(); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	lat, lon, ok, errMsg := parseLocation(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": errMsg})
		return
	}
	radius := parseRadius(r, DefaultRadiusM)
	nearby := nearbyStops(lat, lon, radius)

	feed, err := fetchTripUpdates()
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	routes := nearbyRoutes(feed, nearby, DefaultNearbyN)
	writeJSON(w, http.StatusOK, map[string]any{
		"lat":       lat,
		"lon":       lon,
		"radius_m":  radius,
		"stop_count": len(nearby),
		"buses":     routes,
		"spoken":    speakNearby(routes, radius),
		"source":    "OC Transpo GTFS-RT TripUpdates",
	})
}

func apiBusHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	bus := r.URL.Query().Get("bus")
	if bus == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing bus query param"})
		return
	}

	feed, err := fetchTripUpdates()
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}

	if stopStr := r.URL.Query().Get("stop"); stopStr != "" {
		stopID, err := strconv.Atoi(stopStr)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid stop"})
			return
		}
		arrivals := arrivalsForStopRoute(feed, bus, stopID, DefaultArrivalN)
		writeJSON(w, http.StatusOK, map[string]any{
			"bus":      bus,
			"stop":     stopID,
			"arrivals": arrivals,
			"spoken":   speakArrivals(bus, arrivals),
			"source":   "OC Transpo GTFS-RT TripUpdates",
		})
		return
	}

	if err := ensureStopsLoaded(); err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		return
	}
	lat, lon, ok, errMsg := parseLocation(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": errMsg})
		return
	}
	radius := parseRadius(r, DefaultRadiusM)
	nearby := nearbyStops(lat, lon, radius)
	arrivals := arrivalsForRouteNearby(feed, bus, nearby, DefaultArrivalN)
	writeJSON(w, http.StatusOK, map[string]any{
		"bus":      bus,
		"lat":      lat,
		"lon":      lon,
		"radius_m": radius,
		"arrivals": arrivals,
		"spoken":   speakArrivals(bus, arrivals),
		"source":   "OC Transpo GTFS-RT TripUpdates",
	})
}

func apiVehiclesHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	lat, lon, ok, errMsg := parseLocation(r)
	if !ok {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": errMsg})
		return
	}
	radius := parseRadius(r, VehicleRadiusM)

	feed, err := fetchVehiclePositions()
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	vehicles := nearbyVehicles(feed, lat, lon, radius, DefaultVehicleN)
	writeJSON(w, http.StatusOK, map[string]any{
		"lat":      lat,
		"lon":      lon,
		"radius_m": radius,
		"vehicles": vehicles,
		"count":    len(vehicles),
		"source":   "OC Transpo GTFS-RT VehiclePositions",
	})
}

func siriNearbyHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := ensureStopsLoaded(); err != nil {
		writeText(w, http.StatusServiceUnavailable, "Sorry, bus stop data is unavailable right now.")
		return
	}
	lat, lon, ok, errMsg := parseLocation(r)
	if !ok {
		writeText(w, http.StatusBadRequest, "Sorry, "+errMsg+".")
		return
	}
	radius := parseRadius(r, DefaultRadiusM)
	nearby := nearbyStops(lat, lon, radius)
	feed, err := fetchTripUpdates()
	if err != nil {
		writeText(w, http.StatusBadGateway, "Sorry, I could not reach OC Transpo right now.")
		return
	}
	routes := nearbyRoutes(feed, nearby, DefaultNearbyN)
	writeText(w, http.StatusOK, speakNearby(routes, radius))
}

func siriBusHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	bus := r.URL.Query().Get("bus")
	if bus == "" {
		writeText(w, http.StatusBadRequest, "Sorry, I need a bus number. Try saying a route like 68.")
		return
	}
	feed, err := fetchTripUpdates()
	if err != nil {
		writeText(w, http.StatusBadGateway, "Sorry, I could not reach OC Transpo right now.")
		return
	}

	if stopStr := r.URL.Query().Get("stop"); stopStr != "" {
		stopID, err := strconv.Atoi(stopStr)
		if err != nil {
			writeText(w, http.StatusBadRequest, "Sorry, that stop number looks invalid.")
			return
		}
		writeText(w, http.StatusOK, speakArrivals(bus, arrivalsForStopRoute(feed, bus, stopID, DefaultArrivalN)))
		return
	}

	if err := ensureStopsLoaded(); err != nil {
		writeText(w, http.StatusServiceUnavailable, "Sorry, bus stop data is unavailable right now.")
		return
	}
	lat, lon, ok, errMsg := parseLocation(r)
	if !ok {
		writeText(w, http.StatusBadRequest, "Sorry, "+errMsg+".")
		return
	}
	radius := parseRadius(r, DefaultRadiusM)
	nearby := nearbyStops(lat, lon, radius)
	writeText(w, http.StatusOK, speakArrivals(bus, arrivalsForRouteNearby(feed, bus, nearby, DefaultArrivalN)))
}
