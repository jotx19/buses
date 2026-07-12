package main

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"time"

	gtfs "github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
	"google.golang.org/protobuf/proto"
)

// OC Transpo GTFS-RT endpoints (Azure developer portal)
const (
	TripUpdatesURL      = "https://nextrip-public-api.azure-api.net/octranspo/gtfs-rt-tp/beta/v1/TripUpdates"
	VehiclePositionsURL = "https://nextrip-public-api.azure-api.net/octranspo/gtfs-rt-vp/beta/v1/VehiclePositions"
)

type Arrival struct {
	RouteID   string  `json:"route_id"`
	StopID    string  `json:"stop_id"`
	StopName  string  `json:"stop_name"`
	StopCode  string  `json:"stop_code,omitempty"`
	TimeText  string  `json:"time"`
	Minutes   int     `json:"minutes"`
	DistanceM float64 `json:"distance_m,omitempty"`
}

type NearbyRoute struct {
	RouteID   string  `json:"route_id"`
	StopID    string  `json:"stop_id"`
	StopName  string  `json:"stop_name"`
	StopCode  string  `json:"stop_code,omitempty"`
	DistanceM float64 `json:"distance_m"`
	Minutes   int     `json:"minutes"`
	TimeText  string  `json:"time"`
	Spoken    string  `json:"spoken,omitempty"`
}

type LiveVehicle struct {
	RouteID   string  `json:"route_id"`
	VehicleID string  `json:"vehicle_id,omitempty"`
	Lat       float64 `json:"lat"`
	Lon       float64 `json:"lon"`
	Bearing   float64 `json:"bearing,omitempty"`
	DistanceM float64 `json:"distance_m"`
	SpeedKmh  float64 `json:"speed_kmh,omitempty"`
	Updated   string  `json:"updated,omitempty"`
}

func fetchGTFSRT(url string) (*gtfs.FeedMessage, error) {
	subKey := os.Getenv("OCTRANSPO_SUBSCRIPTION_KEY")
	if subKey == "" {
		return nil, fmt.Errorf("missing OCTRANSPO_SUBSCRIPTION_KEY (set it in .env or export it)")
	}

	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Ocp-Apim-Subscription-Key", subKey)
	req.Header.Set("Cache-Control", "no-cache")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("OC Transpo API returned %s", resp.Status)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	feed := &gtfs.FeedMessage{}
	if err := proto.Unmarshal(body, feed); err != nil {
		return nil, fmt.Errorf("failed to parse GTFS-RT protobuf: %w", err)
	}
	return feed, nil
}

func fetchTripUpdates() (*gtfs.FeedMessage, error) {
	return fetchGTFSRT(TripUpdatesURL)
}

func fetchVehiclePositions() (*gtfs.FeedMessage, error) {
	return fetchGTFSRT(VehiclePositionsURL)
}

func arrivalsForStopRoute(feed *gtfs.FeedMessage, routeID string, stopID int, limit int) []Arrival {
	nowLocal := time.Now().In(ottawaLoc)
	stopStr := strconv.Itoa(stopID)
	times := make([]time.Time, 0, 8)

	for _, entity := range feed.Entity {
		tu := entity.TripUpdate
		if tu == nil || tu.Trip == nil || tu.Trip.RouteId == nil {
			continue
		}
		if *tu.Trip.RouteId != routeID {
			continue
		}
		for _, stu := range tu.StopTimeUpdate {
			if stu.StopId == nil || stu.Arrival == nil || stu.Arrival.Time == nil {
				continue
			}
			if *stu.StopId != stopStr {
				continue
			}
			arrivalLocal := time.Unix(*stu.Arrival.Time, 0).UTC().In(ottawaLoc)
			if !arrivalLocal.Before(nowLocal) {
				times = append(times, arrivalLocal)
			}
		}
	}

	sort.Slice(times, func(i, j int) bool { return times[i].Before(times[j]) })
	if limit > 0 && len(times) > limit {
		times = times[:limit]
	}

	stopName, stopCode := stopStr, ""
	if s, ok := getStop(stopStr); ok {
		stopName, stopCode = s.Name, s.Code
	}

	out := make([]Arrival, 0, len(times))
	for _, t := range times {
		out = append(out, Arrival{
			RouteID:  routeID,
			StopID:   stopStr,
			StopName: stopName,
			StopCode: stopCode,
			TimeText: t.Format("03:04 PM"),
			Minutes:  minutesUntil(nowLocal, t),
		})
	}
	return out
}

func nearbyRoutes(feed *gtfs.FeedMessage, nearby []NearbyStop, limit int) []NearbyRoute {
	nowLocal := time.Now().In(ottawaLoc)
	stopDist := make(map[string]NearbyStop, len(nearby))
	for _, s := range nearby {
		stopDist[s.ID] = s
	}

	best := map[string]NearbyRoute{}
	for _, entity := range feed.Entity {
		tu := entity.TripUpdate
		if tu == nil || tu.Trip == nil || tu.Trip.RouteId == nil {
			continue
		}
		routeID := *tu.Trip.RouteId
		for _, stu := range tu.StopTimeUpdate {
			if stu.StopId == nil || stu.Arrival == nil || stu.Arrival.Time == nil {
				continue
			}
			ns, ok := stopDist[*stu.StopId]
			if !ok {
				continue
			}
			arrivalLocal := time.Unix(*stu.Arrival.Time, 0).UTC().In(ottawaLoc)
			if arrivalLocal.Before(nowLocal) {
				continue
			}
			candidate := NearbyRoute{
				RouteID:   routeID,
				StopID:    ns.ID,
				StopName:  ns.Name,
				StopCode:  ns.Code,
				DistanceM: ns.DistanceM,
				Minutes:   minutesUntil(nowLocal, arrivalLocal),
				TimeText:  arrivalLocal.Format("03:04 PM"),
			}
			prev, exists := best[routeID]
			if !exists || betterNearby(candidate, prev) {
				best[routeID] = candidate
			}
		}
	}

	out := make([]NearbyRoute, 0, len(best))
	for _, r := range best {
		r.Spoken = fmt.Sprintf("Route %s at %s, next in %s", r.RouteID, speakStopName(r.StopName), speakMinutes(r.Minutes))
		out = append(out, r)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Minutes != out[j].Minutes {
			return out[i].Minutes < out[j].Minutes
		}
		return out[i].DistanceM < out[j].DistanceM
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func betterNearby(a, b NearbyRoute) bool {
	if a.Minutes != b.Minutes {
		return a.Minutes < b.Minutes
	}
	return a.DistanceM < b.DistanceM
}

func arrivalsForRouteNearby(feed *gtfs.FeedMessage, routeID string, nearby []NearbyStop, limit int) []Arrival {
	nowLocal := time.Now().In(ottawaLoc)
	stopDist := make(map[string]NearbyStop, len(nearby))
	for _, s := range nearby {
		stopDist[s.ID] = s
	}

	type hit struct {
		stop NearbyStop
		t    time.Time
	}
	hits := make([]hit, 0, 16)

	for _, entity := range feed.Entity {
		tu := entity.TripUpdate
		if tu == nil || tu.Trip == nil || tu.Trip.RouteId == nil {
			continue
		}
		if *tu.Trip.RouteId != routeID {
			continue
		}
		for _, stu := range tu.StopTimeUpdate {
			if stu.StopId == nil || stu.Arrival == nil || stu.Arrival.Time == nil {
				continue
			}
			ns, ok := stopDist[*stu.StopId]
			if !ok {
				continue
			}
			arrivalLocal := time.Unix(*stu.Arrival.Time, 0).UTC().In(ottawaLoc)
			if !arrivalLocal.Before(nowLocal) {
				hits = append(hits, hit{stop: ns, t: arrivalLocal})
			}
		}
	}
	if len(hits) == 0 {
		return nil
	}

	sort.Slice(hits, func(i, j int) bool {
		if !hits[i].t.Equal(hits[j].t) {
			return hits[i].t.Before(hits[j].t)
		}
		return hits[i].stop.DistanceM < hits[j].stop.DistanceM
	})
	chosenStop := hits[0].stop

	times := make([]time.Time, 0, 4)
	seen := map[int64]bool{}
	for _, h := range hits {
		if h.stop.ID != chosenStop.ID {
			continue
		}
		key := h.t.Unix()
		if seen[key] {
			continue
		}
		seen[key] = true
		times = append(times, h.t)
	}
	sort.Slice(times, func(i, j int) bool { return times[i].Before(times[j]) })
	if limit > 0 && len(times) > limit {
		times = times[:limit]
	}

	out := make([]Arrival, 0, len(times))
	for _, t := range times {
		out = append(out, Arrival{
			RouteID:   routeID,
			StopID:    chosenStop.ID,
			StopName:  chosenStop.Name,
			StopCode:  chosenStop.Code,
			DistanceM: chosenStop.DistanceM,
			TimeText:  t.Format("03:04 PM"),
			Minutes:   minutesUntil(nowLocal, t),
		})
	}
	return out
}

func nearbyVehicles(feed *gtfs.FeedMessage, lat, lon, radiusM float64, limit int) []LiveVehicle {
	out := make([]LiveVehicle, 0, 32)
	for _, entity := range feed.Entity {
		v := entity.Vehicle
		if v == nil || v.Position == nil || v.Position.Latitude == nil || v.Position.Longitude == nil {
			continue
		}
		vLat := float64(*v.Position.Latitude)
		vLon := float64(*v.Position.Longitude)
		d := haversineMeters(lat, lon, vLat, vLon)
		if d > radiusM {
			continue
		}

		routeID := ""
		if v.Trip != nil && v.Trip.RouteId != nil {
			routeID = *v.Trip.RouteId
		}
		vehicleID := ""
		if v.Vehicle != nil && v.Vehicle.Id != nil {
			vehicleID = *v.Vehicle.Id
		} else if entity.Id != nil {
			vehicleID = *entity.Id
		}

		lv := LiveVehicle{
			RouteID:   routeID,
			VehicleID: vehicleID,
			Lat:       vLat,
			Lon:       vLon,
			DistanceM: d,
		}
		if v.Position.Bearing != nil {
			lv.Bearing = float64(*v.Position.Bearing)
		}
		if v.Position.Speed != nil {
			lv.SpeedKmh = float64(*v.Position.Speed) * 3.6
		}
		if v.Timestamp != nil {
			lv.Updated = time.Unix(int64(*v.Timestamp), 0).In(ottawaLoc).Format("03:04:05 PM")
		}
		out = append(out, lv)
	}

	sort.Slice(out, func(i, j int) bool { return out[i].DistanceM < out[j].DistanceM })
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out
}

func minutesUntil(now, t time.Time) int {
	m := int(t.Sub(now).Seconds() / 60)
	if m < 0 {
		return 0
	}
	return m
}

func speakNearby(routes []NearbyRoute, radiusM float64) string {
	if len(routes) == 0 {
		return fmt.Sprintf("I could not find any buses arriving within %.0f metres of your location right now.", radiusM)
	}
	parts := make([]string, 0, len(routes))
	for _, r := range routes {
		parts = append(parts, fmt.Sprintf(
			"route %s at %s, next in %s",
			r.RouteID, speakStopName(r.StopName), speakMinutes(r.Minutes),
		))
	}
	return fmt.Sprintf("Nearby buses: %s. Which bus number should I check?", joinSpeech(parts))
}

func speakArrivals(routeID string, arrivals []Arrival) string {
	if len(arrivals) == 0 {
		return fmt.Sprintf("I could not find upcoming arrivals for route %s near you.", routeID)
	}
	a0 := arrivals[0]
	msg := fmt.Sprintf(
		"Route %s at %s: arriving in %s at %s",
		routeID, speakStopName(a0.StopName), speakMinutes(a0.Minutes), a0.TimeText,
	)
	if len(arrivals) > 1 {
		msg += fmt.Sprintf(", then in %s at %s", speakMinutes(arrivals[1].Minutes), arrivals[1].TimeText)
	}
	return msg + "."
}

func speakMinutes(m int) string {
	if m <= 0 {
		return "less than a minute"
	}
	if m == 1 {
		return "1 minute"
	}
	return fmt.Sprintf("%d minutes", m)
}

func speakStopName(name string) string {
	if name == "" {
		return "the stop"
	}
	return name
}

func joinSpeech(parts []string) string {
	switch len(parts) {
	case 0:
		return ""
	case 1:
		return parts[0]
	case 2:
		return parts[0] + ", and " + parts[1]
	default:
		out := parts[0]
		for i := 1; i < len(parts); i++ {
			if i == len(parts)-1 {
				out += ", and " + parts[i]
			} else {
				out += ", " + parts[i]
			}
		}
		return out
	}
}
