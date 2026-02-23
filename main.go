package main

import (
	"fmt"
	"html/template"
	"io"
	"log"
	"net/http"
	"os"
	"sort"
	"strconv"
	"time"

	gtfs "github.com/MobilityData/gtfs-realtime-bindings/golang/gtfs"
	"github.com/joho/godotenv"
	"google.golang.org/protobuf/proto"
)

// === CONFIGURATION ===
const (
	DefaultStopID    = 1095
	DefaultBusNumber = "68"

	OCTranspoURL = "https://nextrip-public-api.azure-api.net/octranspo/gtfs-rt-tp/beta/v1/TripUpdates"
	TimeZoneName = "America/Toronto"
)

type BusView struct {
	Time    string
	Minutes int
}

type BusPageData struct {
	Error     string
	Buses     []BusView
	BusNumber string
	StopID    int
}

var (
	tpl       *template.Template
	ottawaLoc *time.Location
)

func main() {
	// Load .env if it exists (no crash if missing)
	_ = godotenv.Load()

	var err error
	ottawaLoc, err = time.LoadLocation(TimeZoneName)
	if err != nil {
		log.Fatalf("failed to load timezone %q: %v", TimeZoneName, err)
	}

	tpl = template.Must(template.ParseFiles(
		"templates/interface.html",
		"templates/bus.html",
	))

	http.HandleFunc("/", homeHandler)
	http.HandleFunc("/next_bus", nextBusHandler)

	addr := ":8080"
	log.Printf("Server running on http://localhost%s", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}

func homeHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	_ = tpl.ExecuteTemplate(w, "interface.html", nil)
}

func nextBusHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	// Query params like Flask:
	// /next_bus?bus=68&stop=1095
	busNumber := r.URL.Query().Get("bus")
	if busNumber == "" {
		busNumber = DefaultBusNumber
	}

	stopID := DefaultStopID
	if stopStr := r.URL.Query().Get("stop"); stopStr != "" {
		if v, err := strconv.Atoi(stopStr); err == nil {
			stopID = v
		}
	}

	data := BusPageData{
		BusNumber: busNumber,
		StopID:    stopID,
	}

	subKey := os.Getenv("OCTRANSPO_SUBSCRIPTION_KEY")
	if subKey == "" {
		data.Error = "missing OCTRANSPO_SUBSCRIPTION_KEY (set it in .env or export it)"
		renderBusPage(w, data)
		return
	}

	req, err := http.NewRequest(http.MethodGet, OCTranspoURL, nil)
	if err != nil {
		data.Error = err.Error()
		renderBusPage(w, data)
		return
	}
	req.Header.Set("Ocp-Apim-Subscription-Key", subKey)
	req.Header.Set("Cache-Control", "no-cache")

	client := &http.Client{Timeout: 15 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		data.Error = err.Error()
		renderBusPage(w, data)
		return
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data.Error = fmt.Sprintf("OC Transpo API returned %s", resp.Status)
		renderBusPage(w, data)
		return
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		data.Error = err.Error()
		renderBusPage(w, data)
		return
	}

	feed := &gtfs.FeedMessage{}
	if err := proto.Unmarshal(body, feed); err != nil {
		data.Error = "failed to parse GTFS-RT protobuf: " + err.Error()
		renderBusPage(w, data)
		return
	}

	nowLocal := time.Now().In(ottawaLoc)
	arrivals := make([]time.Time, 0, 8)

	// Same logic as Python:
	// - filter route_id == busNumber
	// - find stop_id == stopID
	// - collect future arrival times
	for _, entity := range feed.Entity {
		tu := entity.TripUpdate
		if tu == nil || tu.Trip == nil || tu.Trip.RouteId == nil {
			continue
		}
		if *tu.Trip.RouteId != busNumber {
			continue
		}

		for _, stu := range tu.StopTimeUpdate {
			if stu.StopId == nil || stu.Arrival == nil || stu.Arrival.Time == nil {
				continue
			}

			sid, err := strconv.Atoi(*stu.StopId)
			if err != nil || sid != stopID {
				continue
			}

			arrivalLocal := time.Unix(*stu.Arrival.Time, 0).UTC().In(ottawaLoc)
			if !arrivalLocal.Before(nowLocal) {
				arrivals = append(arrivals, arrivalLocal)
			}
		}
	}

	sort.Slice(arrivals, func(i, j int) bool { return arrivals[i].Before(arrivals[j]) })

	// Next 2 buses
	if len(arrivals) > 2 {
		arrivals = arrivals[:2]
	}

	for _, a := range arrivals {
		minutes := int(a.Sub(nowLocal).Seconds() / 60)
		data.Buses = append(data.Buses, BusView{
			Time:    a.Format("03:04 PM"),
			Minutes: minutes,
		})
	}

	renderBusPage(w, data)
}

func renderBusPage(w http.ResponseWriter, data BusPageData) {
	_ = tpl.ExecuteTemplate(w, "bus.html", data)
}
