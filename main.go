package main

import (
	"html/template"
	"log"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/joho/godotenv"
)

const (
	DefaultStopID    = 1095
	DefaultBusNumber = "68"
	TimeZoneName     = "America/Toronto"
)

// Backward-compatible alias used by older next_bus flow.
const OCTranspoURL = TripUpdatesURL

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

	go func() {
		if err := ensureStopsLoaded(); err != nil {
			log.Printf("warning: could not preload stops: %v", err)
		}
	}()

	http.HandleFunc("/", homeHandler)
	http.HandleFunc("/next_bus", nextBusHandler)
	http.HandleFunc("/api/nearby", apiNearbyHandler)
	http.HandleFunc("/api/bus", apiBusHandler)
	http.HandleFunc("/api/vehicles", apiVehiclesHandler)
	http.HandleFunc("/siri/nearby", siriNearbyHandler)
	http.HandleFunc("/siri/bus", siriBusHandler)

	addr := ":8080"
	log.Printf("Server running on http://localhost%s", addr)
	if os.Getenv("HOME_LAT") != "" && os.Getenv("HOME_LON") != "" {
		log.Printf("Home location configured for Siri/HomePod")
	}
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

	data := BusPageData{BusNumber: busNumber, StopID: stopID}
	feed, err := fetchTripUpdates()
	if err != nil {
		data.Error = err.Error()
		renderBusPage(w, data)
		return
	}
	for _, a := range arrivalsForStopRoute(feed, busNumber, stopID, DefaultArrivalN) {
		data.Buses = append(data.Buses, BusView{Time: a.TimeText, Minutes: a.Minutes})
	}
	renderBusPage(w, data)
}

func renderBusPage(w http.ResponseWriter, data BusPageData) {
	_ = tpl.ExecuteTemplate(w, "bus.html", data)
}
